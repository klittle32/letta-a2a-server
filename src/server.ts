import express from "express";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Effect, Schema } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { AgentSdkTurnRunner, DurableBinding, LettaTurnCancelledError, createBridge, createBridgeRouter } from "./bridge/index.js";
import { type ApplicationConfig, type ApplicationBindingConfig, type ServerConfig } from "./config.js";

export class ServerStartupError extends Schema.TaggedError<ServerStartupError>()("ServerStartupError", {
  message: Schema.String,
}) {}

export class ServerShutdownError extends Schema.TaggedError<ServerShutdownError>()("ServerShutdownError", {
  message: Schema.String,
}) {}

export function withTurnDeadline(runner: AgentSdkTurnRunner, timeoutMs = 120_000) {
  return {
    runTurn: (request: Parameters<AgentSdkTurnRunner["runTurn"]>[0]) =>
      runner.runTurn({ ...request,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      }),
    get unresolvedContexts() { return runner.unresolvedContexts; },
  };
}

class InboundAuthenticationConfigurationError extends Schema.TaggedError<InboundAuthenticationConfigurationError>()("InboundAuthenticationConfigurationError", {
  message: Schema.String,
}) {}

class StateIdentityError extends Schema.TaggedError<StateIdentityError>()("StateIdentityError", {
  message: Schema.String,
}) {}

type BearerBridgeOptions = Pick<import("./bridge/bridge.js").BridgeOptions, "auth" | "security" | "transport">;

function makeBearerBridgeOptions(binding: ApplicationBindingConfig, env: NodeJS.ProcessEnv): Partial<BearerBridgeOptions> {
  if (!binding.auth) return {};
  const token = env[binding.auth.tokenEnv];
  if (!token?.trim()) throw new InboundAuthenticationConfigurationError({ message: "Required inbound authentication environment variable is missing" });
  const owner = binding.auth.owner;
  const gate: import("express").RequestHandler = (req, res, next) => {
    const values = req.headers.authorization;
    if (Array.isArray(values) || (values && !/^Bearer [^\s,]+$/i.test(values))) { res.status(401).json({ error: "Authentication required" }); return; }
    const supplied = values?.slice(7);
    if (!supplied || !constantTimeEqual(supplied, token)) { res.status(401).json({ error: "Authentication required" }); return; }
    next();
  };
  return {
    auth: {
      projectCaller: async (context: import("@a2a-js/sdk/server").ServerCallContext) => {
        const user = context.user as (typeof context.user & { userName?: string });
        return user?.isAuthenticated && user.userName === owner ? { issuer: "configured", subject: owner, tenant: binding.id } : undefined;
      },
      authorize: async ({ caller }: { caller: { subject: string } }) => caller.subject === owner,
    },
    security: { securitySchemes: { bearer: { scheme: { $case: "httpAuthSecurityScheme", value: { scheme: "Bearer", description: "Bearer token authentication", bearerFormat: "opaque" } } } }, securityRequirements: [{ schemes: { bearer: { list: [] } } }] },
    transport: {
      middleware: [gate],
      userBuilder: async () => ({ isAuthenticated: true, userName: owner }),
    },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Classify by known types, never by arbitrary error names, messages or causes.
function requestErrorType(error: unknown): string {
  if (error instanceof LettaTurnCancelledError) return "LettaTurnCancelledError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "unknown";
}

// Imported promises do not establish backend cancellation. Finalizers await the
// actual public disposal promises, uninterruptibly, and never retry sent work.
const shutdown = (message: string, dispose: () => PromiseLike<unknown> | void) =>
  Effect.tryPromise({
    try: async () => { await dispose(); },
    catch: () => new ServerShutdownError({ message }),
  }).pipe(
    // runMain suppresses its default cause report for signal interruption;
    // report cleanup uncertainty explicitly even when interruption initiated it.
    Effect.tapError((error) => Effect.logError(error.message)),
    Effect.orDie,
  );

function acquireHttpListener(app: express.Express, port: number, host: string) {
  return Effect.acquireRelease(
    Effect.try({ try: () => app.listen(port, host), catch: () => new ServerStartupError({ message: "HTTP listener acquisition failed" }) }),
    (listener) => shutdown("HTTP listener shutdown failed", () => new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      // Closing connections does not cancel SDK work; bridge cleanup owns that.
      listener.closeAllConnections();
    })),
  );
}

function awaitListener(listener: ReturnType<express.Express["listen"]>) {
  return Effect.tryPromise({ try: () => once(listener, "listening"), catch: () => new ServerStartupError({ message: "HTTP listener startup failed" }) })
    .pipe(Effect.uninterruptible);
}

/** Only clients explicitly constructed by this acquisition are scope-owned. */
export const acquireSdkClient = Effect.fn("Server.acquireSdkClient")(
  (create: () => LettaAgentClient) => Effect.acquireRelease(
    Effect.try({
      try: create,
      catch: () => new ServerStartupError({ message: "SDK client construction failed" }),
    }),
    (client) => shutdown("SDK client shutdown failed; execution may still be active", () => client.close()),
  ),
);

/** Acquires server resources; the supplied SDK client remains caller-owned. */
const acquireBinding = Effect.fn("Server.acquireBinding")(
  function* (config: ServerConfig & { id?: string }, client: LettaAgentClient, extra: ReturnType<typeof makeBearerBridgeOptions> = {}) {
    // The SDK supplies no cancellation/drain contract here. Pending
    // interruption must await real retrieval (and lazy management startup)
    // before scope finalizers may close the owning client.
    const agent = yield* Effect.tryPromise({
      try: () => client.agents.retrieve(config.agentId),
      catch: () => new ServerStartupError({ message: "Configured agent retrieval failed" }),
    }).pipe(Effect.uninterruptible);
    if (agent.id !== config.agentId) {
      return yield* new ServerStartupError({ message: "Configured agent identity could not be verified" });
    }
    const durability = config.stateDirectory
      ? yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => DurableBinding.open({ directory: config.stateDirectory!, bindingId: config.id ?? config.agentId }),
            catch: () => new ServerStartupError({ message: "Durable state could not be opened" }),
          }),
          (resource) => shutdown("Durable state shutdown failed", () => resource.close()),
        )
      : undefined;
    const backendIdentity = JSON.stringify([
      config.backend.type,
      config.backend.type === "remote" ? config.backend.url :
        config.backend.type === "local" ? config.backend.harnessBackend ?? "local" : config.backend.computer ?? null,
      config.backend.type === "remote" ? config.backend.tokenEnv ?? null :
        config.backend.type === "cloud" ? config.backend.apiKeyEnv ?? null : null,
    ]);
    yield* Effect.try({ try: () => durability?.bindAgent(config.agentId, backendIdentity),
      catch: () => new StateIdentityError({ message: "Durable state identity does not match this binding" }) });
    const runner = new AgentSdkTurnRunner(client, config.agentId, {
      sharingDomain: config.id ?? config.agentId,
      ...(durability ? { conversationMapping: durability.conversationMapping, execution: durability.execution } : {}),
      sessionOptions: { ...(config.cwd ? { cwd: config.cwd } : {}), permissionMode: "standard",
        canUseTool: async () =>
          ({ behavior: "deny", message: "This server has no interactive approval UI", interrupt: false }),
      },
    });
    // SDK callbacks run outside the startup fiber. Retain its logger, level and
    // annotations without creating background fibers or another runtime owner.
    const runDiagnostic = Effect.runSyncWith(yield* Effect.context());
    const bridge = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createBridge({
          runner: withTurnDeadline(runner),
          sharingDomain: config.id ?? config.agentId,
          ...(durability ? { durability } : {}),
          ...(durability ? { backendIdentity, durabilityAgentId: config.agentId } : {}),
          publicBaseUrl: config.publicUrl,
          name: config.name,
          ...extra,
          onError: ({ taskId, error }) => {
            const errorType = requestErrorType(error);
            const log = errorType === "LettaTurnCancelledError"
              ? Effect.logInfo("A2A cancellation reported")
              : Effect.logError("A2A request failed");
            runDiagnostic(log.pipe(Effect.annotateLogs({
              bindingId: config.id ?? "default",
              taskId: taskId || "unassigned",
              errorType,
            })));
          },
        }),
        catch: () => new ServerStartupError({ message: "Inbound bridge construction failed" }),
      }),
      (resource) => shutdown("Bridge shutdown failed; execution may still be active", async () => {
        const result = await resource.close();
        if (!result.complete) throw new ServerShutdownError({
          message: "Shutdown incomplete; execution may still be active",
        });
      }),
    );
    return { bridge };
  },
);

export const startApplicationServer = Effect.fn("Server.startApplicationServer")(
  function* (config: ApplicationConfig, createClient: (binding: ApplicationBindingConfig) => LettaAgentClient, host = "127.0.0.1", env: NodeJS.ProcessEnv = process.env) {
    const app = express(); app.disable("x-powered-by");
    app.get("/healthz", (_request, response) => response.json({ status: "ok" }));
    const bridges: Array<{ binding: ApplicationBindingConfig; bridge: ReturnType<typeof createBridge> }> = [];
    for (const binding of config.bindings) {
      const client = yield* acquireSdkClient(() => createClient(binding));
      const serverConfig: ServerConfig & { id: string } = { id: binding.id, agentId: binding.agentId, name: binding.name, backend: binding.backend, port: config.port,
        publicUrl: binding.publicUrl,
        ...(binding.stateDirectory ? { stateDirectory: binding.stateDirectory } : {}), ...(binding.cwd ? { cwd: binding.cwd } : {}) };
      const extra = yield* Effect.try({ try: () => makeBearerBridgeOptions(binding, env),
        catch: () => new InboundAuthenticationConfigurationError({ message: "Inbound authentication configuration is invalid or incomplete" }) });
      const bridge = (yield* acquireBinding(serverConfig, client, extra)).bridge;
      bridges.push({ binding, bridge });
      const externalPrefix = new URL(config.publicUrl).pathname.replace(/\/$/, "");
      const mountPath = `${externalPrefix}${binding.path}` || "";
      const routed = createBridgeRouter(bridge);
      app.use((req, res, next) => {
        if (mountPath && !(req.path === mountPath || req.path.startsWith(`${mountPath}/`))) return next();
        const originalUrl = req.url;
        if (mountPath) {
          const remainder = req.url.slice(mountPath.length);
          req.url = remainder.startsWith("/") ? remainder : `/${remainder}`;
        }
        res.once("finish", () => { req.url = originalUrl; });
        routed(req, res, (routeError) => { req.url = originalUrl; next(routeError); });
      });
    }
    const listener = yield* acquireHttpListener(app, config.port, host);
    yield* awaitListener(listener);
    const address = listener.address() as AddressInfo;
    const prefix = new URL(config.publicUrl);
    if (prefix.port === "0") prefix.port = String(address.port);
    const bindings = Object.fromEntries(bridges.map(({ binding, bridge }) => {
      const endpoint = new URL(binding.publicUrl);
      if (endpoint.port === "0") endpoint.port = String(address.port);
      for (const supported of bridge.card.supportedInterfaces) supported.url = endpoint.href;
      return [binding.id, endpoint.href.replace(/\/$/, "")];
    }));
    return { url: `${prefix.origin}${prefix.pathname.replace(/\/$/, "")}`, bindings };
  },
);
