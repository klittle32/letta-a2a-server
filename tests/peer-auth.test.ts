import { expect, test } from "bun:test";
import { parseApplicationConfig } from "../src/config.js";
import { createA2AClient } from "../src/client/index.js";
import { createOfficialClientProvider } from "../src/client/a2a-invoker.js";

test("same URL aliases share one stable credential policy and reject conflicting owners", () => {
  const token = "peer-secret";
  const provide = async () => ({ owner: "peer-owner", audience: "https://peer.example", headers: { authorization: `Bearer ${token}` } });
  const policy = { destinationOrigins: ["https://peer.example"], peerIdentity: "peer:peer-owner",
    credential: { owner: "peer-owner", audience: "https://peer.example", origins: ["https://peer.example"], headerNames: ["authorization"], provide } };
  expect(() => createA2AClient({ routes: { one: "https://peer.example/rpc", two: "https://peer.example/rpc" }, routePolicies: { one: policy, two: policy } })).not.toThrow();
  expect(() => createA2AClient({ routes: { one: "https://peer.example/rpc", two: "https://peer.example/rpc" }, routePolicies: { one: policy, two: { ...policy, peerIdentity: "peer:other" } } })).toThrow("Conflicting same-URL");
});

test("peer policy configuration preserves URLs and requires a stable owner and named token environment", () => {
  const parsed = parseApplicationConfig({ agentId: "a", backend: { type: "local" }, peers: {
    helper: { url: "https://peer.example/mounted/rpc", auth: { tokenEnv: "PEER_TOKEN", owner: "peer-owner" } },
  } });
  expect(parsed.bindings[0]?.peers.helper?.url).toBe("https://peer.example/mounted/rpc");
  expect(() => parseApplicationConfig({ agentId: "a", backend: { type: "local" }, peers: {
    helper: { url: "https://peer.example", auth: { tokenEnv: "PEER_TOKEN", owner: "" } },
  } })).toThrow();
});

test("authenticated discovery strips only the configured mount suffix and keeps RPC URL callable", async () => {
  const seen: string[] = [];
  const provider = createOfficialClientProvider({
    policies: { "http://127.0.0.1:43001/gateway/agents/a/": {
      destinationOrigins: ["http://127.0.0.1:43001"], peerIdentity: "peer:test",
      credential: { owner: "owner", audience: "http://127.0.0.1:43001", origins: ["http://127.0.0.1:43001"], headerNames: ["authorization"],
        provide: async () => ({ owner: "owner", audience: "http://127.0.0.1:43001", headers: { authorization: "Bearer token" } }) },
    } },
    fetchImpl: (async (input, init) => {
      const url = String(input); seen.push(`${url} ${new Headers(init?.headers).get("authorization")}`);
      if (url.endsWith("/.well-known/agent-card.json")) return Response.json({ name: "peer", description: "peer", url: "", version: "1", protocolVersion: "0.3.0", preferredTransport: "JSONRPC", supportedInterfaces: [{ url: "http://127.0.0.1:43001/gateway/agents/a/rpc", protocolBinding: "JSONRPC", protocolVersion: "0.3.0" }], capabilities: { streaming: true, pushNotifications: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"] });
      throw new Error("Unexpected request");
    }) as typeof fetch,
  });
  const client = await provider("http://127.0.0.1:43001/gateway/agents/a/");
  expect(client).toBeDefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("/gateway/agents/a/.well-known/agent-card.json");
  expect(seen[0]).toContain("Bearer token");
});

test("same-origin mounted peer endpoints have distinct route identities", () => {
  const createPolicy = (endpoint: string) => ({ destinationOrigins: ["https://peer.example"],
    peerIdentity: `peer:${endpoint}`, credential: { owner: "service", audience: endpoint,
      origins: ["https://peer.example"], headerNames: ["authorization"],
      provide: async () => ({ owner: "service", audience: endpoint, headers: { authorization: "Bearer token" } }) } });
  const policies = { one: createPolicy("https://peer.example/one"), two: createPolicy("https://peer.example/two") };
  const client = createA2AClient({ routes: { one: "https://peer.example/one", two: "https://peer.example/two" }, routePolicies: policies });
  client.close();
});
