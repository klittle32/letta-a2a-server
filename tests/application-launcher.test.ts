import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, FileSystem, Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { applicationProgram } from "../src/main.js";

test.each(["plain directory", "project #1", "project %23"])("CLI starts from a directory named %s", async (name) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "letta-a2a-entrypoint-"));
  const directory = join(temporary, name);
  try {
    await cp(join(root, "src"), join(directory, "src"), { recursive: true });
    await cp(join(root, "package.json"), join(directory, "package.json"));
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    // A deliberately missing config proves the real CLI ran, without opening
    // an SDK connection, starting a service, or needing credentials.
    const child = spawnSync("node", ["--import", "tsx", join(directory, "src/main.ts"), join(temporary, "missing.json")], {
      cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout + child.stderr).toContain("Unable to read configuration file");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 10_000);

test("normal CLI program loads multi-binding config and retrieves each configured agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-a2a-application-"));
  const configPath = join(directory, "bindings.json");
  await writeFile(configPath, JSON.stringify({
    port: 0,
    publicUrl: "http://127.0.0.1:0/agents/",
    connections: { local: { type: "local" } },
    bindings: {
      first: { path: "/first", connection: "local", agentId: "existing-first" },
      second: { path: "/second", connection: "local", agentId: "existing-second" },
    },
  }));
  const retrieved: string[] = [];
  const clients: LettaAgentClient[] = [];
  const createClient = () => {
    const client = {
      agents: { async retrieve(id: string) { retrieved.push(id); return { id }; } },
      async close() {},
    } as unknown as LettaAgentClient;
    clients.push(client);
    return client;
  };
  const scope = await Effect.runPromise(Scope.make());
  const controller = new AbortController();
  const running = Effect.runPromise(applicationProgram(configPath, createClient, "127.0.0.1", {})
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)), { signal: controller.signal });
  try {
    for (let tries = 0; tries < 100 && retrieved.length < 2; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(retrieved.sort()).toEqual(["existing-first", "existing-second"]);
    expect(clients).toHaveLength(2);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal CLI program loads single-agent configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-a2a-single-agent-"));
  const configPath = join(directory, "single-agent.json");
  await writeFile(configPath, JSON.stringify({ agentId: "single-agent", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0" }));
  const retrieved: string[] = [];
  const createClient = () => ({ agents: { async retrieve(id: string) { retrieved.push(id); return { id }; } }, async close() {} }) as unknown as LettaAgentClient;
  const scope = await Effect.runPromise(Scope.make());
  const controller = new AbortController();
  const running = Effect.runPromise(applicationProgram(configPath, createClient, "127.0.0.1", {})
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)), { signal: controller.signal });
  try {
    for (let tries = 0; tries < 100 && retrieved.length < 1; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(retrieved).toEqual(["single-agent"]);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("default applicationProgram client uses the injected environment", async () => {
  // Keep module mocking isolated from the other tests, and resolve this checkout
  // rather than whichever directory invoked `bun test`.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const script = `
    import { mock } from "bun:test";
    import { Effect, Exit, FileSystem } from "effect";
    let captured;
    mock.module("@letta-ai/letta-agent-sdk", () => ({
      LettaAgentClient: class {
        constructor(options) {
          captured = options;
          throw new Error("Stop before any connection is opened");
        }
      }
    }));
    const { applicationProgram } = await import("./src/main.ts");
    const program = applicationProgram("unused.json", undefined, "127.0.0.1", { REVIEW_BACKEND_KEY: "injected-sentinel" })
      .pipe(Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({
        readFileString: () => Effect.succeed(JSON.stringify({ agentId: "remote-agent", backend: { type: "remote", url: "http://127.0.0.1:1", tokenEnv: "REVIEW_BACKEND_KEY" }, port: 0, publicUrl: "http://127.0.0.1:0" }))
      })));
    const exit = await Effect.runPromiseExit(program);
    console.log(JSON.stringify({ captured, failed: Exit.isFailure(exit) }));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, REVIEW_BACKEND_KEY: "process-sentinel" },
  });
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(status).toBe(0);
  expect(errors).toBe("");
  expect(JSON.parse(output)).toEqual({
    captured: { backend: "remote", url: "http://127.0.0.1:1", authToken: "injected-sentinel" },
    failed: true,
  });
});

test("launcher preserves safe backend credential errors before client creation", async () => {
  let created = false;
  const program = applicationProgram("unused.json", () => {
    created = true;
    throw new Error("PRIVATE constructor detail must not be reported");
  }, "127.0.0.1", {}).pipe(
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({
      readFileString: () => Effect.succeed(JSON.stringify({ agentId: "cloud-agent",
        backend: { type: "cloud", apiKeyEnv: "MISSING_BACKEND_KEY" } })),
    })),
    Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.message)),
  );
  expect(await Effect.runPromise(program)).toBe("Required backend credential environment variable is missing");
  expect(created).toBe(false);
});

test("launcher rejects peers before constructing any SDK client", async () => {
  for (const config of [
    { agentId: "existing", backend: { type: "local" }, peers: {} },
    { connections: { local: { type: "local" } }, bindings: {
      a: { path: "/a", connection: "local", agentId: "existing", peers: {} },
    } },
    { peers: {}, connections: { local: { type: "local" } }, bindings: {
      a: { path: "/a", connection: "local", agentId: "existing" },
    } },
  ]) {
    let created = false;
    const program = applicationProgram("unused.json", () => {
      created = true;
      throw new Error("must not construct client");
    }, "127.0.0.1", {}).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({
        readFileString: () => Effect.succeed(JSON.stringify(config)),
      })),
      Effect.catchTag("ConfigurationError", (error) => Effect.succeed(error.message)),
    );
    const message = await Effect.runPromise(program);
    expect(message).toContain("Remove the unsupported 'peers' field");
    expect(created).toBe(false);
  }
});
