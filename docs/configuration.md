# Configuration reference

The server accepts either the legacy single-agent object or the multi-binding application object. JSON is strict: unknown properties and invalid routes are rejected at startup. The shipped files `config.example.json`, `config.cloud.example.json`, and `config.bindings.example.json` are starting points; copy them to ignored local files before adding IDs or credentials.

Compose mounts the selected config read-only as `/app/config.local.json`. `A2A_CONFIG_FILE` selects the `server` config (default `./config.cloud.local.json`); `A2A_LOCAL_CONFIG_FILE` selects the `local` config (default `./config.local.json`). The `.env` file supplies Compose variable interpolation. Arbitrary token environment variables must also be explicitly passed to the relevant service; adding a variable to `.env` alone does not inject it into the container.

## Legacy single-agent form

```json
{
  "agentId": "existing-agent-id",
  "name": "Support agent",
  "backend": { "type": "local", "harnessBackend": "api" },
  "publicUrl": "http://127.0.0.1:41241/",
  "port": 41241,
  "peers": {}
}
```

`agentId` must identify an existing agent. `name` defaults to `Letta A2A Agent`; `port` defaults to `41241`; `publicUrl` defaults to `http://127.0.0.1:41241/`. `cwd` is an optional runtime working directory. `stateDirectory` enables durable A2A state. `peers` defaults to empty.

For an authenticated single agent, use the application form with one entry in `bindings`; the legacy object has no inbound `auth` field.

## Runtime backends

The backend selects the Letta SDK connection and execution environment. It does not select the A2A transport.

| Configuration | Meaning |
| --- | --- |
| `{"type":"local"}` | SDK-managed App Server and local state in the server process environment. Without `harnessBackend`, the SDK's default local behavior applies. |
| `{"type":"local","harnessBackend":"local"}` | SDK-managed local backend, as used by the Compose `local` service. Its agents live in that service's runtime volume. |
| `{"type":"local","harnessBackend":"api"}` | SDK-managed App Server using Cloud agent state and models, as used by Compose `server`. Execution still runs in the container; this is not the managed Cloud sandbox. |
| `{"type":"remote","url":"http://host.docker.internal:8283","tokenEnv":"APP_SERVER_TOKEN"}` | Connect to an already-running App Server. `url` accepts HTTP(S)/WS(S); optional `tokenEnv` names its bearer credential. State, execution machine, and lifecycle belong to that server. |
| `{"type":"cloud","apiKeyEnv":"LETTA_API_KEY"}` | Letta Cloud backend. `apiKeyEnv` defaults according to the SDK if omitted. |
| `{"type":"cloud","computer":"device-id"}` | Cloud agent using the selected computer. `computer` may be a string, `{ "deviceId": "..." }`, or `{ "name": "..." }`. `cwd`, if set, belongs to the execution environment. |

Compose's ordinary `server` uses `local` plus `harnessBackend: api`; do not describe this as SDK-managed Cloud sandbox execution. The `local` service uses `local` plus `harnessBackend: local`.

## Several fixed agents on one listener

The application form has shared listener settings, named backend `connections`, and a `bindings` record. Each binding defines a route, existing agent, display name, optional working directory, peers, auth, and state directory. See `config.bindings.example.json` for a complete example. Its top-level `publicUrl` is `http://127.0.0.1:41242/agents/`, with `/first` and `/second` binding paths.

Each binding owns SDK client/session resources, task and conversation mapping, outbound peer context, and tools. Reusing a message or context ID on another binding does not select the first binding's conversation; task lookup and cancellation do not cross routes. `connections` reuses backend settings, not application clients. Two bindings that reference the same Letta agent still share that agent's memory.

Routes must be unique and non-overlapping. Reserved paths include `/healthz`, `/.well-known/agent-card.json`, and `/rpc`. A root binding cannot be combined with other bindings. The path is mounted in full; a reverse proxy must preserve its prefix.

## Advertised URLs and reachability

`publicUrl` is the externally advertised URL, including any path prefix. The server mounts the configured path and does not derive public addresses from Host or forwarding headers.

The configured **outbound peer URL must be reachable from the server process**. The server's own **advertised `publicUrl` must be reachable by intended clients**; it need not be reachable from inside the container. For example, the host CLI reaches the Compose local service at `http://127.0.0.1:41242/`, while the container listens on port `41241`.

Docker loopback port publishing is a development exposure choice, not a trusted-network security guarantee. For externally reachable endpoints, use HTTPS and a TLS terminating proxy. Anonymous application bindings are limited to loopback URLs. Bearer-protected non-loopback public URLs require HTTPS in configuration.

## Inbound authentication

Add an auth object to a binding:

```json
"auth": { "tokenEnv": "A2A_FIRST_TOKEN", "owner": "operator" }
```

Pass `A2A_FIRST_TOKEN` into the server container explicitly. Clients send `Authorization: Bearer …`; protected Agent Card discovery and RPC/SSE calls both require it. `owner` is a stable identity across token rotation, not the token. A shared token is a single trust domain, not per-user authorization.

Inbound A2A credentials are not reused as Letta/App Server or outbound peer credentials. Credential separation at the request layer is not an SDK child-process environment sandbox. Do not place secret values in configuration files; configuration stores environment variable names.

## Outbound peers

Each binding may configure peer aliases as URL strings or objects with a separate bearer credential:

```json
"peers": {
  "helper": {
    "url": "https://peer.example/agents/helper/",
    "auth": { "tokenEnv": "HELPER_TOKEN", "owner": "this-server" }
  }
}
```

Peer credentials are separate from inbound A2A, App Server, and Letta credentials. Pass each named token explicitly to the server process. Peer URLs must be reachable from that process. URL aliases for the same endpoint must use the same credential policy. The server applies destination guards and does not rewrite host ports, proxy prefixes, or auth policies.

`a2a_invoke` and `a2a_task` are available only to sessions hosted by this server. They are not installed globally into the agent's other conversations. Interactive tool approval requests are denied; configured A2A tools are allowed, and native tools remain subject to the selected runtime's permissions.

## Execution behavior

The server exposes text-only A2A 1.0 JSON-RPC/SSE. A turn has a two-minute execution deadline in both in-memory and durable profiles. Deadline expiry requests interruption; it does not certify that the backend stopped. Streaming emits safe activity updates followed by one complete answer artifact. Input/auth-required questions remain status messages; failed or canceled turns do not publish an answer.

## Durable state

Set `stateDirectory` to a persistent path to retain A2A tasks, Letta conversation mappings, recovery records, and outbound peer mappings. In a single-agent config it names that binding's directory. In multi-binding config, the application-level root receives one subdirectory per binding ID; a binding-level value names that binding's exact directory.

Directories must not overlap, and one process must own each binding directory. The default Compose services mount `/home/node/.letta` on separate persistent volumes. An ordinary container-layer path will not survive container replacement.

Durability is local, single-owner recovery, not distributed failover or exactly-once tool execution. Restart does not replay sent work. Unresolved execution is retained for investigation and is not declared canceled. Identity guards compare configured agent/backend selectors and credential reference names; they do not independently verify the actual backend account, principal, or machine. Never repoint state at an unrelated backend.

## Security and operational boundaries

- Server startup connects to explicit agent IDs; it does not create, reconfigure, or delete agents.
- Inbound auth, Letta auth, App Server auth, and peer auth are distinct credentials.
- A binding boundary separates A2A task/context state, not the memory of a shared Letta agent.
- Bearer auth is not TLS, user-level authorization, process isolation, or a multi-tenant boundary.
- SDK/process interruption is not evidence that remote execution stopped. Sent work is not automatically replayed.
