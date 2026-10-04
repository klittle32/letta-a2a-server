import { expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import type { LettaAgentClient, SDKMessage } from "@letta-ai/letta-agent-sdk";
import { CancelTaskRequest, GetTaskRequest, ListTasksRequest, SubscribeToTaskRequest, TaskState, SendMessageRequest, type Task } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { AgentSdkTurnRunner, LettaTurnCancelledError, type LettaTurnRequest } from "../src/bridge/letta-agent.js";
import { createBridge, listenLoopback } from "../src/bridge/bridge.js";
import { testClient } from "./helpers/a2a-client.js";
import { parseApplicationConfig } from "../src/config.js";
import { startApplicationServer } from "../src/server.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function request(text: string, contextId: string = crypto.randomUUID(), messageId: string = crypto.randomUUID()): SendMessageRequest {
  return SendMessageRequest.fromJSON({ message: { messageId, role: "user", parts: [{ text }], contextId },
    configuration: { blocking: true, returnImmediately: false } });
}
function turn(contextId: string, signal = new AbortController().signal): LettaTurnRequest {
  return { a2aContextId: contextId, messageId: crypto.randomUUID(), text: contextId, signal };
}
function completedMessage(conversationId: string, result: string): SDKMessage {
  return { type: "result", success: true, result, durationMs: 1, conversationId };
}
function task(value: unknown): asserts value is Task {
  expect(typeof value === "object" && value !== null && "status" in value).toBe(true);
}

test("same-context SDK turns serialize while independent contexts can run concurrently", async () => {
  const enteredFirst = deferred(), enteredOther = deferred(), releaseFirst = deferred();
  const opened: string[] = [];
  let sequence = 0;
  const open = (conversationId: string) => ({
    async ready() { return { conversationId }; },
    async send(text: string) {
      opened.push(text);
      if (opened.length === 1) enteredFirst.resolve();
      if (text === "other") enteredOther.resolve();
    },
    async abort() {},
    async *stream() {
      if (conversationId === "conversation-1") await releaseFirst.promise;
      yield completedMessage(conversationId, conversationId);
    },
    async [Symbol.asyncDispose]() {},
  });
  const client = {
    createSession: () => open(`conversation-${++sequence}`),
    resumeSession: (id: string) => open(id),
  } as unknown as LettaAgentClient;
  const runner = new AgentSdkTurnRunner(client, "existing", { sharingDomain: "queue", sessionOptions: {} });
  const first = runner.runTurn(turn("same"));
  await enteredFirst.promise;
  const queued = runner.runTurn(turn("same"));
  const other = runner.runTurn(turn("other"));
  try {
    await enteredOther.promise;
    expect(opened).toEqual(["same", "other"]);
    expect((await other).text).toBe("conversation-2");
  } finally { releaseFirst.resolve(); }
  expect((await first).text).toBe("conversation-1");
  expect((await queued).text).toBe("conversation-1");
  expect(opened).toEqual(["same", "other", "same"]);
});

test("one runner keeps identical wire context IDs separate for different trusted owners", async () => {
  let created = 0;
  const resumed: string[] = [];
  const open = (conversationId: string) => ({
    async ready() { return { conversationId }; },
    async send() {}, async abort() {},
    async *stream() { yield completedMessage(conversationId, conversationId); },
    async [Symbol.asyncDispose]() {},
  });
  const runner = new AgentSdkTurnRunner({
    createSession: () => open(`conversation-${++created}`),
    resumeSession: (id: string) => { resumed.push(id); return open(id); },
  } as unknown as LettaAgentClient, "same-agent", { sharingDomain: "owner-test", sessionOptions: {} });
  const context = (owner: string) => new ServerCallContext({ user: { isAuthenticated: true, userName: owner }, tenant: "same-tenant" });
  const bridge = createBridge({
    runner, sharingDomain: "owner-test", publicBaseUrl: "http://127.0.0.1:0",
    auth: {
      projectCaller: async (input) => ({ issuer: "test", subject: input.user?.userName ?? "", tenant: "same-tenant" }),
      authorize: async () => true,
    },
  });
  try {
    const alice = await bridge.requestHandler.sendMessage(request("hello", "shared-wire-context"), context("alice"));
    const bob = await bridge.requestHandler.sendMessage(request("hello", "shared-wire-context"), context("bob"));
    task(alice); task(bob);
    expect(alice.contextId).toBe(bob.contextId);
    expect(created).toBe(2);
    await bridge.requestHandler.sendMessage(request("again", "shared-wire-context"), context("alice"));
    await bridge.requestHandler.sendMessage(request("again", "shared-wire-context"), context("bob"));
    expect(resumed).toEqual(["conversation-1", "conversation-2"]);
    await expect(bridge.requestHandler.getTask(GetTaskRequest.fromJSON({ id: alice.id }), context("bob"))).rejects.toThrow();
    await expect(bridge.requestHandler.cancelTask(CancelTaskRequest.fromJSON({ id: bob.id }), context("alice"))).rejects.toThrow();
  } finally { expect((await bridge.close()).complete).toBe(true); }
});

test("execution beforeTurn rejection precedes mapping lookup and SDK session creation", async () => {
  const events: string[] = [];
  const runner = new AgentSdkTurnRunner({
    createSession() { events.push("create"); throw new Error("must not create"); },
    resumeSession() { events.push("resume"); throw new Error("must not resume"); },
  } as unknown as LettaAgentClient, "existing", {
    sharingDomain: "guard",
    sessionOptions: {},
    conversationMapping: { get() { events.push("mapping lookup"); return undefined; }, set() {} },
    execution: { async beforeTurn() { events.push("beforeTurn"); throw new Error("durable guard rejected"); } },
  });
  await expect(runner.runTurn(turn("guarded"))).rejects.toThrow("durable guard rejected");
  expect(events).toEqual(["beforeTurn"]);
});

test("an interrupted SDK result quarantines its context instead of confirming cancellation or replaying", async () => {
  const sent = deferred(), interrupted = deferred();
  let opens = 0, sends = 0, aborts = 0;
  const session = {
    async ready() { return { conversationId: "uncertain" }; },
    async send() { sends++; sent.resolve(); },
    async abort() { aborts++; interrupted.resolve(); },
    async *stream(): AsyncGenerator<SDKMessage> {
      await interrupted.promise;
      yield { type: "result", success: false, result: "", stopReason: "interrupted", durationMs: 1, conversationId: "uncertain" };
    },
    async [Symbol.asyncDispose]() {},
  };
  const client = { createSession: () => { opens++; return session; }, resumeSession: () => { opens++; return session; } } as unknown as LettaAgentClient;
  const runner = new AgentSdkTurnRunner(client, "existing", { sharingDomain: "cancel", sessionOptions: {} });
  const controller = new AbortController();
  const running = runner.runTurn(turn("same", controller.signal));
  const failure = running.catch((error: unknown) => error);
  await sent.promise;
  controller.abort();
  const error = await failure;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(LettaTurnCancelledError);
  expect(runner.unresolvedContexts).toContain("same");
  await expect(runner.runTurn(turn("same"))).rejects.toThrow();
  expect({ opens, sends, aborts }).toEqual({ opens: 1, sends: 1, aborts: 1 });
});

test("disconnecting an HTTP stream does not cancel accepted work; GetTask retains its result", async () => {
  const entered = deferred(), release = deferred();
  let canceled = false;
  const bridge = createBridge({
    sharingDomain: "disconnect", publicBaseUrl: "http://127.0.0.1:0",
    runner: { async runTurn(input) {
      input.signal.addEventListener("abort", () => { canceled = true; }, { once: true });
      entered.resolve();
      await release.promise;
      if (canceled) throw new LettaTurnCancelledError();
      return { text: "Answer survives disconnection" };
    } },
  });
  const listener = await listenLoopback(bridge);
  try {
    const remote = await testClient(listener.url);
    const accepted = await remote.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "user", parts: [{ text: "hello" }] }, configuration: { blocking: false, returnImmediately: true } }));
    task(accepted);
    const id = accepted.id;
    await entered.promise;
    await remote.getTask(GetTaskRequest.fromJSON({ id, historyLength: 0 }));
    expect(canceled).toBe(false);
    release.resolve();
    let stored: Task | undefined;
    for (let i = 0; i < 100; i++) {
      stored = await remote.getTask(GetTaskRequest.fromJSON({ id, historyLength: 0 }));
      if (stored.status?.state === TaskState.TASK_STATE_COMPLETED) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(stored?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(stored?.artifacts).toHaveLength(1);
    expect(canceled).toBe(false);
  } finally { release.resolve(); await listener.close(); }
}, 10_000);

test("CancelTask reports cancellation only after a cooperative runner confirms it stopped", async () => {
  const entered = deferred();
  const bridge = createBridge({
    sharingDomain: "cooperative-cancel", publicBaseUrl: "http://127.0.0.1:0",
    runner: { async runTurn(input) {
      entered.resolve();
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new LettaTurnCancelledError();
    } },
  });
  const listener = await listenLoopback(bridge);
  try {
    const remote = await testClient(listener.url);
    const submission = SendMessageRequest.fromJSON({ message: { messageId: crypto.randomUUID(), role: "user", parts: [{ text: "Wait until canceled" }] }, configuration: { blocking: false, returnImmediately: true } });
    const accepted = await remote.sendMessage(submission);
    task(accepted);
    await entered.promise;
    const canceled = await remote.cancelTask(CancelTaskRequest.fromJSON({ id: accepted.id }));
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(canceled.artifacts).toEqual([]);
    const stored = await remote.getTask(GetTaskRequest.fromJSON({ id: accepted.id, historyLength: 0 }));
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
  } finally {
    expect((await listener.close()).complete).toBe(true);
  }
}, 10_000);

test("task get, cancel, subscribe, and list stay isolated across authenticated bindings", async () => {
  const config = parseApplicationConfig({
    port: 0, publicUrl: "http://127.0.0.1:0/agents/",
    connections: { one: { type: "local" }, two: { type: "local" } },
    bindings: {
      a: { path: "/a", connection: "one", agentId: "same-agent", auth: { tokenEnv: "TOKEN_A", owner: "operator" } },
      b: { path: "/b", connection: "two", agentId: "same-agent", auth: { tokenEnv: "TOKEN_B", owner: "operator" } },
    },
  });
  const scope = await Effect.runPromise(Scope.make());
  const opened: string[] = [];
  const server = await Effect.runPromise(startApplicationServer(config, (binding) => ({
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: () => {
      opened.push(binding.id);
      return {
        async ready() { return { conversationId: "same-conversation" }; }, async send() {}, async abort() {},
        async *stream() { yield completedMessage("same-conversation", binding.id); },
        async [Symbol.asyncDispose]() {},
      };
    },
    async close() {},
  }) as unknown as LettaAgentClient, "127.0.0.1", { TOKEN_A: "key-a", TOKEN_B: "key-b" })
    .pipe(Effect.provideService(Scope.Scope, scope)));
  try {
    const connect = (key: "a" | "b") => testClient(server.bindings[key]!, `key-${key}`);
    const [a, b] = await Promise.all([connect("a"), connect("b")]);
    const [first, second] = await Promise.all([
      a.sendMessage(request("a", "same-context", "same-message")),
      b.sendMessage(request("b", "same-context", "same-message")),
    ]);
    task(first); task(second);
    expect(first.id).not.toBe(second.id);
    expect(opened.sort()).toEqual(["a", "b"]);
    for (const [remote, own, other] of [[a, first, second], [b, second, first]] as const) {
      await expect(remote.getTask(GetTaskRequest.fromJSON({ id: other.id }))).rejects.toThrow();
      await expect(remote.cancelTask(CancelTaskRequest.fromJSON({ id: other.id }))).rejects.toThrow();
      const subscription = remote.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: other.id }));
      await expect(subscription.next()).rejects.toThrow();
      const listing = await remote.listTasks(ListTasksRequest.fromJSON({ pageSize: 100 }));
      expect(listing.tasks.map((item) => item.id)).toEqual([own.id]);
    }
    expect(opened).toHaveLength(2);
  } finally { await Effect.runPromise(Scope.close(scope, Exit.void)); }
}, 10_000);
