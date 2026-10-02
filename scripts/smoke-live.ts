/** Opt-in, Docker-only: node --import tsx scripts/smoke-live.ts local|cloud MODEL
 * Or SMOKE_MODE / SMOKE_MODEL. --check exercises only the independent A2A peer.
 * No dotenv loading, agent lookup by name, model default, or automatic retry.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { Effect, Exit, Scope } from "effect";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, AgentCard, Role, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { startServer } from "../src/server.js";
import { parseConfig } from "../src/config.js";
import { agentMessage, textPart } from "../src/bridge/a2a-text.js";

const report = (stage: string, values: object = {}) => console.log(JSON.stringify({ ...values, stage }));
function safeReason(value: unknown): string {
  let text = typeof value === "string" ? value : "Unknown failure";
  for (const key of [process.env.LETTA_API_KEY, process.env.OPENAI_API_KEY]) {
    if (key) text = text.split(key).join("[REDACTED]");
  }
  return text.slice(0, 600);
}

/** Observe failures without altering session ownership, sends, or disposal. */
function observeResults(client: LettaAgentClient, peerNonce: string) {
  for (const method of ["createSession", "resumeSession"] as const) {
    const open = client[method].bind(client);
    client[method] = (id, options) => {
      const session = open(id, options?.tools ? {
        ...options,
        tools: options.tools.map((tool) => ({
          ...tool,
          execute: async (...args) => {
            report("host_tool_start", { tool: tool.name, callId: args[0] });
            const result = await tool.execute(...args);
            report("host_tool_end", { tool: tool.name, callId: args[0], isError: result.isError ?? false });
            return result;
          },
        })),
      } : options);
      const stream = session.stream.bind(session);
      const seen = new Set<string>();
      session.stream = async function* () {
        for await (const message of stream()) {
          if (message.type === "tool_call" && !seen.has(message.toolCallId)) {
            seen.add(message.toolCallId);
            report("sdk_tool_call", { tool: message.toolName, callId: message.toolCallId });
          }
          if (message.type === "tool_result") report("sdk_tool_result", {
            callId: message.toolCallId, isError: message.isError,
            content: safeReason(message.content.replaceAll(peerNonce, "[PEER_NONCE]")),
          });
          if (message.type === "error") report("sdk_error", {
            code: message.errorCode, stopReason: message.stopReason, reason: safeReason(message.message),
          });
          if (message.type === "result") report("sdk_result", {
            success: message.success, stopReason: message.stopReason, code: message.errorCode,
            ...(message.error ? { reason: safeReason(message.error) } : {}),
          });
          yield message;
        }
      };
      return session;
    };
  }
}
function assert(value: unknown): asserts value { if (!value) throw new Error("fixture assertion failed"); }
const limitMs = 120_000;
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline; outcome may be unknown")), limitMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function peer() {
  // This nonce never appears in any model prompt or public diagnostic output.
  const nonce = randomUUID();
  const receipts: { taskId: string; contextId: string }[] = [];
  const card = AgentCard.fromJSON({
    name: "Disposable deterministic smoke peer", description: "Returns a private receipt nonce",
    version: "1", supportedInterfaces: [{ url: "http://127.0.0.1:0/", protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
  });
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), {
    async execute(request, bus) {
      receipts.push({ taskId: request.taskId, contextId: request.contextId });
      bus.publish(AgentEvent.task({
        id: request.taskId, contextId: request.contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: new Date().toISOString(), message: undefined },
        artifacts: [{ artifactId: randomUUID(), name: "receipt", description: "", parts: [textPart(nonce)], extensions: [], metadata: undefined }],
        history: [], metadata: undefined,
      }));
      bus.finished();
    },
    async cancelTask() { throw new Error("No active peer work"); },
  });
  const app = express();
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const listener = app.listen(0, "127.0.0.1");
  try { await once(listener, "listening"); } catch { listener.close(); throw new Error("peer startup failed"); }
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  card.supportedInterfaces[0]!.url = `${url}/`;
  return { url, nonce, receipts, close: () => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(new Error("peer close failed")) : resolve());
    listener.closeAllConnections();
  }) };
}

function completed(result: SendMessageResult): { text: string; contextId: string } {
  if (!("status" in result && result.status?.state === TaskState.TASK_STATE_COMPLETED)) {
    throw new Error(`Expected completed task; state=${"status" in result ? result.status?.state : "message"}`);
  }
  assert(result.contextId);
  const text = result.artifacts.flatMap((artifact) => artifact.parts)
    .map((part) => part.content?.$case === "text" ? part.content.value : "").join("");
  assert(text.trim());
  return { text, contextId: result.contextId };
}

async function turn(client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>, prompt: string, contextId = "") {
  return completed(await deadline(client.sendMessage({
    tenant: "", metadata: undefined,
    message: { ...agentMessage(prompt, "", contextId), role: Role.ROLE_USER },
    configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
  }, { signal: AbortSignal.timeout(limitMs) })));
}

/** Drain before asserting, so a failed check does not abandon active SDK work. */
async function streamedToolTurn(client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>, prompt: string, contextId: string) {
  let taskId = "", answer = "";
  let artifactUpdates = 0, progressUpdates = 0;
  let complete = false, singleFinalArtifact = true, sawToolProgress = false;
  let progressBeforeAnswer = false;
  for await (const event of client.sendMessageStream({
    tenant: "", metadata: undefined,
    message: { ...agentMessage(prompt, "", contextId), role: Role.ROLE_USER },
    configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
  }, { signal: AbortSignal.timeout(limitMs) })) {
    const payload = event.payload;
    if (payload?.$case === "task") taskId = payload.value.id;
    if (payload?.$case === "statusUpdate") {
      const status = payload.value.status;
      if (status?.state === TaskState.TASK_STATE_WORKING && status.message) {
        progressUpdates++;
        const label = status.message.parts.map((part) => part.content?.$case === "text" ? part.content.value : "").join("");
        if (label.includes("a2a_invoke")) sawToolProgress = true;
      }
      if (status?.state === TaskState.TASK_STATE_COMPLETED) complete = true;
    }
    if (payload?.$case === "artifactUpdate") {
      const update = payload.value;
      artifactUpdates++;
      singleFinalArtifact &&= !update.append && update.lastChunk === true;
      progressBeforeAnswer ||= sawToolProgress;
      answer += update.artifact?.parts.map((part) => part.content?.$case === "text" ? part.content.value : "").join("") ?? "";
    }
  }
  report("streaming", { complete, artifactUpdates, progressUpdates, singleFinalArtifact, sawToolProgress, progressBeforeAnswer });
  assert(taskId && complete && artifactUpdates === 1 && singleFinalArtifact && progressBeforeAnswer);
  const stored = completed(await deadline(client.getTask({ id: taskId, tenant: "", historyLength: 0 })));
  assert(stored.text === answer && stored.contextId === contextId);
  report("streaming_readback", { sameAnswer: true, sameContext: true });
  return stored;
}

async function main() {
  const check = process.argv[2] === "--check";
  const mode = process.argv[2] ?? process.env.SMOKE_MODE;
  const model = process.argv[3] ?? process.env.SMOKE_MODEL;
  if (!check && (!model?.trim() || !["local", "cloud"].includes(mode ?? ""))) {
    report("usage", { invocation: "node --import tsx scripts/smoke-live.ts local|cloud MODEL (or SMOKE_MODE/SMOKE_MODEL); --check" });
    process.exitCode = 2; return;
  }
  if (!check && !(mode === "cloud" ? process.env.LETTA_API_KEY : process.env.OPENAI_API_KEY)) {
    report("missing_required_env"); process.exitCode = 2; return;
  }
  let stage = "peer";
  let createdId: string | undefined;
  let deletedId: string | undefined;
  let deleteAcknowledgedId: string | undefined;
  let creationPending = false;
  let startupPending = false;
  const cleanupFailures: string[] = [];
  let client: LettaAgentClient | undefined;
  let scope: Scope.Closeable | undefined;
  let endpoint: Awaited<ReturnType<typeof peer>> | undefined;
  let home: string | undefined;
  let scopeClosed = true;
  // Hard cap includes uncertain promises and cleanup. A timeout never asserts
  // cancellation or deletion; late create outcomes are never blindly retried.
  const watchdog = setTimeout(() => {
    report("total_deadline", { interruptedStage: stage, createdId, deletedId, deleteAcknowledgedId,
      creationOutcomeUnknown: creationPending, cleanupComplete: false });
    process.exit(1);
  }, 10 * 60_000);
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await deadline(work()); return true; }
    catch (error) {
      cleanupFailures.push(name);
      report("cleanup_error", { resource: name, reason: safeReason(error instanceof Error ? error.message : error) });
      return false;
    }
  };
  try {
    endpoint = await peer();
    if (check) {
      const remote = await deadline(new ClientFactory().createFromUrl(endpoint.url));
      const answer = await turn(remote, "fixture receipt");
      assert(answer.text === endpoint.nonce && endpoint.receipts.length === 1);
      report("fixture_check", { completed: true, discovery: true, peerReceipts: 1, modelCalls: 0 });
      return;
    }
    // Set a fresh container HOME before importing/bootstrap of the Letta SDK.
    home = await mkdtemp(join(tmpdir(), "letta-smoke-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_CACHE_HOME = join(home, ".cache");
    const { LettaAgentClient: ActualClient } = await import("@letta-ai/letta-agent-sdk");
    client = new ActualClient(mode === "cloud" ? {
      backend: "cloud", apiKey: process.env.LETTA_API_KEY!, requestTimeoutMs: limitMs,
      sandbox: { ttlMinutes: 5, terminateOnClose: true, readyTimeoutMs: limitMs },
    } : { backend: "local", appServer: { harnessBackend: "local", pinGlobalAgent: false, requestTimeoutMs: limitMs, startupTimeoutMs: limitMs } });
    observeResults(client, endpoint.nonce);
    stage = "create";
    creationPending = true;
    const name = `a2a-smoke-${randomUUID()}`;
    report("creation_intent", { mode, model, name });
    // Capture ownership immediately on settlement, including a late timeout.
    createdId = await deadline(client.createAgent({
      // The local SDK list API excludes hidden agents and has no includeHidden
      // option. A visible agent in this isolated HOME permits verified deletion.
      name, model: model!, hidden: mode === "cloud", memfs: false, baseTools: [],
      persona: "You are a disposable smoke worker. Answer briefly. Remember supplied tokens in conversation. When asked to delegate, call a2a_invoke exactly once with target smoke_peer and report its returned token. Never invent a peer result or use other tools.",
    }).then((id) => { createdId = id; creationPending = false; return id; }));
    report("created", { createdId });
    stage = "server";
    scope = await Effect.runPromise(Scope.make());
    scopeClosed = false;
    startupPending = true;
    const server = await deadline(Effect.runPromise(startServer(parseConfig({
      agentId: createdId, backend: { type: mode! }, port: 0, publicUrl: "http://127.0.0.1:0",
      peers: { smoke_peer: endpoint.url },
    }), client).pipe(Effect.provideService(Scope.Scope, scope))).finally(() => { startupPending = false; }));
    stage = "discovery";
    const remote = await deadline(new ClientFactory().createFromUrl(server.url));
    report(stage, { ok: true });
    stage = "answer";
    const recall = randomUUID();
    const first = await turn(remote, `Remember token ${recall}. Reply with SMOKE_READY and the token.`);
    assert(first.text.includes("SMOKE_READY") && first.text.includes(recall));
    report(stage, { completed: true, contextId: first.contextId });
    stage = "continuation";
    const second = await turn(remote, "Return only the token I asked you to remember in the previous turn.", first.contextId);
    assert(second.contextId === first.contextId && second.text.includes(recall));
    report(stage, { completed: true, sameContext: true });
    stage = "delegation";
    const third = await streamedToolTurn(remote, "Call a2a_invoke exactly once with target smoke_peer and message receipt. Report only the token returned by the peer.", first.contextId);
    if (endpoint.receipts.length !== 1 || !third.text.includes(endpoint.nonce)) report("delegation_mismatch", {
      peerReceipts: endpoint.receipts.length,
      sameContext: third.contextId === first.contextId,
      reply: safeReason(third.text.replaceAll(endpoint.nonce, "[PEER_NONCE]").replaceAll(recall, "[RECALL_NONCE]")),
    });
    assert(third.contextId === first.contextId && endpoint.receipts.length === 1 && third.text.includes(endpoint.nonce));
    report(stage, { completed: true, sameContext: true, peerReceipts: endpoint.receipts });
  } catch (error) {
    report("failed", { failedStage: stage, reason: safeReason(error instanceof Error ? error.message : error), createdId, creationOutcomeUnknown: creationPending, executionMayBeActive: stage !== "peer" && stage !== "create" });
    process.exitCode = 1;
  } finally {
    if (scope) scopeClosed = await cleanup("server_scope", () => Effect.runPromise(Scope.close(scope!, Exit.void)));
    // Never delete while server/session ownership is unresolved.
    if (createdId && client && scopeClosed && !creationPending && !startupPending) {
      const id = createdId;
      await cleanup("agent_delete_verify", async () => {
        // The installed SDK has no includeHidden list option. Prove that its
        // unfiltered local listing exposes this hidden ID before trusting
        // absence afterward. This fresh HOME has no preexisting local agents.
        const locallyVisible = mode === "local"
          ? await client!.agents.list().then((agents) => agents.some((agent) => agent.id === id), () => false)
          : false;
        await client!.agents.delete(id);
        deleteAcknowledgedId = id;
        if (mode === "local" && locallyVisible) {
          const remaining = await client!.agents.list();
          assert(!remaining.some((agent) => agent.id === id));
          deletedId = id;
          return;
        }
        try { await client!.agents.retrieve(id); }
        catch (error) {
          // Only an explicit public API 404 establishes exact-ID absence.
          if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
            deletedId = id; return;
          }
          throw new Error("deletion verification unknown");
        }
        throw new Error("agent still retrievable");
      });
    } else if (createdId || creationPending) cleanupFailures.push("agent_retained_execution_or_creation_unknown");
    if (client) await cleanup("sdk_client", () => client!.close());
    if (endpoint) await cleanup("peer_listener", endpoint.close);
    if (home && scopeClosed && !cleanupFailures.length) await cleanup("temp_home", () => rm(home!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    report("cleanup", { createdId, deletedId, deleteAcknowledgedId, creationOutcomeUnknown: creationPending, cleanupFailures,
      sandboxTermination: mode === "cloud" ? "SDK best-effort; not independently confirmed" : "not applicable" });
    if (cleanupFailures.length) process.exitCode = 1;
    // Keep the cap armed when unsettled promises could keep this process alive.
    if (!creationPending && !startupPending && !cleanupFailures.length) clearTimeout(watchdog);
    else watchdog.unref();
  }
}
await main().catch(() => { report("fixture_failed"); process.exitCode = 1; });
