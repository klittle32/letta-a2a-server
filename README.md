# Letta A2A Server

A small server exposing existing Letta agents through A2A. Built from the reusable
bridge and client in [letta-a2a](https://github.com/klittle32/letta-a2a), without
agentgateway, LiteLLM, or the laboratory deployment stack.

**Work in progress.** The server supports one existing agent or several fixed,
named agent bindings on one listener. Optional per-binding bearer authentication
protects discovery and invocation. See [PLAN.md](PLAN.md). No production-readiness
or complete runtime-parity claim.

The application uses **Effect v4**: Effect Schema validates configuration,
the launcher acquires resources in an Effect scope, and the Node Effect runtime
handles signals and finalization. `Server.layer` also retains the single-agent
integration seam. The official A2A SDK still owns protocol handling;
the Letta SDK owns agent execution. Their Promise-based adapters retain the
existing task ownership and uncertain-cancellation safeguards.

## Run with Docker Compose

After the one-time configuration below:

```sh
docker compose up -d
docker compose ps
```

| Service | Host endpoint | Agent state | Harness and tools |
| --- | --- | --- | --- |
| `server` | `http://127.0.0.1:41241/` | Letta Cloud | Inside Docker |
| `local` | `http://127.0.0.1:41242/` | Docker `runtime` volume | Inside Docker |

The ordinary compiled server runs in both containers. It reconnects to explicit
agent IDs; startup never creates, reconfigures, or deletes agents. There is no
temporary launcher or automatic provisioning loop. This default pair remains two
separate processes; either process can instead serve multiple configured bindings.

Send messages from the host using the Go `a2a` CLI:

```sh
a2a --endpoint http://127.0.0.1:41241/ --transport jsonrpc --timeout 120s send "Hello"
a2a --endpoint http://127.0.0.1:41242/ --transport jsonrpc --timeout 120s send "Hello"
```

To see progress while waiting for one complete answer:

```sh
a2a --endpoint http://127.0.0.1:41241/ --transport jsonrpc --timeout 120s send --stream "Read /app/package.json and tell me the project name."
```

Use port `41242` for the local backend. The stream carries safe activity updates,
then the complete answer once—not words or tokens on separate lines. The Go CLI
labels activity `[status]` and the final answer `[artifact]`; “artifact” is the
protocol's output/result container, not necessarily a file. Add `--output jsonl`
to inspect the standard A2A events instead of the CLI's text rendering.

Use `--output json` for task details. Continue a conversation by passing its
`task.contextId` with `send --context-id ID`. Agent identity and memory persist,
but A2A task/context mappings reset on service restart by default. Start a new
A2A context after restarting, or explicitly enable durable state below.

```sh
docker compose logs -f              # Follow both services
docker compose restart             # Restart without deleting agents or state
docker compose down                # Stop/remove containers; retain volumes
docker compose up -d --build        # Rebuild after source/dependency changes
```

Do not use `down -v` unless you intend to erase local agent state. Both published
ports are host-loopback only; the container network is trusted. Bearer-protected
bindings do not add TLS termination or make the deployment a multi-tenant service.

### One-time configuration for a fresh checkout

Put `LETTA_API_KEY` and `OPENAI_API_KEY` in the ignored project-root `.env`.
Compose automatically passes **only** the Letta key to `server` and **only** the
OpenAI key to `local`; no shell exports or `.env` mounts are needed. Environment
variables already exported in your shell take precedence over `.env`.

```sh
cp config.cloud.example.json config.cloud.local.json
cp config.example.json config.local.json
docker compose build server
```

Replace each placeholder `agentId` with the existing agent you want to expose.
For a new dedicated pair, create them once with the native CLI:

```sh
docker compose run --rm server node_modules/.bin/letta --backend api agents create --name "A2A Compose Cloud" --model openai/gpt-5.4-mini
docker compose run --rm local node_modules/.bin/letta --backend local agents create --name "A2A Compose Local" --model openai/gpt-5.4-mini
```

Copy the returned IDs into the matching configuration files, then run
`docker compose up -d`. Do not repeat creation on each startup. A local-backend
agent must exist in the `local` service's runtime volume, not your Mac's Letta
home. Configurations are ignored and mounted read-only; missing files fail
rather than becoming host directories. `A2A_CONFIG_FILE` and
`A2A_LOCAL_CONFIG_FILE` can select alternative files.

The image includes dependencies, compiled application, source, tests, and the
opt-in smoke fixture. `.env`, local configurations, `.git`, and host Letta state
are excluded from the build context. Rebuild after edits; source is not hot-mounted.

Provider-free checks, with no credentials or state mounted:

```sh
docker run --rm --network none letta-a2a-server:dev npm test
docker run --rm --network none letta-a2a-server:dev npm run check
```

npm 11.17.0 and `package-lock.json` define the installation path; Bun 1.4.2 is
only the test runner. Docker is optional: with Node >=24.19, npm, and Bun available,
run `npm ci`, `npm test`, `npm run check`, and `npm run build`, then
`node dist/main.js config.local.json`. Those commands create ignored local outputs.
For host-native execution, use an agent available to that host's backend and
make `publicUrl` match its actual listening port; the Compose local example
advertises Docker's host-side port mapping instead.

### Several agents on one listener

`config.bindings.example.json` shows two local-backend agents sharing one listener
under `/agents/first/` and `/agents/second/`. Copy it to an ignored local file and
replace both agent IDs with agents already present in the selected runtime:

```sh
cp config.bindings.example.json config.bindings.local.json
# Set both existing agent IDs before starting.
A2A_LOCAL_CONFIG_FILE=./config.bindings.local.json docker compose up -d --build local
```

That example uses the local service's published port `41242`. It does not change
the separate Cloud-backed service. Put `A2A_LOCAL_CONFIG_FILE` in the ignored
project `.env` if this selection should persist for later Compose commands.

```sh
a2a --endpoint http://127.0.0.1:41242/agents/first/ --transport jsonrpc --timeout 120s send --stream "Hello"
a2a --endpoint http://127.0.0.1:41242/agents/second/ --transport jsonrpc --timeout 120s send --stream "Hello"
```

Each endpoint's Agent Card is at its own `/.well-known/agent-card.json` suffix.
`connections` names reusable backend **settings**, not shared application clients.
Each binding owns its SDK client, task/conversation state, outbound peer context,
and session tools. Reusing a message or context ID on another binding does not
select that binding's conversation; task lookup/cancellation cannot cross routes.
Two bindings to the same Letta agent still share that agent's memory.

`publicUrl` supplies the explicit advertised base and path prefix; `path` adds
the binding's route. The server mounts the complete path. A reverse proxy must
preserve that prefix, not silently strip it. Host and forwarding headers do not
choose advertised URLs. Anonymous bindings stay loopback-only; externally
advertised bearer-protected endpoints require HTTPS with TLS supplied outside
this Node listener.

For optional inbound authentication, add this to a binding:

```json
"auth": { "tokenEnv": "A2A_FIRST_TOKEN", "owner": "operator" }
```

Pass the named variable explicitly into the server container and use
`--auth "Bearer $A2A_FIRST_TOKEN"` on the client. The default Compose services only
inject their documented backend key; adding a key to `.env` alone does **not**
inject an arbitrary authentication variable. `owner` is a stable identity across
token rotation, not the token itself. The same token is one trust domain, not
per-person authorization. Inbound Authorization headers are not reused as SDK or
peer credentials. This is a request-authentication boundary, not an environment
sandbox between trusted server and SDK child processes. Protected cards and
RPC/SSE calls both require the token.

### Authenticated outbound peers

Each binding can declare its own peers. URL strings remain supported; an object
adds a separate outbound credential:

```json
"peers": {
  "helper": {
    "url": "https://peer.example/agents/helper/",
    "auth": { "tokenEnv": "HELPER_TOKEN", "owner": "this-server" }
  }
}
```

Pass `HELPER_TOKEN` explicitly into the container. `owner` identifies the caller
credential across rotation; the endpoint identifies the peer. Inbound A2A keys,
App Server keys, and Letta API keys are not borrowed for peer requests. Discovery
and RPC use the configured peer credential under the client's destination guards.
Aliases for the same endpoint must have the same credential policy. Different
bindings and peer endpoints retain separate outbound conversation mappings.

Peer and advertised URLs must be reachable **from the server process**, not just
from your terminal. Docker's `127.0.0.1` is the container, not the host. The server
does not silently rewrite host ports, proxy prefixes, or authentication policies.

### Optional durable state

Add `"stateDirectory": "/home/node/.letta/a2a"` to the configuration to use the
existing Compose runtime volume. In the multi-binding form, this root gets one
subdirectory per binding ID; a binding-level `stateDirectory` instead names that
binding's exact directory. The single-agent form uses the directory directly.

This retains A2A tasks, Letta conversation mappings, recovery records, and outbound
peer mappings. Directories must not overlap or alias each other, and only one
process may own a binding's directory. Store these private files on persistent
storage; an ordinary container-layer path will not survive container replacement.

Restart does not replay sent work. Unresolved execution is quarantined for
investigation, not declared canceled. Identity guards compare the configured
agent, backend settings, computer selector, and credential reference names—not
secret values or independently verified backend account/machine identities.
Do not repoint a state directory at an unrelated backend. This is local,
single-owner recovery, not distributed failover or durable tool-call deduplication.

### Opt-in live smoke test

This is separate from `npm test`: it creates a disposable agent and makes paid
model calls. Select a model explicitly from the backend's SDK model catalog.

```sh
# Provider-free check of the independent A2A peer fixture:
docker run --rm --network none letta-a2a-server:dev npm run smoke:live -- --check

# Pass only the credential required by this backend:
docker compose run --rm local npm run smoke:live -- local openai/gpt-5.4-mini
docker compose run --rm local npm run smoke:live -- remote openai/gpt-5.4-mini
docker compose run --rm server npm run smoke:live -- cloud openai/gpt-5.4-mini

# Explicit connected computer; SMOKE_CWD belongs to that computer's filesystem:
docker compose run --rm -e SMOKE_COMPUTER_DEVICE_ID=YOUR_DEVICE_ID -e SMOKE_CWD=/path/to/test-cwd server npm run smoke:live -- computer openai/gpt-5.4-mini
```

Local smoke tests use a fresh temporary HOME. The smoke fixture's `cloud` mode
tests SDK-managed sandbox execution, unlike the normal Compose `server`, whose
Cloud-backed agent executes inside Docker. Remote mode starts and stops its own
capability-authenticated native App Server with local state. Computer mode refuses
an offline or below-minimum selected listener rather than falling back elsewhere;
choose a disposable working directory on that computer. These fixtures do not use
existing agents or change account-level providers. They are developer checks,
not the normal interactive usage path.

The test checks real answers, context recall, and a tool call to an independent
bearer-protected deterministic A2A peer. The tool-call turn uses streaming and checks that tool
progress precedes a single complete answer artifact, followed by matching
`GetTask` readback. It prints created/deleted IDs, bounded tool diagnostics,
and cleanup outcomes, not credentials or reasoning traces. Cancellation is not proved by these successful
turns. Cloud sandbox termination on close is SDK best-effort, not independent
evidence that the sandbox stopped.

The separate two-binding check uses one temporary local backend and two disposable
agents. It requires an explicit model and makes four model calls:

```sh
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini
# Two additional model calls: authenticated delegation from the first agent to the second.
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini --delegate
```

It checks protected discovery under a mounted prefix, independent conversation
recall when both routes receive the same message/context IDs, and denied
cross-binding task lookup. It verifies exact-ID deletion after the server scope
closes. `--delegate` additionally requires the first agent to obtain a verification
word supplied only to the second agent's configuration. It does not activate the
multi-binding configuration in the running services.

## Effect development tools

The project follows the [v4 devtools guide](https://effect.website/docs/v4/getting-started/devtools):

- Effect and `@effect/platform-node` are pinned together at **4.0.0**.
- **TypeScript 7.0.2** and **`@effect/tsgo` 0.48.0** are a supported pair. This is
  the Go-based TypeScript compiler, not a rewrite in Go or a separate Go toolchain.
- `npm ci` runs `prepare` to patch the project-local TypeScript binary. The
  `@effect/language-service` tsconfig entry enables Effect diagnostics in both
  the language service and ordinary `npm run check` / `npm run build` commands.
- Strict checking, exact optional properties, checked indexed access, and
  verbatim module syntax are enabled. A floating Effect is a compiler error.
- We use the documented compiler diagnostics path, not a second Oxlint/Vite
  pipeline that would repeat the same Effect diagnostics.

To confirm the patched compiler:

```sh
docker compose run --rm server npx --no-install tsc --version
# Version 7.0.2+effect-tsgo.0.48.0
```

Editor integration requires the **workspace** TypeScript version. With Docker-only
dependencies, a host editor cannot see the image's dependencies; use an editor in an
environment with those dependencies, or opt into local `npm ci`, then select the
workspace compiler. No global editor settings or extensions are changed here.
The optional Effect debugger extension is separate from the project language
service. Do not run a second TypeScript-Go language server alongside Effect's.

Use `Effect.fn` for reusable operations, `Context.Service` / `Layer` for actual
dependencies, and scoped acquire/release for owned resources. Expected failures
use tagged errors. Keep SDK/Promise conversion at the integration boundaries;
do not interpret fiber interruption as confirmation that remote execution stopped.
See the [current authoring guidance](https://github.com/Effect-TS/effect/blob/main/LLMS.md)
and [Schema compiler settings](https://effect.website/docs/v4/schema/introduction),
not old v3 or pre-release examples.

## Runtime configuration

`backend` selects the SDK connection, not the A2A transport. In the multi-binding
form, put these same settings in a named `connections` entry:

```json
{ "type": "local" }
```

Local runs an SDK-managed App Server **inside the container**, using its isolated
Letta state. An agent on your Mac is not automatically available there.

```json
{ "type": "local", "harnessBackend": "api" }
```

This is the default Compose `server` configuration: the SDK-managed App Server
executes inside Docker but uses Cloud-backed agents and models. `api` is the
SDK's native name for that state backend. It uses `LETTA_API_KEY` from its
environment. Set `harnessBackend` to `local`, or omit it, for fully local state.

```json
{ "type": "remote", "url": "ws://host.docker.internal:4500", "tokenEnv": "APP_SERVER_TOKEN" }
```

Remote connects to an App Server you already operate. Its listener must be
reachable from Docker and appropriately authenticated; host-loopback alone may
not be reachable from the container. Omit `tokenEnv` only for a trusted,
unauthenticated development endpoint. Both `ws(s)` URLs and the SDK's existing
`http(s)`-to-WebSocket normalization are accepted.

```json
{ "type": "cloud", "apiKeyEnv": "LETTA_API_KEY", "computer": { "deviceId": "device-example" } }
```

Cloud stores agent state in Letta Cloud. `computer` selects execution; omitting it
uses the SDK's managed-sandbox path. Optional `cwd` belongs to each binding
(top-level in the single-agent form) and refers to that runtime's filesystem, not
automatically the Docker filesystem. The managed-sandbox
path has live smoke coverage below; connected-computer execution remains unverified.

Keep secrets in the ignored `.env`; Compose explicitly maps the required key per
service. Other runtime configurations may require another explicit environment
mapping. Never mount the whole host Letta home to borrow authentication.

## A2A behavior

- Each binding's Agent Card is at its `/.well-known/agent-card.json` suffix and
  JSON-RPC at its endpoint. Single-agent defaults remain the root paths.
  Health stays at `/healthz`, outside binding routes, and returns only `status: ok`.
- Text-only A2A 1.0 with streaming, task lookup, and context continuation.
- Streaming reports safe observed activity through standard working-status
  messages, then publishes one complete answer artifact on success. Progress
  does not forward reasoning text, raw tool arguments/results, or private runtime errors.
  “Tool requested” means the SDK observed a call/proposal; it is not proof that
  permission was granted or execution began.
  Input/authentication requests remain status messages; failed or uncertain
  turns do not publish a partial answer as a completed result. This follows the
  [official progress-then-result example](https://github.com/a2aproject/a2a-samples/blob/6603ba3f2c31a7ef33e70b9d8b5b5f8be42ac9a3/samples/python/agents/langgraph/app/agent_executor.py#L49-L79),
  using this project's A2A 1.0 SDK rather than copying the Python API.
- Optional `peers`, such as `{ "helper": "http://peer:41241/" }`, expose
  `a2a_invoke` and `a2a_task` to this server's sessions. Outbound tools execute in
  this server process, including for remote/Cloud runtimes. They are not global
  agent tools. Authenticated peer objects are described above.
- Native SDK `standard` permissions retain ordinary tools/skills and existing
  auto-approval rules. Named A2A tools are allowed; other calls that require
  interactive approval are denied because this server has no approval UI.
- Requests have a two-minute execution deadline. Cancellation requested is not
  proof that backend execution stopped; uncertain contexts are quarantined, not
  automatically retried.
- Repeated SDK tool-call IDs share their original in-flight or completed result
  within one session-owned tool group. Reusing an ID with different arguments,
  tool, or trusted scope is rejected. This also retains uncertain errors without
  replay; it is not durable deduplication across restarts or new sessions.
- Default task and context mappings are in memory and do not survive restart.
  `stateDirectory` opts into the retained durable profile; push configuration
  is not exposed by this server.
- This is one trusted caller domain. A2A transcript separation does not isolate
  the shared memory of the configured Letta agent.

## Compatibility

The manifest permits SDK >=0.8.28. The corresponding minimum Code target is
>=0.34.2, including on remote App Servers. The SDK supplies its own Code dependency
for local execution; this project's range does not override that upstream pin.
Open-ended minimums intentionally allow future breaking releases. Allowed versions
are not automatically tested versions; `package-lock.json` records the tested tree.
Lockfile limitation: 355 of 480 package entries lack registry `resolved`/`integrity`
metadata, inherited from the initial installed-tree lock generation. A lock-only
refresh in an empty Docker directory preserved every version but did not fill
those fields. `npm ci` passes; registry-integrity metadata repair remains pending.

### Phase 4 support matrix — October 3, 2026

Controller/toolchain: **Linux arm64 Docker on macOS**, Node **24.19.0**, Bun
**1.4.2**, Letta SDK **0.8.28**, bundled Code **0.34.2**, A2A SDK **1.1.0**,
Effect **4.0.0**, TypeScript **7.0.2**, effect-tsgo **0.48.0**. Live probes select
**openai/gpt-5.4-mini** explicitly. Allowed versions are not certified versions.

Final gates passed: **80 tests / 373 assertions**, Effect-enabled typecheck,
build, and the provider-free four-mode/authenticated-peer fixture. Compiled Node
also opened and reopened the SQLite profile successfully. Independent review
found no remaining blocking issue in the reviewed boundaries.

| SDK mode | Execution environment | Verified checks and limits |
| --- | --- | --- |
| Local | SDK-managed Code 0.34.2 in Docker, local agent state | Answers/recall, authenticated peer invocation, progress before one final artifact and matching GetTask; two protected mounted bindings with reused-ID isolation and cross-task denial; authenticated delegation between two actual Letta agents. Exact disposable-agent cleanup passed. |
| Local with `harnessBackend: api` | Code 0.34.2 in Docker, Cloud agent state | Earlier Compose/Go a2a 0.3.0 proof: answers, recall, status-first streaming, retained agent IDs across restart. Not a Phase 4 authenticated-peer rerun. |
| Remote | Fixture-owned capability-authenticated Code 0.34.2 App Server in Docker, local state | Wrong-key refusal, authenticated SDK readiness, answers/recall, authenticated peer invocation, progress before one final artifact, matching GetTask, exact-ID deletion readback, and owned-process cleanup passed. No separate-host, public TLS, or Cloud-state remote claim. |
| Cloud sandbox | SDK-managed Cloud execution; controller in Docker | Answers/recall, authenticated peer invocation, progress before one final artifact, matching GetTask, and exact-agent cleanup passed. Duplicate callbacks again produced only one peer receipt. Hosted Code version is not pinned or independently verified. |
| Cloud computer | Explicit current-Mac Desktop listener | **Blocked/unverified:** listener reports Code 0.33.6, below the 0.34.2 minimum. No agent created or turn dispatched; no fallback to another computer. |

Provider-free tests use real HTTP boundaries with fake SDK sessions to cover
same-context serialization and independent-context concurrency; cross-binding
get/cancel/subscribe/list isolation; disconnect without canceling accepted work;
cooperative confirmed cancellation versus interrupted-result quarantine; and
cleanup behavior. Real Node signal tests distinguish clean interruption (exit
130) from failed/incomplete cleanup (exit 1).

Durability tests reopen real SQLite state, retrieve a completed task, and resume
its mapped conversation through a fake SDK. Recovery tests seed a sent,
unresolved execution and confirm that reopening refuses context replay. These
are not a live model crash/restart or distributed-failover proof. Upgrading the
retained profile preserves its legacy agent-ID guard while adding the configured
backend identity check.

**Not verified:** live backend-stop cancellation in any mode; Cloud sandbox
termination; selected-computer execution; Windows; public remote/TLS deployment;
arbitrary future SDK versions; SDK nested-stream normalization. Successful turns,
`abort()`, interrupted results, and idle status do not establish backend stop.
The Cloud fixture requests five-minute TTL and best-effort termination, not proof
that the sandbox stopped. Phase 4 probes do not rebuild, restart, or reconfigure
the persistent trial services.

### Earlier foundation and Phase 3 checkpoints

The following records predate Phase 4; the matrix above is the current runtime
coverage boundary. Checkpoint (October 2–3, 2026): Node 24.19.0, Bun 1.4.2, installed SDK 0.8.28,
SDK-bundled Code 0.34.2, A2A SDK 1.1.0, and the pinned Effect/TypeScript toolchain
above. Clean Docker `npm ci` patched the compiler successfully; the Phase 3 suite
passed 61 tests (290 assertions), Effect-enabled typecheck, and build. Compiled
Node imports also passed at the foundation checkpoint.
Compiled Node HTTP discovery and two-turn continuity also pass using fake SDK
sessions, with disposal awaited at scope exit.
Phase 3 additionally passes the compiled two-binding example and provider-free
entrypoint, mounted discovery, authentication, configuration, and partial-startup
cleanup checks. Independent review found no remaining blocking issue.
Temporary negative probes proved that floating Effects, invalid optional fields,
and unchecked indexed access fail compilation. Tests include real Node signal
handling: clean interruption exits 130; failed SDK cleanup or incomplete bridge
shutdown exits 1. These tests use fake SDK sessions, not live agent turns.

An actual SDK local bootstrap and `agents.list()` returned zero agents inside a
fresh Docker HOME with external networking disabled; Effect scope finalization
closed the management client, its closed-client guard was verified, and the
process exited naturally. That bootstrap test used no agents, host credentials,
or model calls.

Subsequent live Docker tests used `openai/gpt-5.4-mini` and separate disposable
agents for local and Cloud-managed-sandbox execution. Both passed discovery, real
answers, same-context token recall, and a real outbound tool call to an independent
official-SDK A2A peer. Each peer returned a nonce unavailable in the prompt; the
agent returned it correctly. Exact agent deletion, scope/client cleanup, and
temporary HOME removal passed. No existing agents or account providers changed.
Only the required key was injected into each container; `.env` was not mounted.

Cloud testing exposed duplicate execution callbacks for the **same tool-call ID**
in SDK 0.8.28. Three failing regression tests reproduced the missing guard. With
session-scoped deduplication, a subsequent live Cloud run still received two
callbacks but made exactly one peer request and returned the same result to both.
Local live regression passed too. This does not establish global exactly-once
execution or fix the upstream delivery behavior.

Cloud tests requested a five-minute sandbox TTL and best-effort termination on
session close; independent sandbox termination was not checked. Hosted runtime
version was not pinned. At that checkpoint, remote App Server, Cloud connected-computer
execution, and live cancellation were unverified. Successful turns do not prove cancellation.

The Phase 3 local-backend live fixture also passed with two disposable agents on
one listener: bearer-protected discovery under `/agents/`, independent recall
despite reused A2A message/context IDs, cross-binding task denial, scope shutdown,
and verified deletion of both exact IDs. Its first run passed the interaction
checks but failed cleanup verification: a local SDK management connection opened
before agent creation retained the old agent-list view. A provider-free repro
confirmed that a fresh connection sees the created agent and can verify deletion;
the fixture now closes its preflight connection before creation. This is a fixture
lifecycle adjustment, not a server-side retry or an SDK cancellation guarantee.
Authenticated peer invocation and broader runtime combinations were not yet verified.

The two-route configuration was subsequently activated on local development port
`41242` with the original local agent and one additional persistent test agent.
Both endpoints passed Go `a2a` 0.3.0 `send --stream` checks: activity, one complete
answer, then completion. This trial uses anonymous host-loopback access. The
Cloud-backed container on `41241` was left running unchanged.

The subsequent normal Compose configuration was verified separately with two
dedicated persistent agents. Host Go `a2a` v0.3.0 completed real messages and
same-context recall against both published ports, with both harnesses executing
inside Docker. A Compose restart retained both agent IDs, and new requests passed
after restart. The built image also passed all provider-free tests with networking
disabled and contained none of the local configuration or credential files.
Unlike disposable smoke fixtures, the configured Compose agents are intentionally
retained when their services stop.

Status-first streaming was checked against both real local and Cloud-managed
SDK turns using a deterministic outbound peer. The old image failed the new
check with 23 artifact updates and no progress messages. The revised implementation
passed with three progress messages before one complete final artifact and
identical `GetTask` readback; disposable-agent deletion and cleanup passed in both
modes. Thinking-label and failure-path coverage uses mocked SDK messages; these
successful live turns do not establish live cancellation behavior or certify SDK
nested-stream normalization.
The compiled candidate also passed host Go CLI `send --stream` checks against
Cloud-backed/Docker and local/Docker agents on temporary ports: one complete
`[artifact]`, no `[artifact+]` lines, and working/completed statuses. Those checks
did not replace the normal running Compose containers. Rebuild with
`docker compose up -d --build` to activate source changes in those services.

Before the Effect migration, npm replaced the stalled Bun installer. Both
the original npm fallback and clean `npm ci` ran lifecycle scripts, including Code
vendor patches and esbuild. npm 11.17's nine-package `allowScripts` warning did
**not** mean scripts were blocked; debug logs and foreground execution confirm
success. No trust policy was changed. Upstream React peer warnings remain.

`npm audit` reports four high-severity package entries, rooted in `sharp`:
[libvips advisories](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) affect
sharp 0.34.5; [libheif advisories](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)
affect 0.34.5 and the Electron wrapper's 0.35.3. The chain is SDK → Code → sharp
(or `@janhapke/sharp-electron` → sharp); SDK and Code inherit the findings.
No automatic fix is available in this tree. A2A rejects non-text input, but Code's
image processing/native tools remain available: this is not a non-reachability
claim. No SDK/Sharp upgrade or audit fix was applied.

`Server.layer` owns the SDK client it constructs. Effect finalizers await public
`client.close()` after failed startup or server shutdown, including incomplete
shutdown. Clients passed to scoped `startServer` remain caller-owned. HTTP,
bridge, and outbound resources have separately registered finalizers in the
acquisition scope; session tools remain owned by their SDK session. Cleanup
failures remain visible, and closing management resources does not establish that
backend execution stopped. Uninterruptible SDK retrieval preserves ownership
until its actual Promise settles, including after an interruption request.

The official A2A library stays at the lab's 1.1.0 baseline for this extraction.
Type checking uses `skipLibCheck` for upstream declarations, as the lab does;
application source is still checked strictly.
