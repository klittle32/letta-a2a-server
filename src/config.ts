import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { resolve } from "node:path";
import { Effect, FileSystem, Schema, SchemaIssue, SchemaTransformation } from "effect";

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
  stateDirectory?: string;
  auth?: { tokenEnv: string; owner: string };
};
export interface ApplicationConfig { port: number; publicUrl: string; bindings: ApplicationBindingConfig[] }

function normalizeBinding(id: string, path: string, publicUrl: string, agentId: string, name: string,
  backend: ServerConfig["backend"], port: number,
  options: { cwd?: string; stateDirectory?: string; auth?: { tokenEnv: string; owner: string } } = {}): ApplicationBindingConfig {
  return { id, path, publicUrl: publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`, agentId, name, backend, port,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.auth ? { auth: options.auth } : {}) };
}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String,
}) {}

function issueDetails(issue: SchemaIssue.Issue): Array<{ path: string; reason: string }> {
  const allowed = new Set(["agentId", "name", "backend", "type", "harnessBackend", "url", "tokenEnv", "apiKeyEnv",
    "computer", "deviceId", "owner", "auth", "cwd", "port", "publicUrl", "stateDirectory", "connections",
    "bindings", "path", "connection"]);
  const walk = (current: SchemaIssue.Issue, path: string, budget: { left: number }): Array<{ path: string; reason: string }> => {
    if (budget.left <= 0) return [];
    const one = (reason: string) => { budget.left--; return [{ path: path || "configuration", reason }]; };
    switch (current._tag) {
      case "Pointer": {
        const next: string = current.path.reduce<string>((result, part) => {
          if (typeof part !== "string") return `${result || "configuration"}.[entry]`;
          const safePart = allowed.has(part) ? part : "[property]";
          return result ? `${result}.${safePart}` : safePart;
        }, path);
        return walk(current.issue, next, budget);
      }
      case "Composite": {
        const out: Array<{ path: string; reason: string }> = [];
        for (const child of current.issues) {
          if (budget.left <= 0) break;
          out.push(...walk(child, path, budget));
        }
        return out;
      }
      case "AnyOf": return one("invalid value");
      case "Filter": return one("filter constraint");
      case "MissingKey": return one("missing field");
      case "UnexpectedKey": return one("unknown property");
      case "InvalidType": return one("invalid type");
      default: return one("invalid value");
    }
  };
  return walk(issue, "", { left: 4 });
}

function decodeConfig<A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown): A {
  try { return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value); }
  catch (error) {
    const issue = isRecord(error) && SchemaIssue.isIssue(error.issue) ? error.issue : error;
    const details = SchemaIssue.isIssue(issue) ? issueDetails(issue) : [];
    const message = details.length
      ? `Invalid server configuration: ${details.map(({ path, reason }) => `${path} (${reason})`).join(", ")}`
      : "Invalid server configuration";
    throw new ConfigurationError({ message });
  }
}

export function parseConfig(value: unknown): ServerConfig {
  if (isRecord(value) && Object.hasOwn(value, "peers")) throw unsupportedPeers();
  return decodeConfig(serverConfigSchema, value);
}

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  try {
    if (isRecord(value) && Object.hasOwn(value, "peers")) throw unsupportedPeers();
    if (isRecord(value) && isRecord(value.bindings) && Object.values(value.bindings).some((binding) => isRecord(binding) && Object.hasOwn(binding, "peers"))) throw unsupportedPeers();
    if (isRecord(value) && "bindings" in value) {
      const decoded = decodeConfig(applicationSchema, value);
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
          backendConfig, decoded.port, { ...(raw.cwd ? { cwd: raw.cwd } : {}),
            ...(resolvedStateDirectory ? { stateDirectory: resolvedStateDirectory } : {}), ...(raw.auth ? { auth: raw.auth } : {}) });
      });
      return { port: decoded.port, publicUrl: decoded.publicUrl, bindings };
    }
    const singleAgent = decodeConfig(serverConfigSchema, value);
    return { port: singleAgent.port, publicUrl: singleAgent.publicUrl, bindings: [normalizeBinding("default", "", singleAgent.publicUrl,
      singleAgent.agentId, singleAgent.name, singleAgent.backend, singleAgent.port,
      { ...(singleAgent.cwd ? { cwd: singleAgent.cwd } : {}), ...(singleAgent.stateDirectory ? { stateDirectory: singleAgent.stateDirectory } : {}) })] };
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
function unsupportedPeers(): ConfigurationError {
  return new ConfigurationError({ message: "Invalid server configuration: Remove the unsupported 'peers' field; this server exposes configured Letta agents only" });
}
export class SdkConfigurationError extends Schema.TaggedError<SdkConfigurationError>()("SdkConfigurationError", {
  message: Schema.String,
}) {}
export const loadConfig = Effect.fn("loadConfig")(function*(
  path: string,
): Effect.fn.Return<ServerConfig, ConfigurationError, FileSystem.FileSystem> {
  const value = yield* loadJson(path);
  return yield* Effect.try({
    try: () => decodeConfig(serverConfigSchema, value),
    catch: (error) => error instanceof ConfigurationError ? error : new ConfigurationError({ message: "Invalid server configuration" }),
  });
});

export function sdkOptions(
  config: ServerConfig["backend"],
  env: NodeJS.ProcessEnv = process.env,
): ConstructorParameters<typeof LettaAgentClient>[0] {
  const secret = (name: string): string => {
    const value = env[name];
    if (!value?.trim()) throw new SdkConfigurationError({ message: "Required backend credential environment variable is missing" });
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
