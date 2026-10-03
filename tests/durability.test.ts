import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableBinding, executionContextKey } from "../src/bridge/durable-binding.js";
import { SqliteBindingStore } from "../src/bridge/sqlite-store.js";
import { parseApplicationConfig } from "../src/config.js";
import { Cause, Effect, Exit, Scope } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { createA2AClient } from "../src/client/index.js";
import { startApplicationServer } from "../src/server.js";
import { TaskState } from "@a2a-js/sdk";
import { Message, Task } from "@a2a-js/sdk";
import { RequestContext, ServerCallContext } from "@a2a-js/sdk/server";

test("state directories are assigned per binding and identity cannot cross backend or agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-"));
  try {
    const config = parseApplicationConfig({ publicUrl: "http://127.0.0.1", stateDirectory: root, connections: {
      one: { type: "local" }, two: { type: "remote", url: "ws://127.0.0.1:1" },
    }, bindings: {
      a: { path: "/a", connection: "one", agentId: "same-agent" },
      b: { path: "/b", connection: "two", agentId: "same-agent" },
    } });
    expect(config.bindings[0]?.stateDirectory).not.toBe(config.bindings[1]?.stateDirectory);
    const a = await DurableBinding.open({ directory: config.bindings[0]!.stateDirectory!, bindingId: "a" });
    a.bindAgent("same-agent", "local:one");
    await expect(DurableBinding.open({ directory: config.bindings[0]!.stateDirectory!, bindingId: "b" })).rejects.toThrow();
    await a.close();
    const reopened = await DurableBinding.open({ directory: config.bindings[0]!.stateDirectory!, bindingId: "a" });
    expect(() => reopened.bindAgent("same-agent", "remote:two")).toThrow("identity mismatch");
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upgrading an existing durable profile preserves its original agent identity guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-legacy-"));
  let binding: DurableBinding | undefined;
  try {
    const legacy = await SqliteBindingStore.open({ directory: root, bindingId: "legacy" });
    legacy.setRecord("meta", "agentId", "original-agent");
    legacy.close();
    binding = await DurableBinding.open({ directory: root, bindingId: "legacy" });
    expect(() => binding!.bindAgent("different-agent", "local")).toThrow("identity mismatch");
    binding.bindAgent("original-agent", "local");
    await binding.close();
    binding = await DurableBinding.open({ directory: root, bindingId: "legacy" });
    expect(() => binding!.bindAgent("original-agent", "remote")).toThrow("identity mismatch");
  } finally {
    await binding?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable identity mismatch is a typed startup failure and closes acquired resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-startup-mismatch-"));
  const existing = await DurableBinding.open({ directory: root, bindingId: "default" });
  existing.bindAgent("original-agent", JSON.stringify(["local", "local", null]));
  await existing.close();
  let clientClosed = false;
  const client = { agents: { async retrieve(id: string) { return { id }; } }, async close() { clientClosed = true; } } as unknown as LettaAgentClient;
  const config = parseApplicationConfig({ agentId: "different-agent", backend: { type: "local" }, stateDirectory: root,
    port: 0, publicUrl: "http://127.0.0.1:0" });
  try {
    const exit = await Effect.runPromiseExit(Effect.scoped(startApplicationServer(config, () => client)));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "StateIdentityError" });
    }
    expect(clientClosed).toBe(true);
    const reopened = await DurableBinding.open({ directory: root, bindingId: "default" });
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("application restart restores completed tasks and resumes the SDK conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-restart-"));
  let created = 0;
  let resumed = 0;
  const makeClient = () => ({
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: () => { created++; return session("durable-conversation"); },
    resumeSession: (id: string) => { resumed++; return session(id); },
    async close() {},
  }) as unknown as LettaAgentClient;
  const start = async (client: LettaAgentClient) => {
    const config = parseApplicationConfig({ agentId: "durable-agent", backend: { type: "local" }, stateDirectory: root, port: 0,
      publicUrl: "http://127.0.0.1:0" });
    const scope = await Effect.runPromise(Scope.make());
    const server = await Effect.runPromise(startApplicationServer(config, () => client).pipe(Effect.provideService(Scope.Scope, scope)));
    return { scope, url: server.bindings.default! };
  };
  const first = await start(makeClient());
  const caller = createA2AClient({ routes: { agent: first.url }, pollIntervalMs: 5 });
  let initial: Awaited<ReturnType<typeof caller.invoke>>;
  try {
    initial = await caller.invoke({ target: "agent", message: "first", localScope: "caller", signal: AbortSignal.timeout(5000) });
    expect("id" in initial).toBe(true);
    if (!("id" in initial)) throw new Error("Expected durable task response");
    expect(initial.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  } finally {
    caller.close();
    await Effect.runPromise(Scope.close(first.scope, Exit.void));
  }
  const second = await start(makeClient());
  const readback = createA2AClient({ routes: { agent: second.url }, pollIntervalMs: 5 });
  try {
    if (!("id" in initial!)) throw new Error("Expected durable task response");
    const task = await readback.task({ target: "agent", action: "get", taskId: initial.id,
      localScope: "readback", signal: AbortSignal.timeout(5000) });
    expect(task.id).toBe(initial.id);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const continued = await readback.invoke({ target: "agent", message: "continue", contextId: initial.contextId,
      localScope: "continue", signal: AbortSignal.timeout(5000) });
    expect(continued).toBeDefined();
    expect(created).toBe(1);
    expect(resumed).toBe(1);
  } finally {
    readback.close();
    await Effect.runPromise(Scope.close(second.scope, Exit.void));
    await rm(root, { recursive: true, force: true });
  }
});

test("restart marks sent interrupted work uncertain and refuses context replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-uncertain-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "uncertain-binding" });
    binding.bindAgent("uncertain-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "uncertain-message", role: "user", parts: [{ text: "send once" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "uncertain-task", "uncertain-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "artifact");
    await binding.dispatched(request);
    await binding.execution.beforeSend!({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "send once", signal: AbortSignal.timeout(1000), onAssistantText() {} }, { agentId: "uncertain-agent", conversationId: "uncertain-conversation", otid: message.messageId });
    await binding.execution.unresolved!({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "send once", signal: AbortSignal.timeout(1000), onAssistantText() {} });
    await binding.close();
    const reopened = await DurableBinding.open({ directory: root, bindingId: "uncertain-binding" });
    expect(reopened.inspectRecovery()).toHaveLength(1);
    expect(() => reopened.assertAvailable(contextKey)).toThrow("reconciliation");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function session(conversationId: string) {
  return {
    async ready() { return { conversationId }; },
    async send() {}, async abort() {},
    async *stream() { yield { type: "result", success: true, result: "complete answer", durationMs: 1, conversationId }; },
    async [Symbol.asyncDispose]() {},
  };
}
