/** Opt-in, Docker-only: node --import tsx scripts/smoke-live.ts local|remote|cloud|computer MODEL
 * Remote starts an isolated authenticated native App Server; computer needs SMOKE_COMPUTER_DEVICE_ID.
 * Or SMOKE_MODE / SMOKE_MODEL. --check exercises only the independent A2A peer.
 * No dotenv loading, agent lookup by name, model default, or automatic retry.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { Effect, Exit, Scope } from "effect";
import { A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, AgentCard, Role, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler } from "@a2a-js/sdk/server/express";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { startServer } from "../src/server.js";
import { parseConfig, sdkOptions, type ServerConfig } from "../src/config.js";
import { agentMessage, textPart } from "../src/bridge/a2a-text.js";

const report = (stage: string, values: object = {}) => console.log(JSON.stringify({ ...values, stage }));
function safeReason(value: unknown): string {
  let text = typeof value === "string" ? value : "Unknown failure";
  for (const key of [process.env.LETTA_API_KEY, process.env.OPENAI_API_KEY, process.env.SMOKE_REMOTE_TOKEN, process.env.SMOKE_PEER_TOKEN]) {
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
function assert(value: unknown, message = "fixture assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const limitMs = 120_000;
type Mode = "local" | "remote" | "cloud" | "computer";
function modeFromArgs(value: string | undefined): Mode | undefined {
  return value === "local" || value === "remote" || value === "cloud" || value === "computer" ? value : undefined;
}
function bearerPeerKey() { return randomUUID() + randomUUID(); }
function privateAppServerUrl(output: string): string | undefined {
  return output.match(/^WebSocket:\s+(ws:\/\/127\.0\.0\.1:\d+(?:\/ws)?)\s*$/m)?.[1];
}
function versionAtLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const parse = (value: string) => value.replace(/^v/i, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const left = parse(actual), right = parse(minimum);
  if (left.some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}
function backendForMode(mode: Mode, remoteUrl = "ws://127.0.0.1:45001", computerId = "fixture-device"): ServerConfig["backend"] {
  if (mode === "remote") return { type: "remote", url: remoteUrl, tokenEnv: "SMOKE_REMOTE_TOKEN" };
  if (mode === "computer") return { type: "cloud", apiKeyEnv: "LETTA_API_KEY", computer: { deviceId: computerId } };
  if (mode === "cloud") return { type: "cloud", apiKeyEnv: "LETTA_API_KEY" };
  return { type: "local", harnessBackend: "local" };
}
function configurationForMode(mode: Mode, agentId = "fixture-agent", remoteUrl?: string, computerId?: string) {
  return parseConfig({ agentId, backend: backendForMode(mode, remoteUrl, computerId), port: 0, publicUrl: "http://127.0.0.1:0" });
}
function checkBackendConfigurationPaths() {
  assert(privateAppServerUrl("Listening on ws://127.0.0.1:45001\nWebSocket: ws://127.0.0.1:45001/ws\n") === "ws://127.0.0.1:45001/ws");
  const fixtureEnv = { LETTA_API_KEY: "fixture-cloud-key", SMOKE_REMOTE_TOKEN: "fixture-remote-token" };
  for (const mode of ["local", "remote", "cloud", "computer"] as const) {
    const config = configurationForMode(mode);
    const options = sdkOptions(config.backend, fixtureEnv);
    assert(options);
    if (mode === "local") assert(options.backend === "local");
    if (mode === "remote") assert(options.backend === "remote" && options.url === "ws://127.0.0.1:45001" && options.authToken === fixtureEnv.SMOKE_REMOTE_TOKEN);
    if (mode === "cloud") assert(options.backend === "cloud" && !options.computer);
    if (mode === "computer") assert(options.backend === "cloud" && typeof options.computer === "object" && options.computer !== null && "deviceId" in options.computer && options.computer.deviceId === "fixture-device");
  }
}

async function waitForChildExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await deadline(new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  }));
}

/** Start the documented native CLI server, owned by this fixture alone. */
async function startPrivateAppServer(home: string): Promise<{ url: string; token: string; stop: () => Promise<void> }> {
  const token = bearerPeerKey();
  const tokenFile = join(home, "app-server-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const cli = process.env.SMOKE_LETTA_CLI ?? "/app/node_modules/@letta-ai/letta-code/letta.js";
  const child = spawn(process.execPath, [cli, "--backend", "local", "server", "--listen", "--ws-auth", "capability-token", "--ws-token-file", tokenFile], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), LETTA_API_KEY: process.env.LETTA_API_KEY ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  let url = "";
  try {
    await deadline((async () => {
      while (child.exitCode === null && child.signalCode === null) {
        const listening = privateAppServerUrl(output);
        if (listening) { url = listening; return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // The local token is not yet registered in the fixture's redaction env.
      // Never forward the raw native startup log, even on early failure.
      throw new Error(`native App Server exited during startup (${child.exitCode ?? child.signalCode})`);
    })());
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try { await waitForChildExit(child); }
    catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForChildExit(child);
    }
    await rm(tokenFile, { force: true });
    throw error;
  }
  return { url, token, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    try { await waitForChildExit(child); }
    catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await waitForChildExit(child);
    }
    await rm(tokenFile, { force: true });
  } };
}

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
  const token = randomUUID() + randomUUID();
  const receipts: { taskId: string; contextId: string }[] = [];
  const card = AgentCard.fromJSON({
    name: "Disposable deterministic smoke peer", description: "Returns a private receipt nonce",
    version: "1", supportedInterfaces: [{ url: "http://127.0.0.1:0/", protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          description: "Bearer token authentication",
          bearerFormat: "opaque",
        },
      },
    },
    securityRequirements: [{ schemes: { bearer: [] } }],
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
  app.use((request, response, next) => {
    if (request.headers.authorization !== `Bearer ${token}`) return response.sendStatus(401);
    next();
  });
  app.use(`/${AGENT_CARD_PATH}`, (_request, response) => {
    // Match the production protected-card path: SDK 1.1's convenience handler
    // sends its internal object shape rather than canonical ProtoJSON.
    response.setHeader("Cache-Control", "private, no-store");
    response.json(AgentCard.toJSON(card));
  });
  app.use(jsonRpcHandler({ requestHandler: handler, userBuilder: async () => ({
    get isAuthenticated() { return true; }, get userName() { return "smoke-fixture"; },
  }) }));
  const listener = app.listen(0, "127.0.0.1");
  try { await once(listener, "listening"); } catch { listener.close(); throw new Error("peer startup failed"); }
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  card.supportedInterfaces[0]!.url = `${url}/`;
  return { url, nonce, token, receipts, close: () => new Promise<void>((resolve, reject) => {
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
function peerClient(token: string) {
  const fetchWithBearer: typeof fetch = Object.assign((input: string | Request | URL, init?: RequestInit) => fetch(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` },
  }), { preconnect: fetch.preconnect });
  return new ClientFactory({
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchWithBearer }),
    transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithBearer })],
  });
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
  const mode = modeFromArgs(process.argv[2]) ?? modeFromArgs(process.env.SMOKE_MODE);
  const model = process.argv[3] ?? process.env.SMOKE_MODEL;
  if (!check && (!model?.trim() || !mode)) {
    report("usage", { invocation: "node --import tsx scripts/smoke-live.ts local|remote|cloud|computer MODEL (or SMOKE_MODE/SMOKE_MODEL); --check", computerIdEnv: "SMOKE_COMPUTER_DEVICE_ID", cwdEnv: "SMOKE_CWD" });
    process.exitCode = 2; return;
  }
  if (!check && !((mode === "cloud" || mode === "computer") ? process.env.LETTA_API_KEY : (mode === "local" || mode === "remote") ? process.env.OPENAI_API_KEY : false)) {
    report("missing_required_env"); process.exitCode = 2; return;
  }
  if (!check && mode === "computer" && !process.env.SMOKE_COMPUTER_DEVICE_ID) { report("missing_computer_selection"); process.exitCode = 2; return; }
  let stage = "peer";
  let createdId: string | undefined;
  let deletedId: string | undefined;
  let deleteAcknowledgedId: string | undefined;
  let creationPending = false;
  let startupPending = false;
  let executionMayBeActive = false;
  const cleanupFailures: string[] = [];
  let client: LettaAgentClient | undefined;
  let scope: Scope.Closeable | undefined;
  let endpoint: Awaited<ReturnType<typeof peer>> | undefined;
  let home: string | undefined;
  let privateAppServer: Awaited<ReturnType<typeof startPrivateAppServer>> | undefined;
  let peerTokenWasSet = false;
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
    checkBackendConfigurationPaths();
    endpoint = await peer();
    process.env.SMOKE_PEER_TOKEN = endpoint.token;
    peerTokenWasSet = true;
    if (check) {
      for (const [path, method] of [[`/${AGENT_CARD_PATH}`, "GET"], ["/", "POST"]] as const) {
        const denied = await fetch(`${endpoint.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${randomUUID()}`, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
          signal: AbortSignal.timeout(limitMs),
        });
        assert(denied.status === 401, `Peer ${method} endpoint must reject an incorrect Bearer token`);
        await denied.arrayBuffer();
      }
      let refused = false;
      try {
        const wrong = await deadline(peerClient(randomUUID()).createFromUrl(endpoint.url));
        await turn(wrong, "fixture receipt");
      } catch { refused = true; }
      assert(refused && endpoint.receipts.length === 0);
      const advertisedCardResponse = await fetch(`${endpoint.url}/${AGENT_CARD_PATH}`, {
        headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(limitMs),
      });
      assert(advertisedCardResponse.ok);
      assert(advertisedCardResponse.headers.get("cache-control") === "private, no-store");
      const advertisedCard = AgentCard.fromJSON(await advertisedCardResponse.json());
      const bearer = advertisedCard.securitySchemes.bearer?.scheme;
      assert(
        bearer?.$case === "httpAuthSecurityScheme" && bearer.value.scheme.toLowerCase() === "bearer",
        "Peer Agent Card must advertise a populated HTTP Bearer security scheme",
      );
      assert(
        advertisedCard.securityRequirements.some((requirement) => Object.hasOwn(requirement.schemes, "bearer")),
        "Peer Agent Card must require its advertised Bearer scheme",
      );
      const remote = await deadline(peerClient(endpoint.token).createFromUrl(endpoint.url));
      const answer = await turn(remote, "fixture receipt");
      assert(answer.text === endpoint.nonce && Number(endpoint.receipts.length) === 1);
      report("fixture_check", { completed: true, configModes: 4, discovery: true, peerBearer: true, peerSecurityAdvertisement: true, wrongTokenRefused: true, peerReceipts: 1, modelCalls: 0 });
      return;
    }
    assert(mode);
    // Set a fresh container HOME before importing/bootstrap of the Letta SDK.
    home = await mkdtemp(join(tmpdir(), "letta-smoke-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    process.env.XDG_CACHE_HOME = join(home, ".cache");
    const { LettaAgentClient: ActualClient } = await import("@letta-ai/letta-agent-sdk");
    if (mode === "remote") {
      stage = "remote_app_server";
      privateAppServer = await startPrivateAppServer(home);
      process.env.SMOKE_REMOTE_URL = privateAppServer.url;
      process.env.SMOKE_REMOTE_TOKEN = privateAppServer.token;
      report("remote_app_server", { started: true, url: privateAppServer.url, owner: "fixture", auth: "capability-token" });
    }
    const backendConfig = backendForMode(mode,
      mode === "remote" ? privateAppServer?.url : undefined,
      mode === "computer" ? process.env.SMOKE_COMPUTER_DEVICE_ID : undefined);
    const sdkConfig = sdkOptions(backendConfig, process.env);
    assert(sdkConfig);
    if (mode === "local") {
      assert(sdkConfig.backend === "local");
      client = new ActualClient({ ...sdkConfig, appServer: { ...sdkConfig.appServer, requestTimeoutMs: limitMs, startupTimeoutMs: limitMs } });
    } else if (mode === "remote") {
      assert(sdkConfig.backend === "remote");
      client = new ActualClient({ ...sdkConfig, requestTimeoutMs: limitMs, pinGlobalAgent: false });
    } else {
      assert(sdkConfig.backend === "cloud");
      client = new ActualClient({ ...sdkConfig, requestTimeoutMs: limitMs,
        ...(mode === "cloud" ? { sandbox: { ttlMinutes: 5, terminateOnClose: true, readyTimeoutMs: limitMs } } : {}) });
    }
    observeResults(client, endpoint.nonce);
    if (mode === "computer") {
      stage = "computer_preflight";
      const { computer: selected } = await deadline(client.computers.resolve({ deviceId: process.env.SMOKE_COMPUTER_DEVICE_ID! }));
      if (!selected) throw new Error("selected computer metadata is unavailable; refusing execution");
      const codeVersion = selected.metadata?.lettaCodeVersion;
      const runtimeNodeVersion = selected.metadata?.nodeVersion;
      report("selected_computer_preflight", { online: selected.status === "online", deviceId: selected.deviceId, lettaCodeVersion: codeVersion, nodeVersion: runtimeNodeVersion });
      if (selected.status !== "online" || !versionAtLeast(codeVersion, "0.34.2")) {
        throw new Error("selected computer is offline or its Letta Code version is below the supported minimum 0.34.2");
      }
    }
    stage = "create";
    creationPending = true;
    const name = `a2a-smoke-${randomUUID()}`;
    report("creation_intent", { mode, model, name });
    // Capture ownership immediately on settlement, including a late timeout.
    createdId = await deadline(client.createAgent({
      // The local SDK list API excludes hidden agents and has no includeHidden
      // option. A visible agent in this isolated HOME permits verified deletion.
      name, model: model!, hidden: mode === "cloud" || mode === "computer", memfs: false, baseTools: [],
      persona: "You are a disposable smoke worker. Answer briefly. Remember supplied tokens in conversation. When asked to delegate, call a2a_invoke exactly once with target smoke_peer and report its returned token. Never invent a peer result or use other tools.",
    }).then((id) => { createdId = id; creationPending = false; return id; }));
    report("created", { createdId });
    if (mode === "remote") {
      const rejected = new ActualClient({ backend: "remote", url: privateAppServer!.url, authToken: randomUUID(), requestTimeoutMs: limitMs, pinGlobalAgent: false });
      const rejectedSession = rejected.resumeSession(createdId!);
      let wrongTokenRefused = false;
      try { await deadline(rejectedSession.ready()); } catch { wrongTokenRefused = true; }
      rejectedSession.close();
      await rejected.close();
      assert(wrongTokenRefused);
      report("remote_auth", { wrongTokenRefused: true });
      // Remote SDK management clients snapshot the agent list; refresh after creation.
      const { LettaAgentClient: FreshClient } = await import("@letta-ai/letta-agent-sdk");
      const fresh = new FreshClient({ backend: "remote", url: process.env.SMOKE_REMOTE_URL!, ...(process.env.SMOKE_REMOTE_TOKEN ? { authToken: process.env.SMOKE_REMOTE_TOKEN } : {}), requestTimeoutMs: limitMs, pinGlobalAgent: false });
      await client.close();
      client = fresh;
      observeResults(client, endpoint.nonce);
      const readiness = client.resumeSession(createdId!);
      try {
        const ready = await deadline(readiness.ready());
        const status = await deadline(readiness.getDeviceStatus({ timeoutMs: limitMs }));
        report("remote_sdk_readiness", { ready: true, deviceStatusReadback: true, agentIdMatches: ready.agentId === createdId, online: status.isOnline, processing: status.isProcessing });
      } finally { readiness.close(); }
    }
    stage = "server";
    scope = await Effect.runPromise(Scope.make());
    scopeClosed = false;
    startupPending = true;
    const serverConfig = parseConfig({
      agentId: createdId, backend: backendConfig, port: 0, publicUrl: "http://127.0.0.1:0",
      ...(process.env.SMOKE_CWD ? { cwd: process.env.SMOKE_CWD } : {}),
      peers: { smoke_peer: { url: endpoint.url, auth: { tokenEnv: "SMOKE_PEER_TOKEN", owner: "smoke-fixture" } } },
    });
    const server = await deadline(Effect.runPromise(startServer(serverConfig, client).pipe(Effect.provideService(Scope.Scope, scope))).finally(() => { startupPending = false; }));
    stage = "discovery";
    const remote = await deadline(new ClientFactory().createFromUrl(server.url));
    report(stage, { ok: true });
    stage = "answer";
    const recall = randomUUID();
    executionMayBeActive = true;
    const first = await turn(remote, `Remember token ${recall}. Reply with SMOKE_READY and the token.`);
    executionMayBeActive = false;
    assert(first.text.includes("SMOKE_READY") && first.text.includes(recall));
    report(stage, { completed: true, contextId: first.contextId });
    stage = "continuation";
    executionMayBeActive = true;
    const second = await turn(remote, "Return only the token I asked you to remember in the previous turn.", first.contextId);
    executionMayBeActive = false;
    assert(second.contextId === first.contextId && second.text.includes(recall));
    report(stage, { completed: true, sameContext: true });
    stage = "delegation";
    executionMayBeActive = true;
    const third = await streamedToolTurn(remote, "Call a2a_invoke exactly once with target smoke_peer and message receipt. Report only the token returned by the peer.", first.contextId);
    executionMayBeActive = false;
    if (endpoint.receipts.length !== 1 || !third.text.includes(endpoint.nonce)) report("delegation_mismatch", {
      peerReceipts: endpoint.receipts.length,
      sameContext: third.contextId === first.contextId,
      reply: safeReason(third.text.replaceAll(endpoint.nonce, "[PEER_NONCE]").replaceAll(recall, "[RECALL_NONCE]")),
    });
    assert(third.contextId === first.contextId && endpoint.receipts.length === 1 && third.text.includes(endpoint.nonce));
    report(stage, { completed: true, sameContext: true, peerReceipts: endpoint.receipts });
  } catch (error) {
    report("failed", { failedStage: stage, reason: safeReason(error instanceof Error ? error.message : error), createdId, creationOutcomeUnknown: creationPending, executionMayBeActive });
    process.exitCode = 1;
  } finally {
    if (scope) scopeClosed = await cleanup("server_scope", () => Effect.runPromise(Scope.close(scope!, Exit.void)));
    // Never delete while server/session ownership is unresolved.
    if (createdId && client && scopeClosed && !creationPending && !startupPending && !executionMayBeActive) {
      const id = createdId;
      await cleanup("agent_delete_verify", async () => {
        // The installed SDK has no includeHidden list option. Prove that its
        // unfiltered local listing exposes this exact ID before trusting
        // absence afterward. Both local-state fixtures own a fresh HOME; the
        // private remote App Server explicitly runs with --backend local.
        // Its WebSocket management adapter does not preserve HTTP 404 status.
        const localState = mode === "local" || mode === "remote";
        const locallyVisible = localState
          ? await client!.agents.list().then((agents) => agents.some((agent) => agent.id === id), () => false)
          : false;
        await client!.agents.delete(id);
        deleteAcknowledgedId = id;
        if (localState && locallyVisible) {
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
    } else if (createdId || creationPending) cleanupFailures.push(executionMayBeActive ? "agent_retained_execution_outcome_unknown" : "agent_retained_execution_or_creation_unknown");
    if (client) await cleanup("sdk_client", () => client!.close());
    if (privateAppServer) await cleanup("private_app_server", privateAppServer.stop);
    if (endpoint) await cleanup("peer_listener", endpoint.close);
    if (peerTokenWasSet) Reflect.deleteProperty(process.env, "SMOKE_PEER_TOKEN");
    if (privateAppServer) { Reflect.deleteProperty(process.env, "SMOKE_REMOTE_TOKEN"); Reflect.deleteProperty(process.env, "SMOKE_REMOTE_URL"); }
    if (home && scopeClosed && !cleanupFailures.length) await cleanup("temp_home", () => rm(home!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    report("cleanup", { createdId, deletedId, deleteAcknowledgedId, creationOutcomeUnknown: creationPending, executionMayBeActive, cleanupFailures,
      sandboxTermination: mode === "cloud" ? "SDK best-effort; not independently confirmed" : "not applicable",
      execution: mode === "computer" ? { kind: "cloud-computer", deviceId: process.env.SMOKE_COMPUTER_DEVICE_ID } : mode === "cloud" ? { kind: "cloud-managed-sandbox" } : { kind: mode } });
    if (cleanupFailures.length) process.exitCode = 1;
    // Keep the cap armed when unsettled promises could keep this process alive.
    if (!creationPending && !startupPending && !cleanupFailures.length) clearTimeout(watchdog);
    else watchdog.unref();
  }
}
await main().catch(() => { report("fixture_failed"); process.exitCode = 1; });
