import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { Effect, FileSystem, Schema, SchemaTransformation } from "effect";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const identity = Schema.Trim.check(Schema.isMinLength(1));
const envName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
const endpoint = Schema.String.check(Schema.makeFilter((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}));
const publicUrl = endpoint.pipe(Schema.decodeTo(Schema.String,
  SchemaTransformation.transform({ decode: (value) => new URL(value).href, encode: (value) => value }),
)).check(Schema.makeFilter((value) => {
  const url = new URL(value);
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/";
}));
const computer = Schema.Union([
  nonEmpty,
  Schema.Struct({ deviceId: nonEmpty }),
  Schema.Struct({ name: nonEmpty }),
]);
const backend = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["local"]),
    harnessBackend: Schema.optional(Schema.Literals(["api", "local"])),
  }),
  Schema.Struct({ type: Schema.Literals(["remote"]), url: endpoint, tokenEnv: Schema.optional(envName) }),
  Schema.Struct({ type: Schema.Literals(["cloud"]), apiKeyEnv: Schema.optional(envName), computer: Schema.optional(computer) }),
]);
export const serverConfigSchema = Schema.Struct({
  agentId: identity,
  name: identity.pipe(Schema.withDecodingDefaultType(Effect.succeed("Letta A2A Agent"))),
  backend,
  cwd: Schema.optional(nonEmpty),
  port: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 }))
    .pipe(Schema.withDecodingDefaultType(Effect.succeed(41241))),
  publicUrl: publicUrl.pipe(Schema.withDecodingDefaultType(Effect.succeed("http://127.0.0.1:41241/"))),
  peers: Schema.Record(nonEmpty, endpoint).pipe(
    Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
});

export type ServerConfig = typeof serverConfigSchema.Type;

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String,
}) {}

export function parseConfig(value: unknown): ServerConfig {
  try {
    return Schema.decodeUnknownSync(serverConfigSchema, { onExcessProperty: "error" })(value);
  } catch {
    throw new ConfigurationError({ message: "Invalid server configuration" });
  }
}

export const loadConfig = Effect.fn("loadConfig")(function*(
  path: string,
): Effect.fn.Return<ServerConfig, ConfigurationError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() =>
    new ConfigurationError({ message: "Unable to read configuration file" })));
  const value: unknown = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new ConfigurationError({ message: "Invalid configuration JSON" }),
  });
  return yield* Schema.decodeUnknownEffect(serverConfigSchema, { onExcessProperty: "error" })(value).pipe(
    Effect.mapError(() => new ConfigurationError({ message: "Invalid server configuration" })),
  );
});

export function sdkOptions(
  config: ServerConfig["backend"],
  env: NodeJS.ProcessEnv = process.env,
): ConstructorParameters<typeof LettaAgentClient>[0] {
  const secret = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new Error(`Required environment variable ${name} is missing`);
    return value;
  };
  switch (config.type) {
    case "local": return {
      backend: "local",
      ...(config.harnessBackend ? { appServer: {
        harnessBackend: config.harnessBackend, pinGlobalAgent: false,
      } } : {}),
    };
    case "remote": return {
      backend: "remote", url: config.url,
      ...(config.tokenEnv ? { authToken: secret(config.tokenEnv) } : {}),
    };
    case "cloud": return {
      backend: "cloud",
      ...(config.apiKeyEnv ? { apiKey: secret(config.apiKeyEnv) } : {}),
      ...(config.computer ? { computer: config.computer } : {}),
    };
  }
}
