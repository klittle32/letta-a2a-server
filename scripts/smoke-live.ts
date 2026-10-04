/** Opt-in, Docker-only: node --import tsx scripts/smoke-live.ts local|remote|cloud|computer MODEL
 * Remote starts an isolated authenticated native App Server; computer needs SMOKE_COMPUTER_DEVICE_ID.
 * Or SMOKE_MODE / SMOKE_MODEL. --check proves the inbound application path with a fake SDK.
 * No dotenv loading, agent lookup by name, model default, or automatic retry.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Effect, Exit, Scope } from "effect";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { Role, TaskState, type SendMessageResult } from "@a2a-js/sdk";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { startApplicationServer, startServer } from "../src/server.js";
import { parseApplicationConfig, parseConfig, sdkOptions, type ServerConfig } from "../src/config.js";
import { agentMessage } from "../src/bridge/a2a-text.js";

const report = (stage: string, values: object = {}) => console.log(JSON.stringify({ ...values, stage }));
function safeReason(value: unknown, privateToken?: string): string {
  let text = typeof value === "string" ? value : "Unknown failure";
  for (const key of [process.env.LETTA_API_KEY, process.env.OPENAI_API_KEY, process.env.SMOKE_REMOTE_TOKEN, privateToken]) {
    if (key) text = text.split(key).join("[REDACTED]");
  }
  return text.slice(0, 600);
}
function assert(value: unknown, message = "fixture assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const limitMs = 120_000;
type Mode = "local" | "remote" | "cloud" | "computer";
function modeFromArgs(value: string | undefined): Mode | undefined {
  return value === "local" || value === "remote" || value === "cloud" || value === "computer" ? value : undefined;
}
function backendForMode(mode: Mode, remoteUrl = "ws://127.0.0.1:45001", computerId = "fixture-device"): ServerConfig["backend"] {
  if (mode === "remote") return { type: "remote", url: remoteUrl, tokenEnv: "SMOKE_REMOTE_TOKEN" };
  if (mode === "computer") return { type: "cloud", apiKeyEnv: "LETTA_API_KEY", computer: { deviceId: computerId } };
  if (mode === "cloud") return { type: "cloud", apiKeyEnv: "LETTA_API_KEY" };
  return { type: "local", harnessBackend: "local" };
}
function configurationForMode(mode: Mode) {
  return parseConfig({ agentId: "fixture-agent", backend: backendForMode(mode), port: 0, publicUrl: "http://127.0.0.1:0" });
}
function checkBackendConfigurationPaths() {
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
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("deadline; outcome may be unknown")), limitMs); })]); }
  finally { clearTimeout(timer); }
}
function completed(result: SendMessageResult): { text: string; contextId: string; taskId: string } {
  if (!("status" in result && result.status?.state === TaskState.TASK_STATE_COMPLETED)) throw new Error(`Expected completed task; state=${"status" in result ? result.status?.state : "message"}`);
  assert(result.contextId);
  const text = result.artifacts.flatMap((artifact) => artifact.parts).map((part) => part.content?.$case === "text" ? part.content.value : "").join("");
  assert(text.trim());
  return { text, contextId: result.contextId, taskId: result.id };
}
function sdkClient(token: string) {
  const fetchWithBearer: typeof fetch = Object.assign((input: string | Request | URL, init?: RequestInit) => fetch(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` },
  }), { preconnect: fetch.preconnect });
  return new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: fetchWithBearer }), transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithBearer })] });
}
async function turn(client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>, prompt: string, contextId = "") {
  return completed(await deadline(client.sendMessage({ tenant: "", metadata: undefined,
    message: { ...agentMessage(prompt, "", contextId), role: Role.ROLE_USER },
    configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
  }, { signal: AbortSignal.timeout(limitMs) })));
}
async function streamedTurn(client: Awaited<ReturnType<ClientFactory["createFromUrl"]>>, prompt: string, contextId: string) {
  let taskId = "", sawWork = false, sawCompleted = false, artifactCount = 0;
  let finalArtifact = true, artifactSeen = false, statusFirst = false, answer = "";
  for await (const event of client.sendMessageStream({ tenant: "", metadata: undefined,
    message: { ...agentMessage(prompt, "", contextId), role: Role.ROLE_USER },
    configuration: { returnImmediately: false, acceptedOutputModes: ["text/plain"], historyLength: 0, taskPushNotificationConfig: undefined },
  }, { signal: AbortSignal.timeout(limitMs) })) {
    const payload = event.payload;
    if (payload?.$case === "task") taskId = payload.value.id;
    if (payload?.$case === "statusUpdate") {
      if (payload.value.status?.state === TaskState.TASK_STATE_WORKING && payload.value.status.message) {
        sawWork = true;
        if (!artifactSeen) statusFirst = true;
      }
      if (payload.value.status?.state === TaskState.TASK_STATE_COMPLETED) sawCompleted = true;
    }
    if (payload?.$case === "artifactUpdate") {
      artifactCount++; artifactSeen = true;
      finalArtifact &&= !payload.value.append && payload.value.lastChunk === true;
      answer += payload.value.artifact?.parts.map((part) => part.content?.$case === "text" ? part.content.value : "").join("") ?? "";
    }
  }
  assert(taskId && sawWork && statusFirst && sawCompleted && artifactCount === 1 && finalArtifact && answer.trim(),
    "stream must publish working status before one final artifact and completion");
  const stored = completed(await deadline(client.getTask({ id: taskId, tenant: "", historyLength: 0 })));
  assert(stored.text === answer && stored.contextId === contextId, "task readback must match the streamed answer and context");
  report("streaming", { statusFirst, oneFinalArtifact: finalArtifact, completedStatus: sawCompleted });
  report("streaming_readback", { sameAnswer: true, sameContext: true });
  return stored;
}

/** Fake transport-facing SDK client, exercising the application's real bridge and HTTP composition. */
function fakeClient(agentId: string): LettaAgentClient {
  const contextText = new Map<string, string>();
  const conversations = new Set<string>();
  let calls = 0;
  const openSession = (id: string) => {
    assert(id === agentId || conversations.has(id));
    let sentText = "", conversationId = id === agentId ? "" : id;
    return {
      async ready() { conversationId ||= randomUUID(); conversations.add(conversationId); return { conversationId }; },
      async send(text: string) { sentText = text; calls++; },
      async abort() {},
      async *stream() {
        const prior = contextText.get(conversationId) ?? "";
        const match = sentText.match(/remember token (\S+)/i);
        const answer = match ? `SMOKE_READY ${match[1]}` : sentText.includes("previous turn") ? prior : "SMOKE_STREAM_READY";
        contextText.set(conversationId, match ? match[1]! : prior);
        yield { type: "assistant", uuid: randomUUID(), content: answer };
        yield { type: "result", success: true, result: answer, conversationId, durationMs: 1 };
      },
      async [Symbol.asyncDispose]() {},
    };
  };
  return {
    agents: { retrieve: async (id: string) => { assert(id === agentId); return { id }; } },
    createSession: openSession, resumeSession: openSession, close: async () => {},
    get callCount() { return calls; },
  } as unknown as LettaAgentClient;
}
async function providerFreeCheck() {
  checkBackendConfigurationPaths();
  const token = randomUUID() + randomUUID(), agentId = `provider-free-${randomUUID()}`;
  const client = fakeClient(agentId);
  const scope = await Effect.runPromise(Scope.make());
  try {
    const config = parseApplicationConfig({ port: 0, publicUrl: "http://127.0.0.1:0/agents/",
      connections: { local: backendForMode("local") },
      bindings: { smoke: { path: "/smoke", connection: "local", agentId, auth: { tokenEnv: "SMOKE_INBOUND_TOKEN", owner: "smoke-operator" } } },
    });
    const server = await deadline(Effect.runPromise(startApplicationServer(config, () => client, "127.0.0.1", { SMOKE_INBOUND_TOKEN: token })
      .pipe(Effect.provideService(Scope.Scope, scope))));
    const inboundUrl = server.bindings.smoke!;
    const cardUrl = `${inboundUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
    const missing = await fetch(cardUrl, { signal: AbortSignal.timeout(limitMs) });
    assert(missing.status === 401, "missing bearer must be rejected during card discovery"); await missing.arrayBuffer();
    const wrong = await fetch(cardUrl, { headers: { Authorization: `Bearer ${randomUUID()}` }, signal: AbortSignal.timeout(limitMs) });
    assert(wrong.status === 401, "wrong bearer must be rejected during card discovery"); await wrong.arrayBuffer();
    const valid = await fetch(cardUrl, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(limitMs) });
    assert(valid.ok && valid.headers.get("cache-control") === "private, no-store");
    const card = JSON.parse(await valid.text()) as { name?: string };
    assert(card.name, "authenticated card discovery must return the application card");
    const remote = await deadline(sdkClient(token).createFromUrl(`${inboundUrl}/`));
    const recall = randomUUID();
    const first = await turn(remote, `Remember token ${recall}. Reply with SMOKE_READY and the token.`);
    assert(first.text.includes("SMOKE_READY") && first.text.includes(recall));
    const second = await turn(remote, "Return only the token I asked you to remember in the previous turn.", first.contextId);
    assert(second.contextId === first.contextId && second.text.includes(recall), "continuation must recall the prior token in the same context");
    const stored = await streamedTurn(remote, "Stream a final response", first.contextId);
    assert(stored.text === "SMOKE_STREAM_READY");
    assert((client as unknown as { callCount: number }).callCount === 3);
    report("fixture_check", { completed: true, configModes: 4, applicationAgentCard: true,
      discovery: { missingBearer401: true, wrongBearer401: true, validBearer200: true },
      continuation: { sameContext: true, recall: true },
      taskReadback: { sameAnswer: true, sameContext: true }, fakeSdkTurns: 3, sdkAgentCreation: 0, modelCalls: 0 });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

function privateAppServerUrl(output: string): string | undefined { return output.match(/^WebSocket:\s+(ws:\/\/127\.0\.0\.1:\d+(?:\/ws)?)\s*$/m)?.[1]; }
function versionAtLeast(actual: string | undefined, minimum: string): boolean {
  if (!actual) return false;
  const parse = (value: string) => value.replace(/^v/i, "").split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const left = parse(actual), right = parse(minimum); if (left.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  return true;
}
async function waitForChildExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await deadline(new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); }));
}
async function startPrivateAppServer(home: string) {
  const token = randomUUID() + randomUUID(), tokenFile = join(home, "app-server-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const cli = process.env.SMOKE_LETTA_CLI ?? "/app/node_modules/@letta-ai/letta-code/letta.js";
  const child = spawn(process.execPath, [cli, "--backend", "local", "server", "--listen", "--ws-auth", "capability-token", "--ws-token-file", tokenFile], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), LETTA_API_KEY: process.env.LETTA_API_KEY ?? "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  let url = "";
  try {
    await deadline((async () => {
      while (child.exitCode === null && child.signalCode === null) {
        const listening = privateAppServerUrl(output); if (listening) { url = listening; return; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`native App Server exited during startup (${child.exitCode ?? child.signalCode})`);
    })());
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try { await waitForChildExit(child); } catch { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await waitForChildExit(child); }
    await rm(tokenFile, { force: true }); throw error;
  }
  return { url, token, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    try { await waitForChildExit(child); } catch { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await waitForChildExit(child); }
    await rm(tokenFile, { force: true });
  } };
}

async function live(mode: Mode, model: string) {
  if (!((mode === "cloud" || mode === "computer") ? process.env.LETTA_API_KEY : process.env.OPENAI_API_KEY)) { report("missing_required_env"); process.exitCode = 2; return; }
  if (mode === "computer" && !process.env.SMOKE_COMPUTER_DEVICE_ID) { report("missing_computer_selection"); process.exitCode = 2; return; }
  let stage = "setup", createdId: string | undefined, deletedId: string | undefined, deleteAcknowledgedId: string | undefined;
  let creationPending = false, startupPending = false, executionMayBeActive = false;
  const cleanupFailures: string[] = [];
  let client: LettaAgentClient | undefined, scope: Scope.Closeable | undefined, home: string | undefined;
  let privateAppServer: Awaited<ReturnType<typeof startPrivateAppServer>> | undefined, scopeClosed = true;
  const watchdog = setTimeout(() => { report("total_deadline", { interruptedStage: stage, createdId, deletedId, deleteAcknowledgedId, creationOutcomeUnknown: creationPending, cleanupComplete: false }); process.exit(1); }, 10 * 60_000);
  const cleanup = async (name: string, work: () => Promise<unknown>) => {
    try { await deadline(work()); return true; }
    catch (error) {
      cleanupFailures.push(name);
      report("cleanup_error", { resource: name, reason: safeReason(error instanceof Error ? error.message : error, privateAppServer?.token) });
      return false;
    }
  };
  try {
    home = await mkdtemp(join(tmpdir(), "letta-smoke-")); process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config"); process.env.XDG_CACHE_HOME = join(home, ".cache");
    const { LettaAgentClient: ActualClient } = await import("@letta-ai/letta-agent-sdk");
    if (mode === "remote") { stage = "remote_app_server"; privateAppServer = await startPrivateAppServer(home); }
    const backend = backendForMode(mode, privateAppServer?.url, mode === "computer" ? process.env.SMOKE_COMPUTER_DEVICE_ID : undefined);
    const sdkConfig = sdkOptions(backend, { ...process.env, ...(privateAppServer ? { SMOKE_REMOTE_TOKEN: privateAppServer.token } : {}) }); assert(sdkConfig);
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
    if (mode === "computer") {
      stage = "computer_preflight";
      const { computer: selected } = await deadline(client.computers.resolve({ deviceId: process.env.SMOKE_COMPUTER_DEVICE_ID! }));
      if (!selected) throw new Error("selected computer metadata is unavailable; refusing execution");
      const version = selected.metadata?.lettaCodeVersion;
      report("selected_computer_preflight", { online: selected.status === "online", deviceId: selected.deviceId, lettaCodeVersion: version, nodeVersion: selected.metadata?.nodeVersion });
      if (selected.status !== "online" || !versionAtLeast(version, "0.34.2")) throw new Error("selected computer is offline or its Letta Code version is below the supported minimum 0.34.2");
    }
    stage = "create"; creationPending = true;
    const name = `a2a-smoke-${randomUUID()}`; report("creation_intent", { mode, model, name });
    const ownedId = await deadline(client.createAgent({ name, model, hidden: mode === "cloud" || mode === "computer", memfs: false, baseTools: [],
      persona: "You are a disposable smoke worker. Answer briefly. Remember supplied tokens and reply with them when asked. Do not use tools.",
    }).then((id) => { createdId = id; creationPending = false; return id; }));
    createdId = ownedId;
    report("created", { createdId });
    if (mode === "remote") {
      const rejected = new ActualClient({ backend: "remote", url: privateAppServer!.url, authToken: randomUUID(), requestTimeoutMs: limitMs, pinGlobalAgent: false });
      const rejectedSession = rejected.resumeSession(ownedId); let wrongTokenRefused = false;
      try { await deadline(rejectedSession.ready()); } catch { wrongTokenRefused = true; }
      rejectedSession.close(); await rejected.close(); assert(wrongTokenRefused); report("remote_auth", { wrongTokenRefused: true });
      const { LettaAgentClient: FreshClient } = await import("@letta-ai/letta-agent-sdk");
      const fresh = new FreshClient({ backend: "remote", url: privateAppServer!.url, authToken: privateAppServer!.token, requestTimeoutMs: limitMs, pinGlobalAgent: false });
      await client.close(); client = fresh;
      const readiness = client.resumeSession(ownedId);
      try { const ready = await deadline(readiness.ready()); const status = await deadline(readiness.getDeviceStatus({ timeoutMs: limitMs }));
        report("remote_sdk_readiness", { ready: true, deviceStatusReadback: true, agentIdMatches: ready.agentId === ownedId, online: status.isOnline, processing: status.isProcessing });
      } finally { readiness.close(); }
    }
    stage = "server"; scope = await Effect.runPromise(Scope.make()); scopeClosed = false; startupPending = true;
    const server = await deadline(Effect.runPromise(startServer(parseConfig({ agentId: ownedId, backend, port: 0, publicUrl: "http://127.0.0.1:0", ...(process.env.SMOKE_CWD ? { cwd: process.env.SMOKE_CWD } : {}) }), client)
      .pipe(Effect.provideService(Scope.Scope, scope))).finally(() => { startupPending = false; }));
    const remote = await deadline(new ClientFactory().createFromUrl(server.url));
    const recall = randomUUID();
    stage = "answer"; executionMayBeActive = true;
    const first = await turn(remote, `Remember token ${recall}. Reply with SMOKE_READY and the token.`); executionMayBeActive = false;
    assert(first.text.includes("SMOKE_READY") && first.text.includes(recall)); report(stage, { completed: true, contextId: first.contextId });
    stage = "continuation"; executionMayBeActive = true;
    const second = await streamedTurn(remote, "Return only the token I asked you to remember in the previous turn.", first.contextId); executionMayBeActive = false;
    assert(second.contextId === first.contextId && second.text.includes(recall)); report(stage, { completed: true, sameContext: true, recall: true });
  } catch (error) {
    report("failed", { failedStage: stage, reason: safeReason(error instanceof Error ? error.message : error, privateAppServer?.token), createdId, creationOutcomeUnknown: creationPending, executionMayBeActive }); process.exitCode = 1;
  } finally {
    if (scope) scopeClosed = await cleanup("server_scope", () => Effect.runPromise(Scope.close(scope!, Exit.void)));
    if (createdId && client && scopeClosed && !creationPending && !startupPending && !executionMayBeActive) {
      const id = createdId;
      await cleanup("agent_delete_verify", async () => {
        const localState = mode === "local" || mode === "remote";
        const locallyVisible = localState ? await client!.agents.list().then((agents) => agents.some((agent) => agent.id === id), () => false) : false;
        await client!.agents.delete(id); deleteAcknowledgedId = id;
        if (localState && locallyVisible) { assert(!(await client!.agents.list()).some((agent) => agent.id === id)); deletedId = id; return; }
        try { await client!.agents.retrieve(id); }
        catch (error) { if (typeof error === "object" && error !== null && "status" in error && error.status === 404) { deletedId = id; return; } throw new Error("deletion verification unknown"); }
        throw new Error("agent still retrievable");
      });
    } else if (createdId || creationPending) cleanupFailures.push(executionMayBeActive ? "agent_retained_execution_outcome_unknown" : "agent_retained_execution_or_creation_unknown");
    if (client) await cleanup("sdk_client", () => client!.close());
    if (privateAppServer) await cleanup("private_app_server", privateAppServer.stop);
    if (home && scopeClosed && !cleanupFailures.length) await cleanup("temp_home", () => rm(home!, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
    report("cleanup", { createdId, deletedId, deleteAcknowledgedId, creationOutcomeUnknown: creationPending, executionMayBeActive, cleanupFailures,
      sandboxTermination: mode === "cloud" ? "SDK best-effort; not independently confirmed" : "not applicable",
      execution: mode === "computer" ? { kind: "cloud-computer", deviceId: process.env.SMOKE_COMPUTER_DEVICE_ID } : mode === "cloud" ? { kind: "cloud-managed-sandbox" } : { kind: mode } });
    if (cleanupFailures.length) process.exitCode = 1;
    if (!creationPending && !startupPending && !cleanupFailures.length) clearTimeout(watchdog); else watchdog.unref();
  }
}
async function main() {
  if (process.argv[2] === "--check") return providerFreeCheck();
  const mode = modeFromArgs(process.argv[2]) ?? modeFromArgs(process.env.SMOKE_MODE), model = process.argv[3] ?? process.env.SMOKE_MODEL;
  if (!mode || !model?.trim()) { report("usage", { invocation: "node --import tsx scripts/smoke-live.ts local|remote|cloud|computer MODEL (or SMOKE_MODE/SMOKE_MODEL); --check", computerIdEnv: "SMOKE_COMPUTER_DEVICE_ID", cwdEnv: "SMOKE_CWD" }); process.exitCode = 2; return; }
  await live(mode, model);
}
await main().catch((error) => { report("fixture_failed", { reason: safeReason(error instanceof Error ? error.message : error) }); process.exitCode = 1; });
