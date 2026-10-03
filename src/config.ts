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
const applicationUrl = endpoint.pipe(Schema.decodeTo(Schema.String,
  SchemaTransformation.transform({ decode: (value) => new URL(value).href, encode: (value) => value }),
)).check(Schema.makeFilter((value) => {
  const url = new URL(value);
  return !url.pathname.split("/").some((part) => part === "." || part === "..") &&
    !/%2f|%5c/i.test(url.pathname);
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

const bindingId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/));
const routePath = Schema.String.check(Schema.makeFilter((value) => {
  if (value === "") return true;
  if (!value.startsWith("/") || value.startsWith("//") || value.endsWith("/")) return false;
  if (/%2f|%5c|%2e/i.test(value)) return false;
  return value.split("/").slice(1).every((part) => /^[A-Za-z0-9._~-]+$/.test(part) && part !== "." && part !== "..");
}));
const authSchema = Schema.Struct({ tokenEnv: envName, owner: identity });
const bindingSchema = Schema.Struct({
  path: routePath,
  connection: bindingId,
  agentId: identity,
  name: Schema.optional(identity),
  cwd: Schema.optional(nonEmpty),
  peers: Schema.Record(nonEmpty, endpoint).pipe(Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
  auth: Schema.optional(authSchema),
});
const applicationSchema = Schema.Struct({
  port: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })).pipe(Schema.withDecodingDefaultType(Effect.succeed(41241))),
  publicUrl: applicationUrl.pipe(Schema.withDecodingDefaultType(Effect.succeed("http://127.0.0.1:41241/"))),
  connections: Schema.Record(bindingId, backend),
  bindings: Schema.Record(bindingId, bindingSchema),
});
export type ApplicationBindingConfig = {
  id: string;
  path: string;
  publicUrl: string;
  agentId: string;
  name: string;
  backend: ServerConfig["backend"];
  port: number;
  cwd?: string;
  peers: Record<string, string>;
  auth?: { tokenEnv: string; owner: string };
};
export interface ApplicationConfig { port: number; publicUrl: string; bindings: ApplicationBindingConfig[] }

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

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  try {
    if (isRecord(value) && "bindings" in value) {
      const decoded = Schema.decodeUnknownSync(applicationSchema, { onExcessProperty: "error" })(value);
      if (!isLoopback(new URL(decoded.publicUrl)) &&
          !(Object.values(decoded.bindings).every((binding) => !!binding.auth)))
        throw new Error("Anonymous public bindings");
      if (!isLoopback(new URL(decoded.publicUrl)) &&
          Object.values(decoded.bindings).some((binding) => binding.auth && new URL(decoded.publicUrl).protocol !== "https:"))
        throw new Error("Bearer auth requires TLS");
      const ids = Object.keys(decoded.bindings);
      if (!ids.length) throw new Error("No bindings");
      if (ids.length > 1 && ids.some((id) => decoded.bindings[id]?.path === ""))
        throw new Error("Root bindings cannot be combined with other bindings");
      const paths = new Set<string>();
      const bindings = ids.map((id): ApplicationBindingConfig => {
        const raw = decoded.bindings[id]!;
        const backendConfig = Object.hasOwn(decoded.connections, raw.connection)
          ? decoded.connections[raw.connection]
          : undefined;
        if (!backendConfig) throw new Error("Unknown connection");
        const pathKey = raw.path.toLowerCase();
        if (["/healthz", "/.well-known/agent-card.json", "/rpc"].includes(pathKey) ||
            paths.has(pathKey) || [...paths].some((prior) => prior.startsWith(`${pathKey}/`) || pathKey.startsWith(`${prior}/`)))
          throw new Error("Colliding route");
        paths.add(pathKey);
        const prefix = decoded.publicUrl.replace(/\/$/, "");
        const publicUrl = raw.path ? `${prefix}${raw.path}` : decoded.publicUrl;
        if (!raw.auth && !isLoopback(new URL(publicUrl))) throw new Error("Anonymous public binding");
        if (raw.auth && new URL(publicUrl).protocol !== "https:" && !isLoopback(new URL(publicUrl)))
          throw new Error("Bearer auth on non-TLS endpoint");
        return { id, path: raw.path, publicUrl: publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`,
          agentId: raw.agentId, name: raw.name ?? "Letta A2A Agent", backend: backendConfig,
          port: decoded.port, ...(raw.cwd ? { cwd: raw.cwd } : {}), peers: raw.peers,
          ...(raw.auth ? { auth: raw.auth } : {}) };
      });
      return { port: decoded.port, publicUrl: decoded.publicUrl, bindings };
    }
    const legacy = Schema.decodeUnknownSync(serverConfigSchema, { onExcessProperty: "error" })(value);
    return { port: legacy.port, publicUrl: legacy.publicUrl, bindings: [{
      id: "default", path: "", publicUrl: legacy.publicUrl, agentId: legacy.agentId,
      name: legacy.name, backend: legacy.backend, port: legacy.port,
      ...(legacy.cwd ? { cwd: legacy.cwd } : {}), peers: legacy.peers,
    }] };
  } catch {
    throw new ConfigurationError({ message: "Invalid server configuration" });
  }
}

export const loadApplicationConfig = Effect.fn("loadApplicationConfig")(function*(path: string):
  Effect.fn.Return<ApplicationConfig, ConfigurationError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() => new ConfigurationError({ message: "Unable to read configuration file" })));
  const value: unknown = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new ConfigurationError({ message: "Invalid configuration JSON" }) });
  return yield* Effect.try({ try: () => parseApplicationConfig(value), catch: () => new ConfigurationError({ message: "Invalid server configuration" }) });
});

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

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
