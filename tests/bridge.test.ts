import { describe, expect, test } from "bun:test";
import type {
  CreateSessionOptions,
  LettaAgentClient,
} from "@letta-ai/letta-agent-sdk";
import { AgentSdkTurnRunner } from "../src/bridge/letta-agent.js";

describe("SDK session ownership", () => {
  test("uses plain session options and resumes the ready conversation", async () => {
    const events: string[] = [];
    const opened: string[] = [];
    const open = (_id: string, options: CreateSessionOptions) => ({
      async ready() {
        return { conversationId: "conversation" };
      },
      async send() {
        expect(options.cwd).toBe("/workspace");
        events.push("sent");
      },
      async abort() {},
      async *stream() {
        yield {
          type: "result",
          success: true,
          result: "done",
          conversationId: "conversation",
          durationMs: 1,
        };
      },
      async [Symbol.asyncDispose]() {
        events.push("sdk disposed");
      },
    });
    const client = {
      createSession(id: string, options: CreateSessionOptions) {
        opened.push(`create:${id}`);
        return open(id, options);
      },
      resumeSession(id: string, options: CreateSessionOptions) {
        opened.push(`resume:${id}`);
        return open(id, options);
      },
    } as unknown as Pick<LettaAgentClient, "createSession" | "resumeSession">;
    const runner = new AgentSdkTurnRunner(client, "agent", {
      sharingDomain: "local",
      sessionOptions: { cwd: "/workspace" },
    });
    for (let turn = 0; turn < 2; turn++) {
      const signal = new AbortController().signal;
      await runner.runTurn({
        a2aContextId: "context",
        messageId: `message-${turn}`,
        text: "hi",
        signal,
      });
    }
    expect(opened).toEqual(["create:agent", "resume:conversation"]);
    expect(events).toEqual(["sent", "sdk disposed", "sent", "sdk disposed"]);
  });

  test("failed SDK cleanup quarantines an otherwise successful turn", async () => {
    const events: string[] = [];
    const client = {
      createSession() {
        return {
          async ready() {
            return { conversationId: "conversation" };
          },
          async send() {},
          async abort() {},
          async *stream() {
            yield {
              type: "result",
              success: true,
              result: "done",
              conversationId: "conversation",
              durationMs: 1,
            };
          },
          async [Symbol.asyncDispose]() { events.push("disposed"); throw new Error("SDK cleanup incomplete"); },
        };
      },
      resumeSession() {
        throw new Error("Must not resume unresolved work");
      },
    } as unknown as Pick<LettaAgentClient, "createSession" | "resumeSession">;
    const runner = new AgentSdkTurnRunner(client, "agent", {
      sharingDomain: "local",
      sessionOptions: {},
      execution: { stopped() { events.push("stopped"); } },
    });
    const run = () =>
      runner.runTurn({
        a2aContextId: "context",
        messageId: "message",
        text: "hi",
        signal: new AbortController().signal,
      });
    await expect(run()).rejects.toThrow("SDK cleanup incomplete");
    expect(events).toEqual(["disposed"]);
    expect(runner.unresolvedContexts).toEqual(["context"]);
    await expect(run()).rejects.toThrow("reconciliation");
  });
});

import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
class Session {
  started = deferred();
  finish = deferred();
  disposed = false;
  aborted = false;
  constructor(readonly conversationId: string) {}
  async ready() {
    return { conversationId: this.conversationId };
  }
  async send() {
    this.started.resolve();
  }
  async abort() {
    this.aborted = true;
  }
  async *stream(): AsyncGenerator<SDKMessage> {
    await this.finish.promise;
    yield {
      type: "result",
      success: true,
      result: "done",
      durationMs: 0,
      conversationId: this.conversationId,
      stopReason: this.aborted ? "interrupted" : "end_turn",
    };
  }
  async [Symbol.asyncDispose]() {
    this.disposed = true;
  }
}
function runnerFixture(sessions: Session[]) {
  const opened: string[] = [];
  const take = (id: string) => {
    opened.push(id);
    return sessions.shift()!;
  };
  const client = {
    createSession: take,
    resumeSession: take,
  } as unknown as LettaAgentClient;
  const runner = new AgentSdkTurnRunner(client, "agent", {
    sessionOptions: {},
    sharingDomain: "test",
  });
  const run = (
    messageId: string,
    signal = new AbortController().signal,
    a2aContextId = "context",
  ) =>
    runner.runTurn({
      messageId,
      signal,
      a2aContextId,
      text: messageId,
    });
  return { runner, run, opened };
}

  test("cancellation retains the barrier through asynchronous disposal", async () => {
    const a = new Session("conversation"),
      b = new Session("conversation");
    const disposing = deferred(),
      release = deferred();
    a[Symbol.asyncDispose] = async () => {
      disposing.resolve();
      await release.promise;
      a.disposed = true;
    };
    const { run, opened } = runnerFixture([a, b]);
    const controller = new AbortController();
    const first = run("A", controller.signal);
    const cancelled = assert.rejects(first, /reconciliation/);
    await a.started.promise;
    const second = assert.rejects(run("B"), /reconciliation/);
    controller.abort();
    a.finish.resolve();
    await disposing.promise;
    await setImmediate();
    expect(opened).toEqual(["agent"]);
    release.resolve();
    await cancelled;
    expect(a.disposed).toBe(true);
    await second;
    expect(opened).toEqual(["agent"]);
  });
