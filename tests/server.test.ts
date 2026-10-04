import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit, Scope } from "effect";
import type { CreateSessionOptions, LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import { parseApplicationConfig, parseConfig } from "../src/config.js";
import { testClient, sendRequest } from "./helpers/a2a-client.js";
import { startApplicationServer, startServer, acquireSdkClient, withTurnDeadline } from "../src/server.js";
import { AgentSdkTurnRunner } from "../src/bridge/letta-agent.js";

for (const retrievalFails of [false, true]) {
  test(`retrieval interruption retains ownership until SDK promise settles; failure=${retrievalFails}`, async () => {
    const events: string[] = [];
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const retrieval = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      agents: { async retrieve(id: string) {
        entered();
        await retrieval;
        events.push("retrieval settled");
        if (retrievalFails) throw new Error("retrieval failed");
        return { id };
      } },
      async close() { events.push("client closed"); },
    } as unknown as LettaAgentClient;
    const controller = new AbortController();
    let finished = false;
    const running = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const owned = yield* acquireSdkClient(() => client);
      return yield* startServer(parseConfig({
        agentId: "test", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0",
      }), owned);
    })), { signal: controller.signal }).then((exit) => { finished = true; return exit; });
    try {
      await started;
      controller.abort();
      // Allow pending interruption and finalizers to run while retrieval stays
      // deliberately unresolved, including lazy SDK management startup.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual([]);
      expect(finished).toBe(false);
      release();
      expect(Exit.isFailure(await running)).toBe(true);
      expect(events).toEqual(["retrieval settled", "client closed"]);
    } finally {
      release();
      controller.abort();
      await running;
    }
  });
}

test("interruption awaits public client close before releasing ownership", async () => {
  let closing = false;
  let closed = false;
  let release!: () => void;
  const disposal = new Promise<void>((resolve) => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const client = {
    async close() { closing = true; await disposal; closed = true; },
  } as unknown as LettaAgentClient;
  const controller = new AbortController();
  const running = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    yield* acquireSdkClient(() => client);
    yield* Effect.sync(ready);
    return yield* Effect.never;
  })), { signal: controller.signal });
  await started;
  controller.abort();
  for (let i = 0; i < 100 && !closing; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(closing).toBe(true);
  expect(closed).toBe(false);
  release();
  expect(Exit.isFailure(await running)).toBe(true);
  expect(closed).toBe(true);
});

test("client close rejection fails scope exit", async () => {
  const client = { async close() { throw new Error("close failed"); } } as unknown as LettaAgentClient;
  expect(Exit.isFailure(await Effect.runPromiseExit(Effect.scoped(acquireSdkClient(() => client))))).toBe(true);
});

test("failed listener acquisition closes the owned client and permits later acquisition", async () => {
  let closes = 0;
  const client = {
    agents: { retrieve: async (id: string) => ({ id }) },
    async close() { closes++; },
  } as unknown as LettaAgentClient;
  const config = parseConfig({ agentId: "test", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0" });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const first = yield* startServer(config, client);
    const occupied = { ...config, port: Number(new URL(first.url).port) };
    const failure = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const owned = yield* acquireSdkClient(() => client);
      return yield* startServer(occupied, owned);
    })));
    expect(Exit.isFailure(failure)).toBe(true);
    expect(closes).toBe(1);
    const another = yield* startServer(config, client);
    expect((yield* Effect.tryPromise(() => fetch(`${another.url}/healthz`))).ok).toBe(true);
  })));
  expect(closes).toBe(1);
});

test("active-turn interruption awaits session disposal before client close", async () => {
  const events: string[] = [];
  let sent!: () => void;
  const started = new Promise<void>((resolve) => { sent = resolve; });
  let aborted!: () => void;
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  let disposing!: () => void;
  const disposalStarted = new Promise<void>((resolve) => { disposing = resolve; });
  let release!: () => void;
  const disposal = new Promise<void>((resolve) => { release = resolve; });
  const open = () => ({
    async ready() { return { conversationId: "active-conversation" }; },
    async send() { sent(); },
    async abort() { events.push("abort requested"); aborted(); },
    async *stream() { await cancelled; },
    async [Symbol.asyncDispose]() { disposing(); await disposal; events.push("session disposed"); },
  });
  const client = {
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: open, resumeSession: open,
    async close() { events.push("client closed"); },
  } as unknown as LettaAgentClient;
  let listening!: () => void;
  const listeningStarted = new Promise<void>((resolve) => { listening = resolve; });
  let url = "";
  const controller = new AbortController();
  const running = Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
    const owned = yield* acquireSdkClient(() => client);
    const server = yield* startServer(parseConfig({
      agentId: "test", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0",
    }), owned);
    url = server.url;
    yield* Effect.sync(listening);
    return yield* Effect.never;
  })), { signal: controller.signal });
  await listeningStarted;
  const remote = await testClient(url);
  const waitFor = async (promise: Promise<void>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 2_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await remote.sendMessage(sendRequest("hello", undefined, true));
    await waitFor(started, "SDK send");
    // Shutdown itself must interrupt the active turn; do not pre-cancel it.
    controller.abort();
    await waitFor(disposalStarted, "session disposal");
    expect(events).toContain("abort requested");
    expect(events).not.toContain("client closed");
    release();
    expect(Exit.isFailure(await running)).toBe(true);
    expect(events.slice(-2)).toEqual(["session disposed", "client closed"]);
    // Rebinding the exact port proves that the listener was released.
    await Effect.runPromise(Effect.scoped(startServer(parseConfig({
      agentId: "test", backend: { type: "local" },
      port: Number(new URL(url).port), publicUrl: url,
    }), client)));
  } finally {
    release();
    controller.abort();
    await running;
  }
}, 15000);

for (const failure of ["none", "client", "bridge"] as const) {
  test(`NodeRuntime SIGTERM awaits owned layer cleanup; failure=${failure}`, async () => {
    const serverModuleUrl = new URL("../src/server.ts", import.meta.url).href;
    const configModuleUrl = new URL("../src/config.ts", import.meta.url).href;
    const helperModuleUrl = new URL("./helpers/a2a-client.ts", import.meta.url).href;
    const script = `
      import { Effect } from "effect";
      import { NodeRuntime } from "@effect/platform-node";
      import { Server } from ${JSON.stringify(serverModuleUrl)};
      import { parseConfig } from ${JSON.stringify(configModuleUrl)};
      import { testClient, sendRequest } from ${JSON.stringify(helperModuleUrl)};
      const config = parseConfig({ agentId: "test", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0" });
      const open = () => ({
        async ready() { return { conversationId: "signal-conversation" }; },
        async send() {}, async abort() {},
        async *stream() {
          yield { type: "result", success: true, result: "done", durationMs: 1, conversationId: "signal-conversation" };
        },
        async [Symbol.asyncDispose]() { throw new Error("uncertain session disposal"); },
      });
      const client = {
        agents: { retrieve: async (id) => ({ id }) },
        createSession: open, resumeSession: open,
        async close() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          process.stdout.write("client closed\\n");
          if (${failure === "client"}) throw new Error("disposal failed");
        },
      };
      NodeRuntime.runMain(Effect.gen(function* () {
        const server = yield* Server;
        if (${failure === "bridge"}) {
          yield* Effect.tryPromise(async () => {
            const remote = await testClient(server.url);
            await remote.sendMessage(sendRequest("hello")).catch(() => undefined);
          });
        }
        yield* Effect.sync(() => process.stdout.write("ready\\n"));
        return yield* Effect.never;
      }).pipe(Effect.provide(Server.layer(config, () => client))));
    `;
    const child = Bun.spawn(["node", "--import", "tsx", "--input-type=module", "-e", script], {
      stdout: "pipe", stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
      while (!output.includes("ready\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Signal fixture exited before readiness: ${output}${await new Response(child.stderr).text()}`);
        output += decoder.decode(chunk.value);
      }
      child.kill("SIGTERM");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value);
      }
      expect(await child.exited).toBe(failure === "none" ? 130 : 1);
      expect(output).toContain("client closed\n");
      const errors = await new Response(child.stderr).text();
      if (failure !== "none") expect(output + errors).toContain(
        failure === "client" ? "SDK client shutdown failed" : "Bridge shutdown failed",
      );
    } finally {
      reader.releaseLock();
      child.kill();
      await child.exited;
    }
  }, 15000);
}

test("direct discovery and two turns use an existing agent and preserve conversation identity", async () => {
  const opened: string[] = [];
  const sessionOptions: CreateSessionOptions[] = [];
  let disposals = 0;
  let clientCloses = 0;
  const open = (id: string, options: CreateSessionOptions) => {
    opened.push(id);
    sessionOptions.push(options);
    return {
      async ready() { return { conversationId: "conv-test" }; },
      async send() {},
      async abort() {},
      async *stream() {
        yield { type: "result", success: true, result: "hello", conversationId: "conv-test", durationMs: 1 };
      },
      async [Symbol.asyncDispose]() { disposals++; },
    };
  };
  const client = {
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: open, resumeSession: open,
    async close() { clientCloses++; },
  } as unknown as LettaAgentClient;
  const scope = await Effect.runPromise(Scope.make());
  const server = await Effect.runPromise(startServer(parseConfig({
    agentId: "agent-test", backend: { type: "local" }, port: 0,
    publicUrl: "http://127.0.0.1:0",
  }), client).pipe(Effect.provideService(Scope.Scope, scope)));
  const remote = await testClient(server.url);
  try {
    const response = await fetch(`${server.url}/${AGENT_CARD_PATH}`);
    expect(response.ok).toBe(true);
    const card = await response.json() as { supportedInterfaces: { url: string }[] };
    expect(card.supportedInterfaces[0]?.url).toBe(`${server.url}/`);
    const first = await remote.sendMessage(sendRequest("hello"));
    const second = await remote.sendMessage(sendRequest("again", first.contextId));
    expect(second.contextId).toBe(first.contextId);
    expect(opened).toEqual(["agent-test", "conv-test"]);
    expect(disposals).toBe(2);
    const options = sessionOptions[0]!;
    expect(options.tools).toBeUndefined();
    expect(options.permissionMode).toBe("standard");
    expect(options.allowedTools).toBeUndefined();
    expect(options.toolset).toBeUndefined();
    expect(options.skillSources).toBeUndefined();
    for (const tool of ["a2a_invoke", "Bash", "nativeBash"]) {
      expect((await options.canUseTool!(tool, {})).behavior).toBe("deny");
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(clientCloses).toBe(0); // Injected clients remain caller-owned.
  }
}, 15000);

test("application deadline aborts sent memory and SQLite-backed sessions", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const originalTimeout = AbortSignal.timeout;
  const root = await mkdtemp(join(tmpdir(), "a2a-deadline-"));
  try { for (const durable of [false, true]) {
    let aborted = false;
    let closed = false;
    let disposed = false;
    let sent = false;
    let sessionStarted!: () => void;
    const started = new Promise<void>((resolve) => { sessionStarted = resolve; });
    let abortSession!: () => void;
    const abortedSession = new Promise<void>((resolve) => { abortSession = resolve; });
    const client = {
      agents: { async retrieve(id: string) { return { id }; } },
      createSession: () => ({
        async ready() { return { conversationId: "deadline-conversation" }; },
        async send() { sent = true; sessionStarted(); }, async abort() { aborted = true; abortSession(); },
        async *stream() { await abortedSession; yield { type: "result", success: true, result: "stopped", durationMs: 1, conversationId: "deadline-conversation" }; },
        async [Symbol.asyncDispose]() { disposed = true; },
      }),
      resumeSession: () => { throw new Error("Unexpected resume"); },
      async close() { closed = true; },
    } as unknown as LettaAgentClient;
    const config = parseApplicationConfig({ agentId: "deadline-agent", backend: { type: "local" }, port: 0,
      publicUrl: "http://127.0.0.1:0", ...(durable ? { stateDirectory: join(root, "sqlite") } : {}) });
    const scope = await Effect.runPromise(Scope.make());
    const server = await Effect.runPromise(startApplicationServer(config, () => client).pipe(Effect.provideService(Scope.Scope, scope)));
    const remote = await testClient(server.bindings.default!);
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      let fireDeadline!: () => void;
      const deadline = new AbortController();
      const deadlineSignal = deadline.signal;
      timeout.mockImplementation((ms) => {
        if (ms === 120_000) { fireDeadline = () => deadline.abort(new Error("deadline")); return deadlineSignal; }
        return originalTimeout.call(AbortSignal, ms);
      });
      const invocation = remote.sendMessage(sendRequest("wait"));
      // A failed assertion must still leave shutdown free to reject this call.
      void invocation.catch(() => undefined);
      await started;
      expect(sent).toBe(true);
      expect(fireDeadline).toBeTypeOf("function");
      fireDeadline();
      const result = await invocation;
      expect("status" in result).toBe(true);
      if (!("status" in result)) throw new Error("Expected terminal task after deadline");
      expect(result.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(result.artifacts).toEqual([]);
      expect(aborted).toBe(true);
      expect(disposed).toBe(true);
    } finally {
      timeout.mockRestore();
      await Effect.runPromise(Scope.close(scope, Exit.void));
      expect(closed).toBe(true); // Application factory clients belong to the launcher scope.
    }
  } } finally { await rm(root, { recursive: true, force: true }); }
});

test("application inbound configuration failure is typed and closes acquired clients", async () => {
    let created = 0;
    let closed = 0;
    const auth = { tokenEnv: "MISSING_A2A_TOKEN", owner: "test" };
    const config = parseApplicationConfig({
      port: 0,
      publicUrl: "http://127.0.0.1:0/",
      connections: { local: { type: "local" } },
      bindings: { test: {
        path: "", connection: "local", agentId: "existing-agent",
        auth,
      } },
    });
    const createClient = () => {
      created++;
      return {
        agents: { async retrieve(id: string) { return { id }; } },
        async close() { closed++; },
      } as unknown as LettaAgentClient;
    };
    const exit = await Effect.runPromiseExit(Effect.scoped(
      startApplicationServer(config, createClient, "127.0.0.1", {}),
    ));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasFails(exit.cause)).toBe(true);
      expect(Cause.hasDies(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "InboundAuthenticationConfigurationError" });
    }
    expect(created).toBe(1);
    expect(closed).toBe(created);
});

test("turn deadline retains an incoming A2A abort signal", async () => {
  let aborted = false;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  let begin!: () => void;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const client = { createSession: () => ({
    async ready() { begin(); return { conversationId: "incoming" }; }, async send() {},
    async abort() { aborted = true; finish(); }, async *stream() { await waiting; },
    async [Symbol.asyncDispose]() {},
  }), resumeSession() { throw new Error("Unexpected resume"); } } as unknown as LettaAgentClient;
  const runner = new AgentSdkTurnRunner(client, "agent", { sharingDomain: "incoming", sessionOptions: {} });
  const controller = new AbortController();
  const pending = withTurnDeadline(runner, 120_000).runTurn({ a2aContextId: "context", messageId: "message", text: "wait", signal: controller.signal, onAssistantText() {} });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
  expect(aborted).toBe(true);
});

test("one listener mounts independent bindings under a public prefix and protects bearer routes", async () => {
  const sessions: string[] = [];
  const clients: string[] = [];
  const makeClient = (key: string) => ({
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: () => {
      sessions.push(key);
      return {
        async ready() { return { conversationId: "same-id" }; }, async send() {}, async abort() {},
        async *stream() { yield { type: "result", success: true, result: key, durationMs: 1, conversationId: "same-id" }; },
        async [Symbol.asyncDispose]() {},
      };
    },
    async close() { clients.push(key); },
  }) as unknown as LettaAgentClient;
  const config = parseApplicationConfig({ port: 0, publicUrl: "http://127.0.0.1:0/agents/",
    connections: { local: { type: "local" } },
    bindings: {
      a: { path: "/a", connection: "local", agentId: "agent-a", auth: { tokenEnv: "A_TOKEN", owner: "operator-a" } },
      b: { path: "/b", connection: "local", agentId: "agent-b", auth: { tokenEnv: "B_TOKEN", owner: "operator-b" } },
    },
  });
  const scope = await Effect.runPromise(Scope.make());
  const application = await Effect.runPromise(startApplicationServer(config, (binding) => makeClient(binding.id), "127.0.0.1", { A_TOKEN: "secret-a", B_TOKEN: "secret-b" })
    .pipe(Effect.provideService(Scope.Scope, scope)));
  try {
    expect(Object.keys(application.bindings).sort()).toEqual(["a", "b"]);
    for (const [key, url] of Object.entries(application.bindings)) {
      const card = await fetch(`${url}/${AGENT_CARD_PATH}`, { headers: { authorization: `Bearer secret-${key}` } });
      expect(card.ok).toBe(true);
      const body = await card.json() as { supportedInterfaces: { url: string }[] };
      expect(body.supportedInterfaces[0]?.url).toBe(`${url}/`);
    }
    const denied = await fetch(`${application.bindings.a}/${AGENT_CARD_PATH}`);
    expect(denied.status).toBe(401);
    const bad = await fetch(`${application.bindings.a}/`, { method: "POST", headers: { authorization: "Basic x" } });
    expect(bad.status).toBe(401);
    await expect(testClient(application.bindings.a!, "wrong-token")).rejects.toThrow();
    const peerA = await testClient(application.bindings.a!, "secret-a");
    const peerB = await testClient(application.bindings.b!, "secret-b");
    await peerA.sendMessage(sendRequest("a", "same-context"));
    await peerB.sendMessage(sendRequest("b", "same-context"));
    expect(sessions).toEqual(["a", "b"]);
  } finally {
    const close = Effect.runPromise(Scope.close(scope, Exit.void));
    await close;
  }
  expect(clients.sort()).toEqual(["a", "b"]);
}, 15000);

test("single-agent root binding serves health, card discovery, and invocation", async () => {
  const opened: string[] = [];
  const client = {
    agents: { retrieve: async (id: string) => ({ id }) },
    createSession: () => {
      opened.push("turn");
      return ({
      async ready() { return { conversationId: "root-conversation" }; }, async send() {}, async abort() {},
      async *stream() { yield { type: "result", success: true, result: "root answer", durationMs: 1, conversationId: "root-conversation" }; },
      async [Symbol.asyncDispose]() {},
      });
    },
    async close() {},
  } as unknown as LettaAgentClient;
  const config = parseApplicationConfig({ agentId: "single-root", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0" });
  const scope = await Effect.runPromise(Scope.make());
  const server = await Effect.runPromise(startApplicationServer(config, () => client).pipe(Effect.provideService(Scope.Scope, scope)));
  try {
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    const card = await fetch(`${server.url}/${AGENT_CARD_PATH}`);
    expect(card.status).toBe(200);
    const body = await card.json() as { name: string };
    expect(body.name).toBe("Letta A2A Agent");
    const remote = await testClient(server.bindings.default!);
    const result = await remote.sendMessage(sendRequest("hello"));
    expect(result).toBeDefined();
    expect(opened).toEqual(["turn"]);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}, 10000);

test("partial multi-binding startup failure closes every acquired SDK client", async () => {
  const config = parseApplicationConfig({
    port: 0, publicUrl: "http://127.0.0.1:0/agents/",
    connections: { local: { type: "local" } },
    bindings: {
      first: { path: "/first", connection: "local", agentId: "first-agent" },
      second: { path: "/second", connection: "local", agentId: "second-agent" },
    },
  });
  const closed: string[] = [];
  const createClient = (binding: { id: string }) => ({
    agents: { retrieve: async (id: string) => {
      if (id === "second-agent") throw new Error("expected test failure");
      return { id };
    } },
    async close() { closed.push(binding.id); },
  }) as unknown as LettaAgentClient;
  const scope = await Effect.runPromise(Scope.make());
  try {
    const exit = await Effect.runPromiseExit(startApplicationServer(config, createClient)
      .pipe(Effect.provideService(Scope.Scope, scope)));
    expect(Exit.isFailure(exit)).toBe(true);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  expect(closed.sort()).toEqual(["first", "second"]);
});

test("launcher ownership closes its client when startup fails", async () => {
  let closed = false;
  const client = {
    agents: { retrieve: async () => { throw new Error("startup failed"); } },
    async close() { await Promise.resolve(); closed = true; },
  } as unknown as LettaAgentClient;
  await expect(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owned = yield* acquireSdkClient(() => client);
    return yield* startServer(parseConfig({ agentId: "test", backend: { type: "local" } }), owned);
  }))))
    .rejects.toThrow("retrieval failed");
  expect(closed).toBe(true);
});

for (const incomplete of [false, true]) {
  test(`launcher closes sessions before its client; incomplete=${incomplete}`, async () => {
    const events: string[] = [];
    const open = () => ({
      async ready() { return { conversationId: "owned-conversation" }; },
      async send() {},
      async abort() {},
      async *stream() {
        yield { type: "result", success: true, result: "done", durationMs: 1, conversationId: "owned-conversation" };
      },
      async [Symbol.asyncDispose]() {
        events.push("session disposed");
        if (incomplete) throw new Error("uncertain cleanup");
      },
    });
    const client = {
      agents: { retrieve: async (id: string) => ({ id }) },
      createSession: open, resumeSession: open,
      async close() { await Promise.resolve(); events.push("client closed"); },
    } as unknown as LettaAgentClient;
    const scope = await Effect.runPromise(Scope.make());
    const server = await Effect.runPromise(Effect.gen(function* () {
      const owned = yield* acquireSdkClient(() => client);
      return yield* startServer(parseConfig({
      agentId: "test", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0",
    }), owned);
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const remote = await testClient(server.url);
    try {
      const call = remote.sendMessage(sendRequest("hello"));
      if (incomplete) await call.catch(() => undefined);
      else await call;
    } finally {
      const exit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
      expect(Exit.isFailure(exit)).toBe(incomplete);
    }
    expect(events).toEqual(["session disposed", "client closed"]);
  }, 15000);
}

test("startup refuses an unresolved existing-agent binding without creating an agent", async () => {
  const client = { agents: { retrieve: async () => ({ id: "wrong-agent" }) } } as unknown as LettaAgentClient;
  await expect(Effect.runPromise(Effect.scoped(startServer(parseConfig({ agentId: "agent-test", backend: { type: "local" } }), client))))
    .rejects.toThrow("identity");
});
