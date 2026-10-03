import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Scope } from "effect";
import { NodeServices } from "@effect/platform-node";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { applicationProgram } from "../src/main.js";

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

test("normal CLI program retains the legacy single-agent config path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "letta-a2a-legacy-"));
  const configPath = join(directory, "legacy.json");
  await writeFile(configPath, JSON.stringify({ agentId: "legacy-agent", backend: { type: "local" }, port: 0, publicUrl: "http://127.0.0.1:0" }));
  const retrieved: string[] = [];
  const createClient = () => ({ agents: { async retrieve(id: string) { retrieved.push(id); return { id }; } }, async close() {} }) as unknown as LettaAgentClient;
  const scope = await Effect.runPromise(Scope.make());
  const controller = new AbortController();
  const running = Effect.runPromise(applicationProgram(configPath, createClient, "127.0.0.1", {})
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(NodeServices.layer)), { signal: controller.signal });
  try {
    for (let tries = 0; tries < 100 && retrieved.length < 1; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(retrieved).toEqual(["legacy-agent"]);
  } finally {
    controller.abort();
    await running.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
