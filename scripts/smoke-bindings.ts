/** Opt-in local-backend check: two disposable agents behind one listener.
 * Run inside Docker: node --import tsx scripts/smoke-bindings.ts MODEL
 * Requires OPENAI_API_KEY. Never adopts existing agents or host Letta state.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { Role, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { parseApplicationConfig } from "../src/config.js";
import { startApplicationServer } from "../src/server.js";
import { createOfficialClientProvider } from "../src/client/index.js";
import { agentMessage } from "../src/bridge/a2a-text.js";

const report = (stage: string, details: object = {}) => console.log(JSON.stringify({ stage, ...details }));
const limitMs = 120_000;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function deadline<A>(work: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Operation timed out; outcome may be unknown")), limitMs);
    })]);
  } finally { clearTimeout(timer); }
}
function completed(result: SendMessageResult) {
  assert("status" in result && result.status?.state === TaskState.TASK_STATE_COMPLETED, "Expected a completed task");
  const text = result.artifacts.flatMap((artifact) => artifact.parts)
    .map((part) => part.content?.$case === "text" ? part.content.value : "").join("");
  return { id: result.id, contextId: result.contextId, text };
}

async function main() {
  const model = process.argv[2];
  if (!model?.trim() || !process.env.OPENAI_API_KEY) {
    report("usage", { command: "node --import tsx scripts/smoke-bindings.ts MODEL", requires: "OPENAI_API_KEY" });
    process.exitCode = 2;
    return;
  }
  const ids: string[] = [];
  const deleted: string[] = [];
  const cleanupFailures: string[] = [];
  let creating = false, starting = false, scopeClosed = true;
  let stage = "setup";
  let home: string | undefined;
  let provisioner: LettaAgentClient | undefined;
  let scope: Scope.Closeable | undefined;
  const watchdog = setTimeout(() => {
    report("total_deadline", { stage, ids, deleted, creating, starting, cleanupComplete: false });
    process.exit(1);
  }, 10 * 60_000);
  const cleanup = async (name: string, action: () => Promise<unknown>) => {
    try { await deadline(action()); return true; }
    catch { cleanupFailures.push(name); return false; }
  };
  try {
    home = await mkdtemp(join(tmpdir(), "letta-bindings-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_CACHE_HOME = join(home, ".cache");
    const { LettaAgentClient: ActualClient } = await import("@letta-ai/letta-agent-sdk");
    const options = {
      backend: "local" as const,
      appServer: { harnessBackend: "local" as const, pinGlobalAgent: false, requestTimeoutMs: limitMs, startupTimeoutMs: limitMs },
    };
    provisioner = new ActualClient(options);
    stage = "bootstrap";
    assert((await deadline(provisioner.agents.list())).length === 0, "Temporary backend is not empty");
    // SDK 0.8.28's already-open local management connection does not see agents
    // created by a separate creation session. Do not reuse the preflight view
    // for deletion verification; the next management connection opens afterward.
    await deadline(provisioner.close());
    provisioner = new ActualClient(options);
    for (const label of ["first", "second"]) {
      stage = `create_${label}`;
      const name = `a2a-bindings-${label}-${randomUUID()}`;
      report("creation_intent", { name, model });
      creating = true;
      await deadline(provisioner.createAgent({
        name, model, hidden: false, memfs: false, baseTools: [],
        persona: "You are a disposable test agent. Remember the supplied token in this conversation. Reply with the requested token only. Do not use tools.",
      }).then((id) => { ids.push(id); creating = false; report("created", { label, id }); }));
    }
    const firstToken = randomUUID(), secondToken = randomUUID();
    process.env.BINDINGS_FIRST_TOKEN = firstToken;
    process.env.BINDINGS_SECOND_TOKEN = secondToken;
    const config = parseApplicationConfig({
      port: 0, publicUrl: "http://127.0.0.1:0/agents/",
      connections: { local: { type: "local", harnessBackend: "local" } },
      bindings: {
        first: { path: "/first", connection: "local", agentId: ids[0], name: "First smoke agent", auth: { tokenEnv: "BINDINGS_FIRST_TOKEN", owner: "smoke-operator" } },
        second: { path: "/second", connection: "local", agentId: ids[1], name: "Second smoke agent", auth: { tokenEnv: "BINDINGS_SECOND_TOKEN", owner: "smoke-operator" } },
      },
    });
    stage = "start";
    scope = await Effect.runPromise(Scope.make());
    scopeClosed = false;
    starting = true;
    const server = await deadline(Effect.runPromise(startApplicationServer(config, () => new ActualClient(options))
      .pipe(Effect.provideService(Scope.Scope, scope))).finally(() => { starting = false; }));
    const urls = [server.bindings.first!, server.bindings.second!];
    const tokens = [firstToken, secondToken];
    const agents = [];
    for (const [index, url] of urls.entries()) {
      stage = `discovery_${index}`;
      const origin = new URL(url).origin;
      const owner = `smoke-caller-${index}`;
      const provider = createOfficialClientProvider({ policies: {
        [url]: {
          destinationOrigins: [origin], peerIdentity: `smoke-binding-${index}`,
          credential: {
            owner, audience: url, origins: [origin], headerNames: ["Authorization"],
            provide: async () => ({ owner, audience: url, headers: { Authorization: `Bearer ${tokens[index]!}` } }),
          },
        },
      } });
      const cardUrl = `${url.replace(/\/$/, "")}/.well-known/agent-card.json`;
      const unauthorized = await fetch(cardUrl, { signal: AbortSignal.timeout(limitMs) });
      assert(unauthorized.status === 401, "Discovery must require authentication");
      await unauthorized.body?.cancel();
      const wrong = await fetch(cardUrl, { headers: { Authorization: `Bearer ${tokens[1 - index]!}` }, signal: AbortSignal.timeout(limitMs) });
      assert(wrong.status === 401, "Another binding's token must not grant discovery");
      await wrong.body?.cancel();
      agents.push(await provider(url, AbortSignal.timeout(limitMs)));
    }
    report("discovery", { bindings: agents.length, sharedListener: new URL(urls[0]!).origin === new URL(urls[1]!).origin, prefix: "/agents/", protected: true });
    const contextId = randomUUID(), messageId = randomUUID();
    const recallTokens = [randomUUID(), randomUUID()];
    const tasks: string[] = [];
    for (const [index, remote] of agents.entries()) {
      stage = `answer_${index}`;
      const result = completed(await remote.sendMessage({
        tenant: "", metadata: undefined,
        message: { ...agentMessage(`Our token is ${recallTokens[index]}. Reply with that token only.`, "", contextId), messageId, role: Role.ROLE_USER },
        configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
      }, { signal: AbortSignal.timeout(limitMs) }));
      assert(result.contextId === contextId && result.text.includes(recallTokens[index]!), "Binding returned an incorrect token/context");
      tasks.push(result.id);
    }
    for (const [index, remote] of agents.entries()) {
      stage = `recall_${index}`;
      const result = completed(await remote.sendMessage({
        tenant: "", metadata: undefined,
        message: { ...agentMessage("Return only our conversation token.", "", contextId), role: Role.ROLE_USER },
        configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
      }, { signal: AbortSignal.timeout(limitMs) }));
      assert(result.text.includes(recallTokens[index]!) && !result.text.includes(recallTokens[1 - index]!), "Conversation context crossed bindings");
      const response = await fetch(urls[index]!, {
        method: "POST", headers: { "Content-Type": "application/json", "A2A-Version": "1.0", Authorization: `Bearer ${tokens[index]!}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "GetTask", params: { id: tasks[1 - index] } }),
        signal: AbortSignal.timeout(limitMs),
      });
      const body = await response.json() as { error?: { code?: number }; result?: unknown };
      assert(body.error?.code === -32001 && body.result === undefined, "Cross-binding task lookup did not fail as TaskNotFound");
    }
    report("isolation", { existingAgents: ids.length, sameMessageId: true, sameContextId: true, separateRecall: true, crossTaskDenied: true });
  } catch {
    // Never print raw SDK/HTTP errors: they can contain credentials or prompts.
    report("failed", { stage, ids, creating, starting });
    process.exitCode = 1;
  } finally {
    if (scope) scopeClosed = await cleanup("server_scope", () => Effect.runPromise(Scope.close(scope!, Exit.void)));
    if (provisioner && scopeClosed && !creating && !starting) {
      for (const id of ids) await cleanup(`agent:${id}`, async () => {
        assert((await provisioner!.agents.list()).some((agent) => agent.id === id), "Cannot verify pre-delete visibility");
        await provisioner!.agents.delete(id);
        assert(!(await provisioner!.agents.list()).some((agent) => agent.id === id), "Agent still present after deletion");
        deleted.push(id);
      });
    } else if (ids.length || creating) cleanupFailures.push("agents_retained_execution_or_creation_unknown");
    if (provisioner) await cleanup("provisioner", () => provisioner!.close());
    if (home && scopeClosed && !cleanupFailures.length) await cleanup("temp_home", () => rm(home!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    Reflect.deleteProperty(process.env, "BINDINGS_FIRST_TOKEN");
    Reflect.deleteProperty(process.env, "BINDINGS_SECOND_TOKEN");
    report("cleanup", { ids, deleted, creating, starting, cleanupFailures });
    if (cleanupFailures.length) process.exitCode = 1;
    if (!creating && !starting && !cleanupFailures.length) clearTimeout(watchdog);
    else watchdog.unref();
  }
}
await main().catch(() => { report("fixture_failed"); process.exitCode = 1; });
