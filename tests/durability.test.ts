import { expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DurableBinding, executionContextKey } from "../src/bridge/durable-binding.js";
import { SqliteBindingStore } from "../src/bridge/sqlite-store.js";
import { parseApplicationConfig } from "../src/config.js";
import { Cause, Effect, Exit, Scope } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { testClient, sendRequest } from "./helpers/a2a-client.js";
import { startApplicationServer } from "../src/server.js";
import { TaskState } from "@a2a-js/sdk";
import { Message, Task } from "@a2a-js/sdk";
import { RequestContext, ServerCallContext } from "@a2a-js/sdk/server";
import { AgentSdkTurnRunner } from "../src/bridge/letta-agent.js";

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

test("an agent-ID-only durable record preserves its identity when binding a backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-agent-id-"));
  let binding: DurableBinding | undefined;
  try {
    const stored = await SqliteBindingStore.open({ directory: root, bindingId: "agent-id-only" });
    stored.setRecord("meta", "agentId", "original-agent");
    stored.close();
    binding = await DurableBinding.open({ directory: root, bindingId: "agent-id-only" });
    expect(() => binding!.bindAgent("different-agent", "local")).toThrow("identity mismatch");
    binding.bindAgent("original-agent", "local");
    await binding.close();
    binding = await DurableBinding.open({ directory: root, bindingId: "agent-id-only" });
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
  const caller = await testClient(first.url);
  let initial: Task;
  try {
    const response = await caller.sendMessage(sendRequest("first"));
    expect("id" in response).toBe(true);
    if (!("id" in response)) throw new Error("Expected durable task response");
    initial = response;
    expect(initial.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(await readdir(root)).not.toContain("outbound-context.json");
  } finally {
    await Effect.runPromise(Scope.close(first.scope, Exit.void));
  }
  // Existing outbound state is not ours to interpret, rewrite, or remove.
  const unusedState = "untouched existing user state\n";
  await writeFile(join(root, "outbound-context.json"), unusedState);
  const second = await start(makeClient());
  const readback = await testClient(second.url);
  try {
    const task = await readback.getTask({ id: initial.id, tenant: "", historyLength: 0 });
    expect(task.id).toBe(initial.id);
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const continued = await readback.sendMessage(sendRequest("continue", initial.contextId));
    expect("status" in continued && continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(continued.contextId).toBe(initial.contextId);
    expect(created).toBe(1);
    expect(resumed).toBe(1);
  } finally {
    await Effect.runPromise(Scope.close(second.scope, Exit.void));
    expect(await readFile(join(root, "outbound-context.json"), "utf8")).toBe(unusedState);
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

test("restart never publishes provisional text from an unresolved turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-provisional-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "provisional-binding" });
    binding.bindAgent("provisional-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "provisional-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "provisional-task", "provisional-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "provisional-artifact");
    await binding.dispatched(request);
    const turn = { taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} };
    await binding.execution.beforeSend!(turn, { agentId: "provisional-agent", conversationId: "provisional-conversation", otid: message.messageId });
    await binding.execution.observe!(turn, { type: "assistant", content: "PRIVATE provisional answer", uuid: "delta" });
    await binding.execution.observe!(turn, { type: "result", success: false, result: "PRIVATE full result", durationMs: 1, conversationId: "provisional-conversation", stopReason: "interrupted" });
    await binding.execution.unresolved!(turn);
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "provisional-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(recovered?.artifacts ?? []).toHaveLength(0);
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK observations use keyed correlation and ignore irrelevant payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-observe-work-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "observe-work" });
    const context = new ServerCallContext();
    const records = binding["storage"].records.bind(binding["storage"]);
    const load = binding["storage"].load.bind(binding["storage"]);
    const getRecord = binding["storage"].getRecord.bind(binding["storage"]);
    let executionScans = 0;
    let executionReads = 0;
    let executionWrites = 0;
    let taskLoads = 0;
    binding["storage"].records = ((collection: string) => {
      if (collection === "executions") executionScans++;
      return records(collection);
    }) as typeof binding["storage"]["records"];
    binding["storage"].getRecord = ((collection: string, key: string) => {
      if (collection === "executions") executionReads++;
      return getRecord(collection, key);
    }) as typeof binding["storage"]["getRecord"];
    binding["storage"].load = (async (...args: Parameters<typeof binding["storage"]["load"]>) => {
      taskLoads++;
      return load(...args);
    }) as typeof binding["storage"]["load"];
    const setRecord = binding["storage"]["setRecord"].bind(binding["storage"]);
    binding["storage"].setRecord = ((collection: string, key: string, value: unknown) => {
      if (collection === "executions") executionWrites++;
      return setRecord(collection, key, value);
    }) as typeof binding["storage"]["setRecord"];

    for (let i = 0; i < 100; i++) {
      const message = Message.fromJSON({ messageId: `noise-${i}`, role: "user", parts: [{ text: "hi" }] });
      const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, `task-${i}`, `context-${i}`, context);
      const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
      await binding.accept(request, initial, `artifact-${i}`);
    }
    const message = Message.fromJSON({ messageId: "observed-message", role: "user", parts: [{ text: "hi" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "observed-task", "observed-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "observed-artifact");
    const turn = { taskId: request.taskId, a2aContextId: executionContextKey(request), messageId: message.messageId, text: "hi", signal: AbortSignal.timeout(1000), onAssistantText() {} };
    const executionKey = JSON.stringify([JSON.parse(turn.a2aContextId)[0], JSON.parse(turn.a2aContextId)[1], message.messageId]);
    executionScans = 0;
    executionReads = 0;
    taskLoads = 0;
    const before = executionWrites;
    for (let i = 0; i < 4; i++) {
      await binding.execution.observe!(turn, { type: "loop_status", activeRunIds: [], status: "running" });
      await binding.execution.observe!(turn, { type: "assistant", content: `PRIVATE assistant ${i}`, uuid: `assistant-${i}` });
      await binding.execution.observe!(turn, { type: "result", success: true, result: `PRIVATE result ${i}`, durationMs: 1, conversationId: "conversation", stopReason: "end_turn", runIds: [] });
    }
    await binding.execution.observe!(turn, { type: "loop_status", activeRunIds: ["run-new"], status: "running" });
    const afterNewRun = executionWrites;
    await binding.execution.observe!(turn, { type: "loop_status", activeRunIds: ["run-new"], status: "running" });

    expect(executionScans).toBe(0);
    expect(executionReads).toBe(14);
    expect(taskLoads).toBe(0);
    expect(executionWrites).toBe(before + 1);
    expect(executionWrites).toBe(afterNewRun);
    const persisted = getRecord<{ runIds: string[]; publicChunks: string[]; resultText?: string }>("executions", executionKey);
    expect(persisted?.runIds).toEqual(["run-new"]);
    expect(persisted?.publicChunks).toEqual([]);
    expect(persisted?.resultText).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("PRIVATE");
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "observe-work" });
    const retained = reopened["storage"].getRecord<{ runIds: string[] }>("executions", executionKey);
    expect(retained?.runIds).toEqual(["run-new"]);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK turn correlation fails closed for mismatched and malformed keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-correlation-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "correlation" });
    const context = new ServerCallContext({ user: { isAuthenticated: true, userName: "owner-a" }, tenant: "tenant-a" });
    const message = Message.fromJSON({ messageId: "correlation-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "tenant-a", configuration: undefined, metadata: undefined, message }, "correlation-task", "correlation-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "correlation-artifact");
    const key = executionContextKey(request);
    const turn = { taskId: request.taskId, a2aContextId: key, messageId: message.messageId, text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} };
    await binding.execution.observe!(turn, { type: "loop_status", activeRunIds: [], status: "running" });
    const { taskId: _taskId, ...withoutTaskId } = turn;
    await expect(binding.execution.observe!(withoutTaskId, { type: "loop_status", activeRunIds: [], status: "running" })).resolves.toBeUndefined();
    for (const invalid of [
      JSON.stringify(["owner-b", "tenant-a", request.contextId]),
      JSON.stringify(["owner-a", "tenant-b", request.contextId]),
      JSON.stringify(["owner-a", "tenant-a", "other-context"]),
      "not-json",
      JSON.stringify(["owner-a", "tenant-a"]),
      JSON.stringify(["owner-a", "tenant-a", 123]),
    ]) {
      await expect(binding.execution.observe!({ ...turn, a2aContextId: invalid }, { type: "loop_status", activeRunIds: [], status: "running" })).rejects.toThrow("Missing durable turn correlation");
    }
    await expect(binding.execution.observe!({ ...turn, taskId: "other-task" }, { type: "loop_status", activeRunIds: [], status: "running" })).rejects.toThrow("Missing durable turn correlation");
    await binding.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized settled answers and run IDs remain bounded without provisional journaling", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-budget-"));
  const binding = await DurableBinding.open({ directory: root, bindingId: "budget", maxRecordBytes: 1024 });
  try {
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "budget-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "budget-task", "budget-context", context);
    await binding.accept(request, Task.fromJSON({ id: request.taskId, contextId: request.contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] }), "budget-artifact");
    await binding.dispatched(request);
    const turn = { taskId: request.taskId, a2aContextId: executionContextKey(request), messageId: message.messageId,
      text: "hello", signal: new AbortController().signal, onAssistantText() {} };
    await binding.execution.beforeSend!(turn, { agentId: "budget-agent", conversationId: "budget-conversation", otid: message.messageId });
    const oversized = "PRIVATE".repeat(1024);
    await expect(binding.execution.observe!(turn, { type: "assistant", content: oversized, uuid: "answer" })).resolves.toBeUndefined();
    await expect(binding.execution.observe!(turn, { type: "loop_status", activeRunIds: [oversized], status: "running" })).rejects.toThrow("Durable record size limit reached");
    await expect(binding.execution.stopped!(turn, oversized)).rejects.toThrow("Durable record size limit reached");
    await binding.execution.unresolved!(turn);
    await binding.close();
    const reopened = await DurableBinding.open({ directory: root, bindingId: "budget", maxRecordBytes: 1024 });
    try {
      const recovered = await reopened.taskStore.load(request.taskId, context);
      expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(recovered?.artifacts ?? []).toHaveLength(0);
      expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
      await expect(reopened.taskStore.save(Task.fromJSON({ id: request.taskId, contextId: request.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [{ artifactId: "oversized", parts: [{ text: oversized }] }] }), context))
        .rejects.toThrow("Durable record size limit reached");
    } finally { await reopened.close(); }
  } finally {
    await binding.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runner cancellation during owned cleanup recovers without an answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-cleanup-cancel-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "cleanup-cancel-binding" });
    binding.bindAgent("cleanup-cancel-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "cleanup-cancel-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "cleanup-cancel-task", "cleanup-cancel-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "cleanup-cancel-artifact");
    await binding.dispatched(request);
    let releaseCleanup!: () => void;
    let cleanupEntered!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { cleanupEntered = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const session = {
      async ready() { return { conversationId: "cleanup-cancel-conversation" }; },
      async send() {}, async abort() {},
      async *stream() {
        yield { type: "assistant", content: "PRIVATE provisional", uuid: "answer" };
        yield { type: "result", success: true, result: "PRIVATE provisional", durationMs: 1, conversationId: "cleanup-cancel-conversation", stopReason: "end_turn" };
      },
      async [Symbol.asyncDispose]() {},
    };
    const runner = new AgentSdkTurnRunner({ createSession: () => session, resumeSession: () => session } as unknown as LettaAgentClient,
      "cleanup-cancel-agent", { sharingDomain: "test", execution: binding.execution,
        sessionOptions: () => ({ options: {}, async close() { cleanupEntered(); await cleanupGate; } }) });
    const controller = new AbortController();
    const running = runner.runTurn({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: controller.signal, onAssistantText() {} });
    await cleanupStarted;
    controller.abort();
    releaseCleanup();
    await expect(running).rejects.toThrow("cancelled");
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "cleanup-cancel-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(recovered?.artifacts ?? []).toHaveLength(0);
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner and SQLite recovery share the filtered final answer boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-final-answer-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "final-answer-binding", maxRecordBytes: 1024 });
    binding.bindAgent("final-answer-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "final-answer-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "final-answer-task", "final-answer-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "final-answer-artifact");
    await binding.dispatched(request);
    let cleaned = false;
    const session = {
      async ready() { return { conversationId: "final-answer-conversation" }; },
      async send() {}, async abort() {},
      async *stream() {
        yield { type: "assistant", content: "PRIVATE pre-tool commentary", uuid: "commentary" };
        yield { type: "tool_call", toolCallId: "tool", toolName: "lookup", toolInput: {}, uuid: "tool" };
        yield { type: "assistant", content: "Final ", uuid: "final" };
        yield { type: "assistant", content: "answer", uuid: "final" };
        yield { type: "result", success: true, result: "PRIVATE pre-tool commentaryFinal answer", durationMs: 1, conversationId: "final-answer-conversation", stopReason: "end_turn" };
      },
      async [Symbol.asyncDispose]() {},
    };
    const runner = new AgentSdkTurnRunner({ createSession: () => session, resumeSession: () => session } as unknown as LettaAgentClient,
      "final-answer-agent", { sharingDomain: "test", execution: binding.execution,
        sessionOptions: () => ({ options: {}, close() { cleaned = true; } }) });
    await runner.runTurn({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} });
    const executionKey = JSON.stringify([JSON.parse(contextKey)[0], JSON.parse(contextKey)[1], message.messageId]);
    const stopped = binding["storage"].getRecord<{ eligibleAnswer?: string; publicChunks: string[]; resultText?: string }>("executions", executionKey);
    expect(stopped?.eligibleAnswer).toBe("Final answer");
    expect(stopped?.publicChunks).toEqual([]);
    expect(stopped?.resultText).toBeUndefined();
    expect(cleaned).toBe(true);
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "final-answer-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(JSON.stringify(recovered)).toContain("Final answer");
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    const publication = reopened["storage"].getRecord("publications", executionKey);
    expect(publication).toBeDefined();
    expect(JSON.stringify(publication)).toContain("Final answer");
    expect(JSON.stringify(publication)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("result-only runner success recovers the actual final result", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-result-only-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "result-only-binding" });
    binding.bindAgent("result-only-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "result-only-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "result-only-task", "result-only-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "result-only-artifact");
    await binding.dispatched(request);
    const session = {
      async ready() { return { conversationId: "result-only-conversation" }; },
      async send() {}, async abort() {},
      async *stream() { yield { type: "result", success: true, result: "Actual final result", durationMs: 1, conversationId: "result-only-conversation", stopReason: "end_turn" }; },
      async [Symbol.asyncDispose]() {},
    };
    const runner = new AgentSdkTurnRunner({ createSession: () => session, resumeSession: () => session } as unknown as LettaAgentClient,
      "result-only-agent", { sharingDomain: "test", execution: binding.execution, sessionOptions: () => ({ options: {} }) });
    await runner.runTurn({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} });
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "result-only-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(JSON.stringify(recovered)).toContain("Actual final result");
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["result", "cleanup"] as const)("runner %s failure stays answer-free after SQLite reopen", async (failure) => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-cleanup-failure-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "cleanup-failure-binding" });
    binding.bindAgent("cleanup-failure-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "cleanup-failure-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "cleanup-failure-task", "cleanup-failure-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "cleanup-failure-artifact");
    await binding.dispatched(request);
    const session = {
      async ready() { return { conversationId: "cleanup-failure-conversation" }; },
      async send() {}, async abort() {},
      async *stream() {
        yield { type: "assistant", content: "PRIVATE provisional", uuid: "answer" };
        yield { type: "result", success: failure !== "result", result: "PRIVATE result", durationMs: 1, conversationId: "cleanup-failure-conversation", stopReason: "end_turn" };
      },
      async [Symbol.asyncDispose]() {},
    };
    const runner = new AgentSdkTurnRunner({ createSession: () => session, resumeSession: () => session } as unknown as LettaAgentClient,
      "cleanup-failure-agent", { sharingDomain: "test", execution: binding.execution,
        sessionOptions: () => ({ options: {}, close() { if (failure === "cleanup") throw new Error("cleanup failed"); } }) });
    await expect(runner.runTurn({ taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} })).rejects.toThrow(failure === "cleanup" ? "cleanup failed" : "requires reconciliation");
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "cleanup-failure-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(recovered?.artifacts ?? []).toHaveLength(0);
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancellation after stop prevents completed answer recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-stopped-cancel-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "stopped-cancel-binding" });
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "stopped-cancel-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "stopped-cancel-task", "stopped-cancel-context", context);
    const contextKey = executionContextKey(request);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "stopped-cancel-artifact");
    await binding.dispatched(request);
    const turn = { taskId: request.taskId, a2aContextId: contextKey, messageId: message.messageId,
      text: "hello", signal: AbortSignal.timeout(1000), onAssistantText() {} };
    await binding.execution.beforeSend!(turn, { agentId: "agent", conversationId: "conversation", otid: message.messageId });
    await binding.execution.stopped!(turn, "PRIVATE eligible answer");
    await binding.requestCancellation(request.taskId, context);
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "stopped-cancel-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(recovered?.artifacts ?? []).toHaveLength(0);
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stored provisional observations stay private while saved publication survives recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-stored-publication-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "stored-publication-binding" });
    binding.bindAgent("stored-publication-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "stored-publication-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "stored-publication-task", "stored-publication-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "stored-publication-artifact");
    await binding.close();
    const store = await SqliteBindingStore.open({ directory: root, bindingId: "stored-publication-binding" });
    const [key, record] = store.records<Record<string, unknown>>("executions")[0]!;
    Object.assign(record, { phase: "publishing", stopped: true, publicChunks: ["PRIVATE provisional delta"], resultText: "PRIVATE unfiltered result", publication: true });
    store.setRecord("executions", key, record);
    store.setRecord("publications", key, Task.toJSON(Task.fromJSON({ id: request.taskId, contextId: request.contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [{ artifactId: "saved-answer", parts: [{ text: "Legitimately published answer" }] }], history: [message] })));
    store.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "stored-publication-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(JSON.stringify(recovered)).toContain("Legitimately published answer");
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stored stopped observations without a saved publication stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-stored-stopped-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "stored-stopped-binding" });
    binding.bindAgent("stored-stopped-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "stored-stopped-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "stored-stopped-task", "stored-stopped-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "stored-stopped-artifact");
    await binding.close();

    const store = await SqliteBindingStore.open({ directory: root, bindingId: "stored-stopped-binding" });
    const [key, record] = store.records<Record<string, unknown>>("executions")[0]!;
    Object.assign(record, { phase: "stopped", stopped: true, publicChunks: ["PRIVATE provisional delta"], resultText: "PRIVATE unfiltered result" });
    store.setRecord("executions", key, record);
    store.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "stored-stopped-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(recovered?.artifacts ?? []).toHaveLength(0);
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
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
