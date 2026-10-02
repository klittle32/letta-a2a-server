import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ConfigurationError, loadConfig, sdkOptions } from "./config.js";
import { Server, ServerStartupError } from "./server.js";

const program = Effect.gen(function* () {
  const config = yield* loadConfig(process.argv[2] ?? "config.local.json");
  const host = process.env.A2A_LISTEN_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) {
    return yield* new ServerStartupError({ message: "Unsupported A2A_LISTEN_HOST" });
  }
  if (host === "0.0.0.0") {
    yield* Effect.logWarning("Development listener: use only inside a trusted container network with host-loopback port publishing.");
  }
  const options = yield* Effect.try({
    try: () => sdkOptions(config.backend),
    catch: () => new ConfigurationError({ message: "Unable to resolve SDK backend configuration" }),
  });
  return yield* Effect.gen(function* () {
    const server = yield* Server;
    yield* Effect.logInfo(`Letta A2A Server: ${server.url}`);
    yield* Effect.logInfo(`Existing agent: ${config.agentId}`);
    return yield* Effect.never;
  }).pipe(Effect.provide(Server.layer(config, () => new LettaAgentClient(options), host)));
});

// The Node runtime interrupts the main fiber on SIGINT/SIGTERM and awaits all
// scope finalizers. Cleanup defects retain a nonzero exit instead of reporting
// interrupted imported promises as successful backend cancellation.
NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
