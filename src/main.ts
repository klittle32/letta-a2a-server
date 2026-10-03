import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { ConfigurationError, loadApplicationConfig, sdkOptions } from "./config.js";
import { ServerStartupError, startApplicationServer } from "./server.js";
import type { ApplicationBindingConfig } from "./config.js";

export const applicationProgram = (
  configPath = process.argv[2] ?? "config.local.json",
  createClient: ((binding: ApplicationBindingConfig) => LettaAgentClient) | undefined = undefined,
  host = process.env.A2A_LISTEN_HOST ?? "127.0.0.1",
  env: NodeJS.ProcessEnv = process.env,
) => Effect.scoped(Effect.gen(function* () {
    const config = yield* loadApplicationConfig(configPath);
    if (!["127.0.0.1", "0.0.0.0"].includes(host))
      return yield* new ServerStartupError({ message: "Unsupported A2A_LISTEN_HOST" });
    if (host === "0.0.0.0")
      yield* Effect.logWarning("Development listener: use only inside a trusted container network with host-loopback port publishing.");
    for (const binding of config.bindings) {
      yield* Effect.try({
        try: () => sdkOptions(binding.backend, env),
        catch: () => new ConfigurationError({ message: "Unable to resolve SDK backend configuration" }),
      });
    }
    const construct = createClient ?? ((binding: ApplicationBindingConfig) => new LettaAgentClient(sdkOptions(binding.backend, env)));
    const server = yield* startApplicationServer(config, construct, host, env);
    yield* Effect.logInfo(`Letta A2A Server: ${server.url}`);
    for (const [id, url] of Object.entries(server.bindings))
      yield* Effect.logInfo(`Binding ${id}: ${url}`);
    return yield* Effect.never;
  }));

// NodeRuntime interrupts the main fiber on SIGINT/SIGTERM and awaits scoped
// finalizers, including each SDK client, each bridge, and the shared listener.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href)
  NodeRuntime.runMain(applicationProgram().pipe(Effect.provide(NodeServices.layer)));
