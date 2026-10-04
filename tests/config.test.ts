import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { ConfigurationError, loadApplicationConfig, loadConfig, parseApplicationConfig, parseConfig, sdkOptions, serverConfigSchema, validatePeerAliases } from "../src/config.js";

const base = { agentId: "agent-example", backend: { type: "local" } };

describe("server configuration", () => {
  test("normalizes fixed multi-agent bindings with prefixed mounted URLs and per-binding auth", () => {
    const config = parseApplicationConfig({
      port: 0,
      publicUrl: "https://agents.example/gateway/",
      connections: { local: { type: "local", harnessBackend: "local" } },
      bindings: {
        a: { path: "/a", connection: "local", agentId: "existing-a", name: "A", auth: { tokenEnv: "A2A_A_TOKEN", owner: "operator" } },
        b: { path: "/b", connection: "local", agentId: "existing-b", name: "B", auth: { tokenEnv: "A2A_B_TOKEN", owner: "operator-b" } },
      },
    });
    expect(config.bindings.map((binding) => [binding.id, binding.path, binding.publicUrl, binding.agentId])).toEqual([
      ["a", "/a", "https://agents.example/gateway/a/", "existing-a"],
      ["b", "/b", "https://agents.example/gateway/b/", "existing-b"],
    ]);
    expect(config.bindings[0]?.auth).toEqual({ tokenEnv: "A2A_A_TOKEN", owner: "operator" });
    expect(config.port).toBe(0);
  });

  test("single-agent config normalizes to one root binding and loads through FileSystem", async () => {
    const normalized = parseApplicationConfig({ ...base, port: 0, publicUrl: "http://127.0.0.1:0" });
    expect(normalized.bindings).toHaveLength(1);
    expect(normalized.bindings[0]?.path).toBe("");
    const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify(base)) });
    expect((await Effect.runPromise(loadApplicationConfig("config.json").pipe(Effect.provideService(FileSystem.FileSystem, fs)))).bindings)
      .toHaveLength(1);
  });

  test("rejects root bindings when another mounted binding is configured", () => {
    expect(() => parseApplicationConfig({
      publicUrl: "http://127.0.0.1:41241/",
      connections: { local: { type: "local" } },
      bindings: {
        root: { path: "", connection: "local", agentId: "root-agent" },
        child: { path: "/child", connection: "local", agentId: "child-agent" },
      },
    })).toThrow(ConfigurationError);
  });

  test("rejects unknown connections, empty bindings, unsafe or colliding routes, and public anonymous bindings", () => {
    const multi = {
      connections: { local: { type: "local" } },
      bindings: { a: { path: "/a", connection: "local", agentId: "a" } },
    };
    for (const input of [
      { ...multi, bindings: {} },
      { ...multi, bindings: { a: { path: "/a", connection: "missing", agentId: "a" } } },
      ...["constructor", "__proto__", "toString"].map((connection) => ({
        connections: {}, bindings: { test: { path: "/test", connection, agentId: "never-started" } },
      })),
      { ...multi, bindings: { a: { path: "/healthz", connection: "local", agentId: "a" } } },
      { ...multi, bindings: {
        root: { path: "", connection: "local", agentId: "root-agent" },
        child: { path: "/child", connection: "local", agentId: "child-agent" },
      } },
      { ...multi, bindings: { a: { path: "/a%2fb", connection: "local", agentId: "a" } } },
      { ...multi, bindings: { a: { path: "/a", connection: "local", agentId: "a" }, b: { path: "/A/", connection: "local", agentId: "b" } } },
      { ...multi, publicUrl: "https://agents.example/base", bindings: multi.bindings },
    ]) expect(() => parseApplicationConfig(input)).toThrow(ConfigurationError);
  });
  test("preserves defaults, trimming, optional fields, and exact URL output", () => {
    const config = parseConfig({ ...base, agentId: " agent-example ", name: " Agent ",
      port: 0, publicUrl: "http://127.0.0.1:80", cwd: "/work",
      peers: { helper: "https://peer.example/path" },
    });
    expect(config).toEqual({ agentId: "agent-example", name: "Agent", backend: { type: "local" },
      port: 0, publicUrl: "http://127.0.0.1/", cwd: "/work", peers: { helper: "https://peer.example/path" } });
    expect(parseConfig({ ...base, name: undefined, port: undefined, peers: undefined }).name)
      .toBe("Letta A2A Agent");
    expect(parseConfig(base).port).toBe(41241);
    expect(parseConfig(base)).not.toHaveProperty("cwd");
    expect(parseConfig({ ...base, port: 65535 }).port).toBe(65535);
    expect(sdkOptions(parseConfig({ ...base, backend: { type: "remote", url: "https://example.com",
      tokenEnv: undefined } }).backend, {})).toEqual({ backend: "remote", url: "https://example.com" });
    expect(sdkOptions(parseConfig({ ...base, backend: { type: "cloud" } }).backend, {}))
      .toEqual({ backend: "cloud" });
    for (const computer of ["pc", { name: "pc" }]) {
      expect(sdkOptions(parseConfig({ ...base, backend: { type: "cloud", computer } }).backend, {}))
        .toEqual({ backend: "cloud", computer });
    }
  });

  test("normalizes authenticated peer aliases and durable state directories", () => {
    const config = parseApplicationConfig({ ...base, stateDirectory: "/var/lib/letta-a2a", peers: {
      helper: { url: "https://peer.example/rpc", auth: { tokenEnv: "PEER_TOKEN", owner: "helper-service" } },
    } });
    expect(config.bindings[0]?.peers).toEqual({ helper: {
      url: "https://peer.example/rpc", auth: { tokenEnv: "PEER_TOKEN", owner: "helper-service" },
    } });
    expect(config.bindings[0]?.stateDirectory).toBe("/var/lib/letta-a2a");
  });
  test("rejects unsafe binding IDs and state directory overlap", () => {
    for (const id of [".", "..", "../escape"]) {
      expect(() => parseApplicationConfig({ publicUrl: "http://127.0.0.1", stateDirectory: "/var/lib/server", connections: { local: { type: "local" } }, bindings: {
        [id]: { path: "/agent", connection: "local", agentId: "agent" },
      } })).toThrow(ConfigurationError);
    }
    expect(() => parseApplicationConfig({ publicUrl: "http://127.0.0.1", connections: { local: { type: "local" } }, bindings: {
      a: { path: "/a", connection: "local", agentId: "a", stateDirectory: "/var/lib/shared" },
      b: { path: "/b", connection: "local", agentId: "b", stateDirectory: "/var/lib/shared/child" },
    } })).toThrow(ConfigurationError);
  });

  test("rejects unknown keys recursively, invalid discriminants, ports, and unsafe URLs", () => {
    for (const input of [
      { ...base, extra: "secret-marker" },
      { ...base, backend: { type: "other" } },
      { ...base, backend: { url: "https://example.com" } },
      { ...base, backend: { type: "cloud", computer: { name: "pc", deviceId: "id" } } },
      { ...base, backend: { type: "cloud", computer: { deviceId: "id", extra: true } } },
      { ...base, backend: { type: "remote", url: "https://example.com", tokenEnv: "bad-name" } },
      { ...base, name: " " }, { ...base, cwd: "" },
      ...[-1, 65536, 1.5, NaN, Infinity].map((port) => ({ ...base, port })),
      ...["http://127.0.0.1/path", "http://127.0.0.1?secret-marker", "http://127.0.0.1#secret-marker",
        "http://user:secret-marker@127.0.0.1"].map((publicUrl) => ({ ...base, publicUrl })),
      ...["file:///tmp/secret-marker", "https://peer.example#secret-marker", "not-a-url"].map((url) =>
        ({ ...base, peers: { helper: url } })),
      { ...base, peers: { "": "https://peer.example" } },
    ]) {
      expect(() => parseConfig(input)).toThrow(ConfigurationError);
      try { parseConfig(input); } catch (error) {
        expect(String(error)).not.toContain("secret-marker");
      }
    }
    expect(() => Schema.decodeUnknownSync(serverConfigSchema, { onExcessProperty: "error" })({ ...base, extra: true })).toThrow();
    expect(() => Schema.decodeUnknownSync(serverConfigSchema, { onExcessProperty: "error" })({ ...base,
      backend: { type: "cloud", computer: { name: "pc", extra: true } } })).toThrow();
  });

  test("loads lazily through the public FileSystem seam", async () => {
    const reads: string[] = [];
    const fs = FileSystem.makeNoop({ readFileString: (path) => {
      reads.push(path);
      return Effect.succeed(JSON.stringify(base));
    } });
    const program = loadConfig("config.json").pipe(Effect.provideService(FileSystem.FileSystem, fs));
    expect(reads).toEqual([]);
    expect(await Effect.runPromise(program)).toEqual(parseConfig(base));
    expect(reads).toEqual(["config.json"]);
  });

  test("returns typed, safe read, JSON, and schema errors", async () => {
    for (const [fs, message] of [
      [FileSystem.makeNoop({}), "Unable to read configuration file"],
      [FileSystem.makeNoop({ readFileString: () => Effect.succeed('{"secret-marker":') }), "Invalid configuration JSON"],
      [FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ ...base, extra: "secret-marker" })) }),
        "Invalid server configuration: [property] (unknown property)"],
    ] as const) {
      const error = await Effect.runPromise(loadConfig("secret-marker.json").pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.flip,
      ));
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error._tag).toBe("ConfigurationError");
      expect(error.message).toBe(message);
      expect(JSON.stringify(error)).not.toContain("secret-marker");
    }
  });
  test("loadConfig keeps schema failures in its typed ConfigurationError channel", async () => {
    const fs = FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ ...base, backend: { type: "remote" } })) });
    const error = await Effect.runPromise(loadConfig("config.json").pipe(
      Effect.provideService(FileSystem.FileSystem, fs), Effect.flip,
    ));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error._tag).toBe("ConfigurationError");
    expect(error.message).toContain("backend (invalid value)");
  });

  test("returns actionable public-safe errors for common binding mistakes", () => {
    expect(() => parseApplicationConfig({ connections: {}, bindings: {} })).toThrow("at least one binding");
    expect(() => parseApplicationConfig({ publicUrl: "https://example.test", connections: { local: { type: "local" } },
      bindings: { a: { path: "/a", connection: "missing", agentId: "a", auth: { tokenEnv: "TOKEN", owner: "owner" } } } })).toThrow("unknown connection");
  });

  test("unknown TLS key remains a schema error and does not masquerade as an HTTPS failure", () => {
    expect(() => parseConfig({ ...base, TLS: "secret-marker" })).toThrow("unknown property");
    try { parseConfig({ ...base, TLS: "secret-marker" }); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(JSON.stringify(error)).not.toContain("secret-marker");
      expect((error as ConfigurationError).message).not.toContain("HTTPS");
    }
  });
  test("schema diagnostics identify bounded paths and reasons without values", () => {
    for (const [input, expected] of [
      [{ ...base, peers: { helper: "file://secret-value" } }, "peers (invalid value)"],
      [{ ...base, backend: { type: "remote", tokenEnv: "SECRET_ENV" } }, "backend (invalid value)"],
      [{ ...base, backend: { type: "secret-discriminant" } }, "backend"],
      [{ ...base, backend: { type: "local", secretField: "secret-value" } }, "backend (invalid value)"],
    ] as const) {
      try { parseConfig(input); throw new Error("expected parse failure"); }
      catch (error) {
        expect((error as ConfigurationError).message).toContain(expected);
        expect(JSON.stringify(error)).not.toMatch(/secret-value|SECRET_ENV|secret-discriminant/);
      }
    }
  });
  test("peer validation exposes safe typed reasons without credential names or causes", () => {
    const peers = { helper: { url: "https://peer.example", auth: { tokenEnv: "SECRET_PEER_TOKEN", owner: "helper" } } };
    try { validatePeerAliases(peers, {}); throw new Error("expected peer failure"); }
    catch (error) {
      expect((error as Error).message).toContain("environment variable is missing or invalid");
      expect(String(error)).not.toContain("SECRET_PEER_TOKEN");
    }
    const conflict = { ...peers, alternate: { url: "https://peer.example/", auth: { tokenEnv: "OTHER_TOKEN", owner: "other" } } };
    try { validatePeerAliases(conflict, { SECRET_PEER_TOKEN: "ok", OTHER_TOKEN: "ok" }); throw new Error("expected conflict"); }
    catch (error) {
      expect((error as Error).message).toContain("Conflicting same-URL peer alias policies");
      expect(String(error)).not.toContain("OTHER_TOKEN");
    }
  });
  test("binds an existing agent and defaults to direct loopback", () => {
    const config = parseConfig(base);
    expect(config.agentId).toBe("agent-example");
    expect(config.publicUrl).toBe("http://127.0.0.1:41241/");
    expect(config.peers).toEqual({});
    expect(sdkOptions(config.backend, {})).toEqual({ backend: "local" });
  });

  test("maps remote credentials from the named environment variable only", () => {
    const config = parseConfig({ ...base, backend: {
      type: "remote", url: "http://host.docker.internal:4500", tokenEnv: "APP_SERVER_TOKEN",
    }});
    expect(sdkOptions(config.backend, { APP_SERVER_TOKEN: "test-only" })).toEqual({
      backend: "remote", url: "http://host.docker.internal:4500", authToken: "test-only",
    });
    expect(() => sdkOptions(config.backend, {})).toThrow("backend credential environment variable is missing");
    expect(() => sdkOptions(config.backend, { APP_SERVER_TOKEN: " \t" })).toThrow("backend credential environment variable is missing");
  });

  test("Cloud-backed agents can execute in the local SDK runtime", () => {
    for (const harnessBackend of ["api", "local"] as const) {
      const config = parseConfig({ ...base, backend: { type: "local", harnessBackend } });
      expect(sdkOptions(config.backend, {})).toEqual({
        backend: "local", appServer: { harnessBackend, pinGlobalAgent: false },
      });
    }
    expect(() => parseConfig({ ...base, backend: { type: "local", harnessBackend: "cloud" } })).toThrow();
    expect(() => parseConfig({ ...base, backend: { type: "cloud", harnessBackend: "api" } })).toThrow();
  });

  test("Cloud execution selection is independent of agent identity", () => {
    const config = parseConfig({ ...base, backend: {
      type: "cloud", apiKeyEnv: "TEST_LETTA_KEY", computer: { deviceId: "device-test" },
    }});
    expect(sdkOptions(config.backend, { TEST_LETTA_KEY: "test-only" })).toEqual({
      backend: "cloud", apiKey: "test-only", computer: { deviceId: "device-test" },
    });
  });

  test("rejects missing identities, inline credentials, and ambiguous backend options", () => {
    for (const input of [
      { ...base, agentId: "" },
      { ...base, backend: { type: "remote", url: "http://user:secret@example.com" } },
      { ...base, backend: { type: "cloud", apiKey: "secret" } },
      { ...base, backend: { type: "local", computer: "elsewhere" } },
    ]) expect(() => parseConfig(input)).toThrow();
  });
  test("remote App Server accepts WebSocket URLs and rejects A2A-only schemes", () => {
    for (const url of ["ws://127.0.0.1:4500", "wss://app.example/ws", "http://app.example", "https://app.example"]) {
      expect(parseConfig({ ...base, backend: { type: "remote", url } }).backend).toEqual({ type: "remote", url });
    }
    for (const url of ["file:///tmp/x", "ws://user:pass@app.example"]) {
      expect(() => parseConfig({ ...base, backend: { type: "remote", url } })).toThrow();
    }
  });

  test("advertises IPv4 loopback only while allowing Docker port mapping", () => {
    for (const hostname of ["[::1]", "localhost"]) {
      expect(() => parseConfig({ ...base, publicUrl: `http://${hostname}:41241/` })).toThrow();
    }
    expect(parseConfig({ ...base, port: 41241, publicUrl: "http://127.0.0.1:4242/" }).publicUrl)
      .toBe("http://127.0.0.1:4242/");
  });

  test("single-agent configuration requires loopback URLs and rejects credential-bearing peer URLs", () => {
    expect(() => parseConfig({ ...base, publicUrl: "https://public.example" })).toThrow();
    expect(() => parseConfig({ ...base, peers: { helper: "https://peer.example?token=secret" } })).toThrow();
  });
});
