import { expect, test } from "bun:test";
import type { LettaAgentClient, SDKMessage } from "@letta-ai/letta-agent-sdk";
import { Message, TaskState } from "@a2a-js/sdk";
import { DefaultExecutionEventBus, RequestContext, ServerCallContext, type AgentExecutionEvent } from "@a2a-js/sdk/server";
import { AgentSdkTurnRunner, LettaTurnCancelledError, type LettaTurnRunner } from "../src/bridge/letta-agent.js";
import { LettaAgentExecutor } from "../src/bridge/letta-agent-executor.js";
import { readText } from "../src/bridge/a2a-text.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
const assistant = (content: string, uuid = "answer"): SDKMessage => ({ type: "assistant", content, uuid });
const result = (success = true): SDKMessage => ({ type: "result", success, result: "commentaryFull answer", durationMs: 1, conversationId: "conversation", stopReason: success ? "end_turn" : "interrupted" });
function sdkRunner(messages: SDKMessage[], gate = deferred(), cleanupFails = false) {
  const entered = deferred();
  const session = {
    async ready() { return { conversationId: "conversation" }; },
    async send() {}, async abort() {},
    async *stream() {
      for (const message of messages) yield message;
      entered.resolve();
      await gate.promise;
      yield result();
    },
    async [Symbol.asyncDispose]() {},
  };
  const client = { createSession: () => session, resumeSession: () => session } as unknown as LettaAgentClient;
  const runner = new AgentSdkTurnRunner(client, "agent", {
    sharingDomain: "test", sessionOptions: () => ({ options: {}, close() { if (cleanupFails) throw new Error("PRIVATE cleanup"); } }),
  });
  return { runner, entered, gate };
}
function execution(runner: LettaTurnRunner) {
  const executor = new LettaAgentExecutor(runner);
  const bus = new DefaultExecutionEventBus();
  const events: AgentExecutionEvent[] = [];
  bus.on("event", (event) => events.push(event));
  const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message: Message.fromJSON({ messageId: "message", role: "user", parts: [{ text: "hello" }] }) }, "task", "context", new ServerCallContext());
  const running = executor.execute(request, bus);
  return { executor, bus, events, running };
}
const artifacts = (events: AgentExecutionEvent[]) => events.flatMap(e => e.kind === "artifactUpdate" ? [e.data] : []);
const statuses = (events: AgentExecutionEvent[]) => events.flatMap(e => e.kind === "statusUpdate" && e.data.status?.message ? [readText(e.data.status.message)] : []);

test("mocked SDK activity precedes exactly one complete final artifact without private content or token spam", async () => {
  const f = sdkRunner([
    { type: "reasoning", content: "PRIVATE reasoning", uuid: "r" },
    { type: "reasoning", content: "PRIVATE token", uuid: "r" },
    assistant("commentary", "commentary"),
    { type: "tool_call", toolCallId: "tool", toolName: "lookup", toolInput: { secret: "PRIVATE args" }, rawArguments: "PRIVATE raw", uuid: "t" },
    { type: "tool_call", toolCallId: "tool", toolName: "lookup", toolInput: {}, uuid: "t" },
    { type: "tool_result", toolCallId: "tool", content: "PRIVATE error", isError: true, uuid: "t" },
    { type: "stream_event", uuid: "nested", event: { message_type: "reasoning_message", reasoning: "PRIVATE nested" } },
    assistant("Full "), assistant("answer"),
  ]);
  const x = execution(f.runner);
  await f.entered.promise;
  try {
    expect(artifacts(x.events)).toHaveLength(0);
    expect(statuses(x.events)).toEqual(["Thinking", "Generating response", "Tool requested: lookup", "Tool finished", "Generating response"]);
  } finally { f.gate.resolve(); await x.running; }
  const output = artifacts(x.events);
  expect(output).toHaveLength(1);
  expect(output[0]?.append).toBe(false);
  expect(output[0]?.lastChunk).toBe(true);
  expect(output[0]?.artifact?.parts.map(p => p.content?.value).join("")).toBe("Full answer");
  expect(x.events[0]?.kind).toBe("task");
  expect(x.events.at(-1)?.kind).toBe("statusUpdate");
  expect(JSON.stringify(x.events)).not.toContain("PRIVATE");
  expect(x.events.some(e => e.kind === "message")).toBe(false);
});

for (const outcome of ["failure", "cancel", "uncertain", "cleanup"] as const) {
  test(`no answer artifact after assistant activity on ${outcome}`, async () => {
    const f = sdkRunner([assistant("PRIVATE provisional")], deferred(), outcome === "cleanup");
    const runner: LettaTurnRunner = outcome === "cleanup" ? f.runner : {
      ...(outcome === "uncertain" ? { unresolvedContexts: [JSON.stringify(["", "", "context"])] } : {}),
      async runTurn(request) {
        request.onAssistantText("PRIVATE first");
        request.onAssistantText("PRIVATE second");
        if (outcome === "cancel") throw new LettaTurnCancelledError();
        if (outcome === "failure") throw new Error("PRIVATE error");
        return { text: "PRIVATE answer" };
      },
    };
    const x = execution(runner);
    f.gate.resolve();
    await x.running;
    expect(artifacts(x.events)).toHaveLength(0);
    expect(JSON.stringify(x.events)).not.toContain("PRIVATE");
  });
}
for (const state of ["input_required", "auth_required"] as const) {
  test(`${state} carries prompt as status, not answer`, async () => {
    const x = execution({ async runTurn(request) { request.onAssistantText("provisional"); return { state, text: "Please supply approval" }; } });
    await x.running;
    expect(artifacts(x.events)).toHaveLength(0);
    expect(statuses(x.events).at(-1)).toBe("Please supply approval");
    const last = x.events.at(-1);
    expect(last?.kind === "statusUpdate" && last.data.status?.state).toBe(state === "input_required" ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_AUTH_REQUIRED);
    expect(x.executor.canResume("task")).toBe(true);
  });
}


test("unsafe tool names, raw nested events, and SDK errors stay private", async () => {
  const f = sdkRunner([
    { type: "tool_call", toolCallId: "bad", toolName: "PRIVATE\n" + "x".repeat(80), toolInput: {}, uuid: "bad" },
    { type: "error", message: "PRIVATE error", errorDetail: "PRIVATE detail", stopReason: "error" },
    { type: "stream_event", uuid: "internal", event: { message_type: "assistant_message", content: "PRIVATE nested", parent_agent_id: "nested" } },
    assistant("old answer", "old"), assistant("Full ", "final"), assistant("answer", "final"),
  ]);
  const x = execution(f.runner);
  await f.entered.promise;
  expect(statuses(x.events)).toEqual(["Tool requested", "Generating response"]);
  f.gate.resolve();
  await x.running;
  expect(JSON.stringify(x.events)).not.toContain("PRIVATE");
  expect(artifacts(x.events)[0]?.artifact?.parts.map(p => p.content?.value).join("")).toBe("Full answer");
});

test("result-only transport publishes the complete result once", async () => {
  const f = sdkRunner([]);
  const x = execution(f.runner);
  f.gate.resolve();
  await x.running;
  expect(artifacts(x.events)).toHaveLength(1);
  expect(artifacts(x.events)[0]?.artifact?.parts.map(p => p.content?.value).join("")).toBe("commentaryFull answer");
});

import { createBridge } from "../src/bridge/bridge.js";
import { SendMessageRequest } from "@a2a-js/sdk";

test("official streaming, GetTask, and nonstream all retain the same complete answer", async () => {
  const runner: LettaTurnRunner = {
    async runTurn(request) {
      request.onActivity?.("Thinking");
      request.onAssistantText("provisional");
      return { text: "Full answer" };
    },
  };
  const bridge = createBridge({ runner, sharingDomain: "test", publicBaseUrl: "http://127.0.0.1:1234" });
  try {
    const context = new ServerCallContext();
    const request = SendMessageRequest.fromJSON({ message: { messageId: "stream", role: "user", parts: [{ text: "hi" }] } });
    const events = [];
    for await (const event of bridge.requestHandler.sendMessageStream(request, context)) events.push(event);
    const taskEvent = events.find(e => e.payload?.$case === "task");
    if (!taskEvent || taskEvent.payload?.$case !== "task") throw new Error("Missing initial task");
    const stored = await bridge.requestHandler.getTask({ id: taskEvent.payload.value.id, historyLength: undefined, tenant: "" }, context);
    const nonstream = await bridge.requestHandler.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "nonstream", role: "user", parts: [{ text: "hi" }] } }), context);
    const artifact = events.flatMap(e => e.payload?.$case === "artifactUpdate" ? [e.payload.value] : []);
    expect(artifact).toHaveLength(1);
    expect(stored.artifacts).toEqual(artifact.map(e => e.artifact!));
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    if (!("artifacts" in nonstream)) throw new Error("Expected task result");
    expect(nonstream.artifacts[0]?.parts).toEqual(stored.artifacts[0]?.parts);
    expect(nonstream.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  } finally { await bridge.close(); }
});

test("SDK synthesized per-event IDs do not truncate the final answer", async () => {
  const f = sdkRunner([assistant("Full ", "app-server-1"), assistant("answer", "app-server-2")]);
  const x = execution(f.runner);
  f.gate.resolve();
  await x.running;
  expect(artifacts(x.events)[0]?.artifact?.parts.map(p => p.content?.value).join("")).toBe("Full answer");
});
