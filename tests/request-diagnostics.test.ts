import { expect, test } from "bun:test";
import { Effect, Logger, References } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { GetTaskRequest, TaskState } from "@a2a-js/sdk";
import { LettaTurnCancelledError } from "../src/bridge/letta-agent.js";
import { parseApplicationConfig } from "../src/config.js";
import { startApplicationServer } from "../src/server.js";
import { sendRequest, testClient } from "./helpers/a2a-client.js";

type LogRecord = {
  level: string;
  message: unknown;
  annotations: Readonly<Record<string, unknown>>;
};

function client(ready: () => void = () => {}) {
  const open = () => {
    const conversationId = crypto.randomUUID();
    return {
      async ready() { ready(); return { conversationId }; },
      async send() {}, async abort() {},
      async *stream() {
        yield { type: "result", success: true, result: "OK", conversationId, durationMs: 1 };
      },
      async [Symbol.asyncDispose]() {},
    };
  };
  return {
    agents: { async retrieve(id: string) { return { id }; } },
    createSession: open, resumeSession: open, async close() {},
  } as unknown as LettaAgentClient;
}

const config = parseApplicationConfig({
  port: 0, publicUrl: "http://127.0.0.1:0/agents/",
  connections: { local: { type: "local" } },
  bindings: {
    first: { path: "/first", connection: "local", agentId: "first-agent" },
    second: { path: "/second", connection: "local", agentId: "second-agent" },
  },
});

test("request diagnostics inherit the application logger and correlate failures without private content", async () => {
  const logs: LogRecord[] = [];
  const logger = Logger.make(({ logLevel, message, fiber }) => {
    logs.push({ level: logLevel, message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
  });
  let privateReads = 0;
  const error = new TypeError("PRIVATE credential and prompt");
  for (const key of ["name", "message", "stack", "cause", "toJSON"]) {
    Object.defineProperty(error, key, { get() { privateReads++; throw new Error("PRIVATE getter"); } });
  }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* startApplicationServer(config, () => client(() => { throw error; }));
    yield* Effect.tryPromise(async () => {
      for (const bindingId of ["first", "second"] as const) {
        const remote = await testClient(server.bindings[bindingId]!);
        const result = await remote.sendMessage(sendRequest("PRIVATE user prompt"));
        if (!("status" in result)) throw new Error("Expected task");
        expect(result.status?.state).toBe(TaskState.TASK_STATE_FAILED);
        expect(result.artifacts).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("PRIVATE credential");
        const record = logs.at(-1);
        expect(record?.message).toEqual(["A2A request failed"]);
        expect(record?.level).toBe("Error");
        expect(record?.annotations).toMatchObject({
          component: "diagnostic-test", bindingId, taskId: result.id, errorType: "TypeError",
        });
      }
    });
  })).pipe(Effect.provide(Logger.layer([logger])), Effect.annotateLogs({ component: "diagnostic-test" })));
  expect(logs).toHaveLength(2);
  expect(privateReads).toBe(0);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE");
});

test("confirmed cancellation is informational and non-Error failures are safely classified", async () => {
  const logs: LogRecord[] = [];
  const logger = Logger.make(({ logLevel, message, fiber }) => {
    logs.push({ level: logLevel, message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
  });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* startApplicationServer(config, (binding) => client(() => {
      if (binding.id === "first") throw new LettaTurnCancelledError();
      throw { message: "PRIVATE payload", token: "PRIVATE credential" };
    }));
    yield* Effect.tryPromise(async () => {
      for (const bindingId of ["first", "second"] as const) {
        const result = await (await testClient(server.bindings[bindingId]!)).sendMessage(sendRequest("hello"));
        if (!("status" in result)) throw new Error("Expected task");
        expect(result.status?.state).toBe(bindingId === "first" ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED);
        expect(result.artifacts).toEqual([]);
      }
    });
  })).pipe(Effect.provide(Logger.layer([logger]))));
  expect(logs.map(({ level, annotations }) => [level, annotations.errorType])).toEqual([
    ["Info", "LettaTurnCancelledError"], ["Error", "unknown"],
  ]);
  expect(JSON.stringify(logs)).not.toContain("PRIVATE");
});

test("diagnostic logger failures cannot change the task outcome or prevent cleanup", async () => {
  let logged = 0;
  let closed = 0;
  const logger = Logger.make(() => { logged++; throw new Error("broken logger"); });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* startApplicationServer(config, () => ({
      ...client(() => { throw new Error("PRIVATE SDK error"); }),
      async close() { closed++; },
    }) as LettaAgentClient);
    yield* Effect.tryPromise(async () => {
      const remote = await testClient(server.bindings.first!);
      const result = await remote.sendMessage(sendRequest("hello"));
      if (!("status" in result)) throw new Error("Expected task");
      const stored = await remote.getTask(GetTaskRequest.fromJSON({ id: result.id }));
      expect(stored.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(stored.artifacts).toEqual([]);
    });
  })).pipe(Effect.provide(Logger.layer([logger]))));
  expect(logged).toBe(1);
  expect(closed).toBe(2);
});

test("request diagnostics respect the configured minimum log level", async () => {
  let logged = 0;
  const logger = Logger.make(() => { logged++; });
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* startApplicationServer(config, () => client(() => { throw new Error("failure"); }));
    yield* Effect.tryPromise(async () => {
      const result = await (await testClient(server.bindings.first!)).sendMessage(sendRequest("hello"));
      if (!("status" in result)) throw new Error("Expected task");
      expect(result.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    });
  })).pipe(Effect.provide(Logger.layer([logger])), Effect.provideService(References.MinimumLogLevel, "None")));
  expect(logged).toBe(0);
});

test("successful requests do not emit failure diagnostics", async () => {
  let logged = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* startApplicationServer(config, () => client());
    yield* Effect.tryPromise(async () => {
      const result = await (await testClient(server.bindings.first!)).sendMessage(sendRequest("hello"));
      if (!("status" in result)) throw new Error("Expected task");
      expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    });
  })).pipe(Effect.provide(Logger.layer([Logger.make(() => { logged++; })]))));
  expect(logged).toBe(0);
});
