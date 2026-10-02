import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { AgentSdkTurnRunner, createBridge, createBridgeRouter } from "./bridge/index.js";
import { createA2AClient } from "./client/index.js";
import { createA2ATools } from "./client/agent-sdk.js";
import type { ServerConfig } from "./config.js";

export class ServerStartupError extends Schema.TaggedError<ServerStartupError>()("ServerStartupError", {
  message: Schema.String,
}) {}

export class ServerShutdownError extends Schema.TaggedError<ServerShutdownError>()("ServerShutdownError", {
  message: Schema.String,
}) {}

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
export const startServer = Effect.fn("Server.start")(
  function* (config: ServerConfig, client: LettaAgentClient, host = "127.0.0.1") {
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
    return { url: url.href.replace(/\/$/, "") };
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
