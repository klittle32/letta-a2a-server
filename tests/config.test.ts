import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { ConfigurationError, loadConfig, parseConfig, sdkOptions, serverConfigSchema } from "../src/config.js";

const base = { agentId: "agent-example", backend: { type: "local" } };

describe("server configuration", () => {
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
      [FileSystem.makeNoop({ readFileString: () => Effect.succeed(JSON.stringify({ ...base, apiKey: "secret-marker" })) }),
        "Invalid server configuration"],
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
    expect(() => sdkOptions(config.backend, {})).toThrow("APP_SERVER_TOKEN");
    expect(() => sdkOptions(config.backend, { APP_SERVER_TOKEN: " \t" })).toThrow("APP_SERVER_TOKEN");
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

  test("advertises IPv4 loopback only while allowing Docker port mapping", () => {
    for (const hostname of ["[::1]", "localhost"]) {
      expect(() => parseConfig({ ...base, publicUrl: `http://${hostname}:41241/` })).toThrow();
    }
    expect(parseConfig({ ...base, port: 41241, publicUrl: "http://127.0.0.1:4242/" }).publicUrl)
      .toBe("http://127.0.0.1:4242/");
  });

  test("the first slice stays loopback-only and rejects credential-bearing peer URLs", () => {
    expect(() => parseConfig({ ...base, publicUrl: "https://public.example" })).toThrow();
    expect(() => parseConfig({ ...base, peers: { helper: "https://peer.example?token=secret" } })).toThrow();
  });
});
