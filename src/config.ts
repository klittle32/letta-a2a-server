import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { resolve } from "node:path";
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
const remoteUrl = Schema.String.check(Schema.makeFilter((value) => {
  try { const u = new URL(value); return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }
  catch { return false; }
}));
const backend = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["local"]),
    harnessBackend: Schema.optional(Schema.Literals(["api", "local"])),
  }),
  Schema.Struct({ type: Schema.Literals(["remote"]), url: remoteUrl, tokenEnv: Schema.optional(envName) }),
  Schema.Struct({ type: Schema.Literals(["cloud"]), apiKeyEnv: Schema.optional(envName), computer: Schema.optional(computer) }),
]);
const peerAuthSchema = Schema.Struct({ tokenEnv: envName, owner: identity });
const peerSchema = Schema.Struct({ url: endpoint, auth: Schema.optional(peerAuthSchema) });
const peersSchema = Schema.Record(nonEmpty, Schema.Union([endpoint, peerSchema]));
const stateDirectory = nonEmpty;
export const serverConfigSchema = Schema.Struct({
  agentId: identity,
  name: identity.pipe(Schema.withDecodingDefaultType(Effect.succeed("Letta A2A Agent"))),
  backend,
  cwd: Schema.optional(nonEmpty),
  port: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 }))
    .pipe(Schema.withDecodingDefaultType(Effect.succeed(41241))),
  publicUrl: publicUrl.pipe(Schema.withDecodingDefaultType(Effect.succeed("http://127.0.0.1:41241/"))),
  stateDirectory: Schema.optional(stateDirectory),
  peers: peersSchema.pipe(
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
  stateDirectory: Schema.optional(stateDirectory),
  peers: peersSchema.pipe(Schema.withDecodingDefaultType(Effect.sync(() => ({})))),
  auth: Schema.optional(authSchema),
});
const applicationSchema = Schema.Struct({
  port: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })).pipe(Schema.withDecodingDefaultType(Effect.succeed(41241))),
  publicUrl: applicationUrl.pipe(Schema.withDecodingDefaultType(Effect.succeed("http://127.0.0.1:41241/"))),
  stateDirectory: Schema.optional(stateDirectory),
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
  peers: Record<string, { url: string; auth?: { tokenEnv: string; owner: string } | undefined }>;
  stateDirectory?: string;
  auth?: { tokenEnv: string; owner: string };
};
export interface ApplicationConfig { port: number; publicUrl: string; bindings: ApplicationBindingConfig[] }

function normalizeBinding(id: string, path: string, publicUrl: string, agentId: string, name: string,
  backend: ServerConfig["backend"], port: number, peers: ServerConfig["peers"],
  options: { cwd?: string; stateDirectory?: string; auth?: { tokenEnv: string; owner: string } } = {}): ApplicationBindingConfig {
  return { id, path, publicUrl: publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`, agentId, name, backend, port,
    peers: normalizePeers(peers), ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.auth ? { auth: options.auth } : {}) };
}

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
        throw new ConfigurationError({ message: "Public bindings require bearer authentication" });
      if (!isLoopback(new URL(decoded.publicUrl)) &&
          Object.values(decoded.bindings).some((binding) => binding.auth && new URL(decoded.publicUrl).protocol !== "https:"))
        throw new ConfigurationError({ message: "Bearer authentication on a public endpoint requires HTTPS" });
      const ids = Object.keys(decoded.bindings);
      if (ids.some((id) => id === "." || id === "..")) throw new ConfigurationError({ message: "Binding identity is invalid" });
      if (!ids.length) throw new ConfigurationError({ message: "Configuration must define at least one binding" });
      if (ids.length > 1 && ids.some((id) => decoded.bindings[id]?.path === ""))
        throw new ConfigurationError({ message: "Root bindings cannot be combined with mounted bindings" });
      const paths = new Set<string>();
      const statePaths: string[] = [];
      const bindings = ids.map((id): ApplicationBindingConfig => {
        const raw = decoded.bindings[id]!;
        const backendConfig = Object.hasOwn(decoded.connections, raw.connection)
          ? decoded.connections[raw.connection]
          : undefined;
        if (!backendConfig) throw new ConfigurationError({ message: "A binding references an unknown connection" });
        const pathKey = raw.path.toLowerCase();
        if (["/healthz", "/.well-known/agent-card.json", "/rpc"].includes(pathKey) ||
            paths.has(pathKey) || [...paths].some((prior) => prior.startsWith(`${pathKey}/`) || pathKey.startsWith(`${prior}/`)))
          throw new ConfigurationError({ message: "Binding routes collide with each other or a reserved endpoint" });
        paths.add(pathKey);
        const prefix = decoded.publicUrl.replace(/\/$/, "");
        const publicUrl = raw.path ? `${prefix}${raw.path}` : decoded.publicUrl;
        if (!raw.auth && !isLoopback(new URL(publicUrl))) throw new ConfigurationError({ message: "Public bindings require bearer authentication" });
        if (raw.auth && new URL(publicUrl).protocol !== "https:" && !isLoopback(new URL(publicUrl)))
          throw new ConfigurationError({ message: "Bearer authentication on a public endpoint requires HTTPS" });
        const directory = raw.stateDirectory ?? decoded.stateDirectory;
        const resolvedStateDirectory = directory
          ? (raw.stateDirectory ? directory : `${directory.replace(/\/$/, "")}/${id}`)
          : undefined;
        if (resolvedStateDirectory && statePaths.some((prior) => pathsOverlap(prior, resolvedStateDirectory)))
          throw new ConfigurationError({ message: "Durable state directories must be separate" });
        if (resolvedStateDirectory) statePaths.push(resolvedStateDirectory);
        return normalizeBinding(id, raw.path, publicUrl, raw.agentId, raw.name ?? "Letta A2A Agent",
          backendConfig, decoded.port, raw.peers, { ...(raw.cwd ? { cwd: raw.cwd } : {}),
            ...(resolvedStateDirectory ? { stateDirectory: resolvedStateDirectory } : {}), ...(raw.auth ? { auth: raw.auth } : {}) });
      });
      return { port: decoded.port, publicUrl: decoded.publicUrl, bindings };
    }
    const legacy = Schema.decodeUnknownSync(serverConfigSchema, { onExcessProperty: "error" })(value);
    return { port: legacy.port, publicUrl: legacy.publicUrl, bindings: [normalizeBinding("default", "", legacy.publicUrl,
      legacy.agentId, legacy.name, legacy.backend, legacy.port, legacy.peers,
      { ...(legacy.cwd ? { cwd: legacy.cwd } : {}), ...(legacy.stateDirectory ? { stateDirectory: legacy.stateDirectory } : {}) })] };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError({ message: "Invalid server configuration" });
  }
}

function* loadJson(path: string): Effect.fn.Return<unknown, ConfigurationError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() => new ConfigurationError({ message: "Unable to read configuration file" })));
  return yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new ConfigurationError({ message: "Invalid configuration JSON" }) });
}

export const loadApplicationConfig = Effect.fn("loadApplicationConfig")(function*(path: string):
  Effect.fn.Return<ApplicationConfig, ConfigurationError, FileSystem.FileSystem> {
  const value = yield* loadJson(path);
  return yield* Effect.try({ try: () => parseApplicationConfig(value), catch: (error) =>
    error instanceof ConfigurationError ? error : new ConfigurationError({ message: "Invalid server configuration" }) });
});

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function pathsOverlap(left: string, right: string): boolean {
  const a = resolve(left); const b = resolve(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function normalizePeers(peers: ServerConfig["peers"]): ApplicationBindingConfig["peers"] {
  return Object.fromEntries(Object.entries(peers).map(([name, peer]) => {
    const value = typeof peer === "string" ? { url: peer } : peer;
    return [name, value.auth ? { url: value.url, auth: value.auth } : { url: value.url }];
  }));
}
export function validatePeerConfiguration(peers: ApplicationBindingConfig["peers"], env: NodeJS.ProcessEnv): void {
  const policies = new Map<string, string>();
  for (const [alias, peer] of Object.entries(peers)) {
    const url = new URL(peer.url);
    if (peer.auth) {
      if (url.protocol !== "https:" && !isLoopback(url)) throw new Error("Bearer peer auth requires HTTPS");
      const token = env[peer.auth.tokenEnv];
      if (!token?.trim() || /[\r\n]/.test(token)) throw new Error(`Required environment variable ${peer.auth.tokenEnv} is missing or invalid`);
    }
    const signature = JSON.stringify(peer.auth ? [peer.auth.tokenEnv, peer.auth.owner] : null);
    const canonicalEndpoint = url.href;
    const prior = policies.get(canonicalEndpoint);
    if (prior !== undefined && prior !== signature) throw new Error("Conflicting same-URL peer alias policies");
    policies.set(canonicalEndpoint, signature);
    if (!alias.trim()) throw new Error("Invalid peer alias");
  }
}
export function validatePeerAliases(peers: ServerConfig["peers"], env: NodeJS.ProcessEnv): void {
  const normalized = normalizePeers(peers);
  validatePeerConfiguration(normalized, env);
}

export const loadConfig = Effect.fn("loadConfig")(function*(
  path: string,
): Effect.fn.Return<ServerConfig, ConfigurationError, FileSystem.FileSystem> {
  const value = yield* loadJson(path);
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
