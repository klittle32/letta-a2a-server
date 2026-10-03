import { describe, expect, test } from "bun:test";
import { Message, Task, TaskState } from "@a2a-js/sdk";
import { createA2ATools } from "../src/client/agent-sdk.js";
import { A2AInvocationError, createOfficialClientProvider } from "../src/client/a2a-invoker.js";
import { projectA2AResult, runA2ATool, type A2AToolClient } from "../src/client/tool-operations.js";
const scope = () => ({ agentId: "agent-1", conversationId: "conversation-1" });
const task = Task.fromJSON({
  id: "task-1",
  contextId: "context-1",
  status: { state: TaskState.TASK_STATE_COMPLETED },
  artifacts: [{ artifactId: "artifact-1", parts: [{ text: "answer" }] }],
});
function fixture() {
  const scopes: string[] = [];
  const client: A2AToolClient = {
    async invoke(input) {
      scopes.push(input.localScope);
      return task;
    },
    async task(input) {
      scopes.push(input.localScope);
      return task;
    },
    targets: () => ["remote"],
    async drain() {},
  };
  return { client, scopes };
}
const args = { target: "remote", message: "hello" };

test("official provider discovers a mounted endpoint relative to its final path segment", async () => {
  const requested: string[] = [];
  const mockFetch = Object.assign(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    return Response.json({
      name: "Mounted", description: "mounted", version: "1",
      supportedInterfaces: [{ url: "http://127.0.0.1:41241/agents/first/", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: true }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [],
    });
  }, fetch);
  const provider = createOfficialClientProvider({ fetchImpl: mockFetch });
  const client = await provider("http://127.0.0.1:41241/agents/first");
  expect(requested).toEqual(["http://127.0.0.1:41241/agents/first/.well-known/agent-card.json"]);
  expect(await client.getAgentCard()).toBeDefined();
});


describe("session-owned SDK A2A tools", () => {
  test("duplicate SDK call IDs share in-flight and completed results", async () => {
    const { client } = fixture();
    let calls = 0;
    let release!: (value: Task) => void;
    const response = new Promise<Task>((resolve) => { release = resolve; });
    client.invoke = async () => { calls++; return response; };
    const group = createA2ATools({ client, getScope: scope, signal: new AbortController().signal });
    const tool = group.tools[0]!;
    const first = tool.execute("same-call", args);
    const duplicate = tool.execute("same-call", { message: "hello", target: "remote" });
    try {
      expect(calls).toBe(1);
      release(task);
      expect(await duplicate).toEqual(await first);
      expect(await tool.execute("same-call", args)).toEqual(await first);
      expect(calls).toBe(1);
      await tool.execute("different-call", args);
      expect(calls).toBe(2);
    } finally {
      release(task);
      await Promise.allSettled([first, duplicate]);
      await group.close();
    }
    expect((await tool.execute("same-call", args)).isError).toBe(true);
    expect(calls).toBe(2);
  });

  test("reused SDK call IDs cannot change arguments, tool, or trusted scope", async () => {
    const { client, scopes } = fixture();
    let conversationId = "conversation-1";
    const group = createA2ATools({
      client, getScope: () => ({ agentId: "agent-1", conversationId }), signal: new AbortController().signal,
    });
    try {
      expect((await group.tools[0]!.execute("bound-call", args)).isError).toBe(false);
      expect((await group.tools[0]!.execute("bound-call", { ...args, message: "different" })).isError).toBe(true);
      expect((await group.tools[1]!.execute("bound-call", { target: "remote", task_id: "task-1", action: "cancel" })).isError).toBe(true);
      conversationId = "conversation-2";
      expect((await group.tools[0]!.execute("bound-call", args)).isError).toBe(true);
      expect(scopes).toEqual(["agent-1/conversation-1"]);
    } finally { await group.close(); }
  });

  test("duplicate SDK call IDs never replay an ambiguous failed submission", async () => {
    const { client } = fixture();
    let calls = 0;
    client.invoke = async () => {
      calls++;
      throw new A2AInvocationError("Outcome unknown", { submissionAttempted: true });
    };
    const group = createA2ATools({ client, getScope: scope, signal: new AbortController().signal });
    try {
      const first = await group.tools[0]!.execute("uncertain", args);
      expect(first.isError).toBe(true);
      expect(await group.tools[0]!.execute("uncertain", args)).toEqual(first);
      expect(calls).toBe(1);
    } finally { await group.close(); }
  });

  test("strict arguments and trusted ready scope", async () => {
    const { client, scopes } = fixture();
    for (const bad of [
      { ...args, localScope: "injected" },
      { ...args, agentId: "evil" },
      { ...args, new_context: true, task_id: "x" },
      { ...args, new_context: true, context_id: "x" },
      { ...args, message: 4 },
      null,
    ]) {
      expect(
        (
          await runA2ATool("a2a_invoke", bad, {
            client,
            getScope: scope,
            signal: new AbortController().signal,
          })
        ).isError,
      ).toBe(true);
    }
    for (const getScope of [
      () => undefined,
      () => ({ agentId: "a/b", conversationId: "c" }),
      () => ({ agentId: "a", conversationId: "" }),
    ]) {
      expect(
        (
          await runA2ATool("a2a_invoke", args, {
            client,
            getScope,
            signal: new AbortController().signal,
          })
        ).isError,
      ).toBe(true);
    }
    expect(scopes).toEqual([]);
  });

  test("session scopes and reconnect groups are independent", async () => {
    const { client, scopes } = fixture();
    const owner = new AbortController();
    const first = createA2ATools({
      client,
      getScope: scope,
      signal: owner.signal,
    });
    const second = createA2ATools({
      client,
      getScope: () => ({
        agentId: "agent-1",
        conversationId: "conversation-2",
      }),
      signal: new AbortController().signal,
    });
    await first.tools[0]!.execute("1", args);
    await first.close();
    await second.tools[0]!.execute("1", args);
    const reconnect = createA2ATools({
      client,
      getScope: scope,
      signal: new AbortController().signal,
    });
    await reconnect.tools[0]!.execute("1", args);
    expect(scopes).toEqual([
      "agent-1/conversation-1",
      "agent-1/conversation-2",
      "agent-1/conversation-1",
    ]);
    await second.close();
    await reconnect.close();
  });

  test("SDK resolves scope at execution after ready and combines future signals", async () => {
    const { client, scopes } = fixture();
    let ready = false;
    const group = createA2ATools({
      client,
      getScope: () => (ready ? scope() : undefined),
      signal: new AbortController().signal,
    });
    expect((await group.tools[0]!.execute("before", args)).isError).toBe(true);
    ready = true;
    const invoked = await group.tools[0]!.execute("after", args);
    expect(invoked.isError).toBe(false);
    expect(invoked.content[0]?.text).toContain("answer");
    const readback = await group.tools[1]!.execute("readback", {
      target: "remote",
      task_id: "task-1",
      action: "get",
    });
    expect(readback.isError).toBe(false);
    expect(readback.content[0]?.text).toContain("task-1");
    const call = new AbortController();
    call.abort();
    expect(
      (await group.tools[0]!.execute("aborted", args, call.signal)).isError,
    ).toBe(true);
    expect(scopes).toEqual([
      "agent-1/conversation-1",
      "agent-1/conversation-1",
    ]);
    await group.close();
  });

  test("async disposal aborts active calls without aborting the owner's signal", async () => {
    const { client } = fixture();
    const owner = new AbortController();
    let stopped = false;
    client.invoke = (input) =>
      new Promise((_, reject) => {
        input.signal.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(new Error("Disposed"));
          },
          { once: true },
        );
      });
    const group = createA2ATools({
      client,
      getScope: scope,
      signal: owner.signal,
    });
    const pending = group.tools[0]!.execute("call", args);
    await group[Symbol.asyncDispose]();
    expect(stopped).toBe(true);
    expect(owner.signal.aborted).toBe(false);
    expect((await pending).isError).toBe(true);
  });

  test("close rejects while underlying work outlives its caller-facing result", async () => {
    const { client } = fixture();
    const seen: AbortSignal[] = [];
    const drained: AbortSignal[] = [];
    let finish!: () => void;
    const underlying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.invoke = async (input) => {
      seen.push(input.signal);
      throw new A2AInvocationError("Caller wait ended", {
        submissionAttempted: true,
        task: {
          ...task,
          status: {
            state: TaskState.TASK_STATE_WORKING,
            message: undefined,
            timestamp: undefined,
          },
        },
      });
    };
    client.drain = (signal) => {
      drained.push(signal);
      return underlying;
    };
    const owner = new AbortController();
    const group = createA2ATools({
      client,
      getScope: scope,
      signal: owner.signal,
      closeTimeoutMs: 5,
    });
    const result = await group.tools[0]!.execute("call", args);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("working");
    await expect(group.close()).rejects.toThrow("cleanup incomplete");
    expect(drained).toEqual(seen);
    finish();
  });

  test("close waits exact owner and combined call signals, not another group", async () => {
    const { client } = fixture();
    const finish = new Map<AbortSignal, () => void>();
    const underlying = new Map<AbortSignal, Promise<void>>();
    const drained: AbortSignal[] = [];
    client.invoke = async (input) => {
      underlying.set(
        input.signal,
        new Promise<void>((resolve) => {
          finish.set(input.signal, resolve);
        }),
      );
      return task;
    };
    client.drain = (signal) => {
      drained.push(signal);
      return underlying.get(signal) ?? Promise.resolve();
    };
    const group = createA2ATools({
      client,
      getScope: scope,
      signal: new AbortController().signal,
    });
    const other = createA2ATools({
      client,
      getScope: scope,
      signal: new AbortController().signal,
    });
    await group.tools[0]!.execute("owner", args);
    await group.tools[0]!.execute(
      "combined",
      args,
      new AbortController().signal,
    );
    await other.tools[0]!.execute("other", args);
    const signals = [...underlying.keys()];
    let closed = false;
    const closing = group.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    expect(drained).toEqual(signals.slice(0, 2));
    finish.get(signals[0]!)!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(false);
    finish.get(signals[1]!)!();
    await closing;
    expect(closed).toBe(true);
    expect(drained).not.toContain(signals[2]!);
    finish.get(signals[2]!)!();
    await other.close();
  });

  test("SDK advertises configured targets in both tools", async () => {
    const { client } = fixture();
    const group = createA2ATools({
      client,
      getScope: scope,
      signal: new AbortController().signal,
    });
    for (const tool of group.tools) {
      expect(tool.description).toContain("Configured targets: remote");
      expect(tool.parameters.properties.target.enum).toEqual(["remote"]);
    }
    await group.close();
  });

  test("large data previews remain bounded and all filtering is explicit", () => {
    const data = {
      rows: Array.from({ length: 100 }, () => ({
        count: 42,
        label: "unclassified-private-value",
      })),
      nested: { one: { two: { three: 1 } } },
    };
    const message = Message.fromJSON({
      messageId: "m",
      parts: Array.from({ length: 100 }, () => ({ data })),
    });
    const result = projectA2AResult("remote", message);
    expect(result.content.length).toBeLessThanOrEqual(16_000);
    expect(result.content).toContain("omitted");
    expect(result.content).not.toContain("unclassified-private-value");
    const parsed = JSON.parse(result.content);
    expect(parsed.omittedParts).toBeGreaterThan(0);
    expect(message.parts).toHaveLength(100);
  });

  test("partial failure retains readback and authoritative cancellation without causes", async () => {
    const { client } = fixture();
    client.invoke = async () => {
      throw new A2AInvocationError("Readback failed", {
        submissionAttempted: true,
        messageId: "message-1",
        task,
        cancellation: {
          ...task,
          status: {
            state: TaskState.TASK_STATE_WORKING,
            message: undefined,
            timestamp: undefined,
          },
        },
        cause: new Error("Authorization: secret"),
      });
    };
    const result = await runA2ATool("a2a_invoke", args, {
      client,
      getScope: scope,
      signal: new AbortController().signal,
    });
    const json = JSON.parse(result.content);
    expect(result.isError).toBe(true);
    expect(json.taskId).toBe("task-1");
    expect(json.contextId).toBe("context-1");
    expect(json.messageId).toBe("message-1");
    expect(json.cancellation).toBe("requested-not-confirmed");
    expect(json.submissionAttempted).toBe(true);
    expect(result.content).not.toContain("secret");
  });

});
