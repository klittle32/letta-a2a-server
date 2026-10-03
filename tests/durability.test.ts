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
    const binding = await DurableBinding.open({ directory: root, bindingId: "final-answer-binding" });
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
    expect(cleaned).toBe(true);
    await binding.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "final-answer-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(recovered?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(JSON.stringify(recovered)).toContain("Final answer");
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
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

test("legacy stopped observations stay private while saved publication survives recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-legacy-publication-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "legacy-publication-binding" });
    binding.bindAgent("legacy-publication-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "legacy-publication-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "legacy-publication-task", "legacy-publication-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "legacy-publication-artifact");
    await binding.close();
    const store = await SqliteBindingStore.open({ directory: root, bindingId: "legacy-publication-binding" });
    const [key, record] = store.records<Record<string, unknown>>("executions")[0]!;
    Object.assign(record, { phase: "publishing", stopped: true, publicChunks: ["PRIVATE legacy delta"], resultText: "PRIVATE legacy result", publication: true });
    store.setRecord("executions", key, record);
    store.setRecord("publications", key, Task.toJSON(Task.fromJSON({ id: request.taskId, contextId: request.contextId,
      status: { state: TaskState.TASK_STATE_COMPLETED }, artifacts: [{ artifactId: "saved-answer", parts: [{ text: "Legitimately published answer" }] }], history: [message] })));
    store.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "legacy-publication-binding" });
    const recovered = await reopened.taskStore.load(request.taskId, context);
    expect(JSON.stringify(recovered)).toContain("Legitimately published answer");
    expect(JSON.stringify(recovered)).not.toContain("PRIVATE");
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy stopped observations without a saved publication stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-durable-legacy-stopped-"));
  try {
    const binding = await DurableBinding.open({ directory: root, bindingId: "legacy-stopped-binding" });
    binding.bindAgent("legacy-stopped-agent", "local");
    const context = new ServerCallContext();
    const message = Message.fromJSON({ messageId: "legacy-stopped-message", role: "user", parts: [{ text: "hello" }] });
    const request = new RequestContext({ tenant: "", configuration: undefined, metadata: undefined, message }, "legacy-stopped-task", "legacy-stopped-context", context);
    const initial = Task.fromJSON({ id: request.taskId, contextId: request.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED }, artifacts: [], history: [message] });
    await binding.accept(request, initial, "legacy-stopped-artifact");
    await binding.close();

    const store = await SqliteBindingStore.open({ directory: root, bindingId: "legacy-stopped-binding" });
    const [key, record] = store.records<Record<string, unknown>>("executions")[0]!;
    Object.assign(record, { phase: "stopped", stopped: true, publicChunks: ["PRIVATE old delta"], resultText: "PRIVATE old result" });
    store.setRecord("executions", key, record);
    store.close();

    const reopened = await DurableBinding.open({ directory: root, bindingId: "legacy-stopped-binding" });
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
