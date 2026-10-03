import express from "express";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { AgentSdkTurnRunner, createBridge, createBridgeRouter } from "./bridge/index.js";
import type { BridgeOptions } from "./bridge/bridge.js";
import { createA2AClient } from "./client/index.js";
import { createA2ATools } from "./client/agent-sdk.js";
import type { ApplicationConfig, ApplicationBindingConfig, ServerConfig } from "./config.js";

export class ServerStartupError extends Schema.TaggedError<ServerStartupError>()("ServerStartupError", {
  message: Schema.String,
}) {}

export class ServerShutdownError extends Schema.TaggedError<ServerShutdownError>()("ServerShutdownError", {
  message: Schema.String,
}) {}

function makeBearerBridgeOptions(binding: ApplicationBindingConfig, env: NodeJS.ProcessEnv) {
  if (!binding.auth) return {};
  const token = env[binding.auth.tokenEnv];
  if (!token?.trim()) throw new ServerStartupError({ message: `Required environment variable ${binding.auth.tokenEnv} is missing` });
  const owner = binding.auth.owner;
  const unauthorized: import("express").RequestHandler = (_req, _res, next) => next();
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
    security: { securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } } as never, securityRequirements: [{ schemes: { bearer: [] } }] },
    transport: {
      middleware: [unauthorized, gate],
      userBuilder: async () => ({ isAuthenticated: true, userName: owner }),
    },
  };
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && requireTimingSafeEqual(a, b);
}
function requireTimingSafeEqual(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(a, b);
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
  function* (config: ServerConfig, client: LettaAgentClient, extra: ReturnType<typeof makeBearerBridgeOptions> = {}) {
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
    const outbound = yield* Effect.acquireRelease(
      Effect.try({
        try: () => Object.keys(config.peers).length ? createA2AClient({ routes: config.peers }) : undefined,
        catch: () => new ServerStartupError({ message: "Outbound client construction failed" }),
      }),
      (resource) => shutdown("Outbound client shutdown failed", () => resource?.close()),
    );
    const runner = new AgentSdkTurnRunner(client, config.agentId, {
      sharingDomain: config.agentId,
      sessionOptions(scope) {
        const tools = outbound ? createA2ATools({
          client: outbound,
          // Read the ready conversation dynamically, never snapshot it before
          // the SDK binds the session to its actual conversation.
          getScope: () => ({ agentId: scope.agentId, conversationId: scope.conversationId ?? null }),
          signal: scope.signal,
        }) : undefined;
        const names = new Set(tools?.tools.map((tool) => tool.name));
        return {
          options: {
            ...(config.cwd ? { cwd: config.cwd } : {}),
            permissionMode: "standard",
            ...(tools ? { tools: tools.tools } : {}),
            // Retain normal SDK tools/skills and ordinary auto-approval rules.
            canUseTool: async (name) => names.has(name)
              ? { behavior: "allow" }
              : { behavior: "deny", message: "This server has no interactive approval UI", interrupt: false },
          },
          close: () => tools?.close(),
        };
      },
    });
    const bridge = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createBridge({
          runner: {
            runTurn: (request) => runner.runTurn({
              ...request,
              signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
            }),
            get unresolvedContexts() { return runner.unresolvedContexts; },
          },
          sharingDomain: config.agentId,
          publicBaseUrl: config.publicUrl,
          name: config.name,
          ...(extra as unknown as Pick<BridgeOptions, "auth" | "security" | "transport">),
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

export const startServer = Effect.fn("Server.start")(
  function* (config: ServerConfig, client: LettaAgentClient, host = "127.0.0.1") {
    const { bridge } = yield* acquireBinding(config, client);
    const app = express();
    app.disable("x-powered-by");
    app.get("/healthz", (_request, response) => response.json({ status: "ok" }));
    app.use(createBridgeRouter(bridge));
    const listener = yield* Effect.acquireRelease(
      Effect.try({
        try: () => app.listen(config.port, host),
        catch: () => new ServerStartupError({ message: "HTTP listener acquisition failed" }),
      }),
      (resource) => shutdown("HTTP listener shutdown failed", () => new Promise<void>((resolve, reject) => {
        resource.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
        // Closing connections does not cancel SDK work. The bridge finalizer
        // separately requests cancellation and awaits session/tool disposal.
        resource.closeAllConnections();
      })),
    );
    // Observe the actual listening/error event before advancing acquisition.
    yield* Effect.tryPromise({
      try: () => once(listener, "listening"),
      catch: () => new ServerStartupError({ message: "HTTP listener startup failed" }),
    }).pipe(Effect.uninterruptible);
    const address = listener.address() as AddressInfo;
    const url = new URL(config.publicUrl);
    if (url.port === "0") {
      url.port = String(address.port);
      for (const entry of bridge.card.supportedInterfaces) entry.url = url.href;
    }
    return { url: url.href.replace(/\/$/, ""), bridge };
  },
);

export class Server extends Context.Service<Server, { readonly url: string }>()("letta-a2a-server/Server") {
  static layer(config: ServerConfig, create: () => LettaAgentClient, host = "127.0.0.1") {
    return Layer.effect(Server, Effect.gen(function* () {
      const client = yield* acquireSdkClient(create);
      return yield* startServer(config, client, host);
    }));
  }
}

export const startApplicationServer = Effect.fn("Server.startApplicationServer")(
  function* (config: ApplicationConfig, createClient: (binding: ApplicationBindingConfig) => LettaAgentClient, host = "127.0.0.1", env: NodeJS.ProcessEnv = process.env) {
    const app = express(); app.disable("x-powered-by");
    app.get("/healthz", (_request, response) => response.json({ status: "ok" }));
    const bridges: Array<{ binding: ApplicationBindingConfig; bridge: ReturnType<typeof createBridge> }> = [];
    for (const binding of config.bindings) {
      const client = yield* acquireSdkClient(() => createClient(binding));
      const serverConfig: ServerConfig = { agentId: binding.agentId, name: binding.name, backend: binding.backend, port: config.port,
        publicUrl: binding.publicUrl, peers: binding.peers, ...(binding.cwd ? { cwd: binding.cwd } : {}) };
      const extra = makeBearerBridgeOptions(binding, env);
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
    const listener = yield* Effect.acquireRelease(Effect.try({
      try: () => app.listen(config.port, host), catch: () => new ServerStartupError({ message: "HTTP listener acquisition failed" }),
    }), (resource) => shutdown("HTTP listener shutdown failed", () => new Promise<void>((resolve, reject) => {
      resource.close((error) => error ? reject(error) : resolve()); resource.closeAllConnections();
    })));
    yield* Effect.tryPromise({ try: () => once(listener, "listening"), catch: () => new ServerStartupError({ message: "HTTP listener startup failed" }) }).pipe(Effect.uninterruptible);
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
