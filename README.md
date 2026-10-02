# Letta A2A Server

A small server exposing existing Letta agents through A2A. Built from the reusable
bridge and client in [letta-a2a](https://github.com/klittle32/letta-a2a), without
agentgateway, LiteLLM, or the laboratory deployment stack.

**Work in progress.** This first slice is a single-agent, loopback development
server. Public authenticated hosting and multiple bindings are not implemented
yet. See [PLAN.md](PLAN.md). No production-readiness or Cloud parity claim.

The application uses **Effect v4**: Effect Schema validates configuration,
`Server.layer` constructs scoped resources, and the Node Effect runtime handles
signals and finalization. The official A2A SDK still owns protocol handling;
the Letta SDK owns agent execution. Their Promise-based adapters retain the
existing task ownership and uncertain-cancellation safeguards.

## Docker development

```sh
docker compose build
docker compose run --rm server npm ci
docker compose run --rm server npm test
docker compose run --rm server npm run check
docker compose run --rm server npm run build
cp config.example.json config.local.json
# Set the ID of an existing test agent and its backend in config.local.json.
export A2A_CONFIG_FILE=./config.local.json
docker compose up
```

Only `src/`, `tests/`, `scripts/`, the package manifest/lockfile, both TypeScript
configs, and the selected nonsecret configuration file are bind-mounted, all read-only. Source
edits remain visible for hot reload; tests see host edits too. The whole checkout,
`.env`, `.git`, `.letta`, and host credentials are **not** mounted. Keep secrets out
of these selected inputs. Dependencies, cache, and isolated Letta state use named
volumes. Build output stays in the container; build and use it in the same run.

Without `A2A_CONFIG_FILE`, Compose mounts `config.example.json` as
`/app/config.local.json`, so installation/checks require no local config file.
A missing explicitly selected file fails instead of creating a host directory.
Recreate the service after config edits (`docker compose up --force-recreate`).
The default example cannot start a real agent until its placeholder is replaced.

The service publishes only `127.0.0.1:41241`; advertised URLs must likewise use
`127.0.0.1`, not IPv6 or `localhost`. For a different published port, set `A2A_PORT`
and the config's `publicUrl` port together; the internal `port` can remain 41241.
The container network itself is trusted: do not connect untrusted containers or
expose its port publicly. `docker compose down` preserves volumes.

The example ID is a placeholder. Startup verifies the configured existing agent;
it never creates an agent, changes its model, or replaces its tools or memory.

npm 11.17.0 and `package-lock.json` define the installation path; Bun 1.4.2 is
only the test runner. Docker is optional: with Node >=24.19, npm, and Bun available,
run `npm ci`, `npm test`, `npm run check`, and `npm run build`, then
`node dist/main.js config.local.json`. Those commands create ignored local outputs.

### Opt-in live smoke test

This is separate from `npm test`: it creates a disposable agent and makes paid
model calls. Select a model explicitly from the backend's SDK model catalog.
With the required credential exported in your shell:

```sh
# Provider-free check of the independent A2A peer fixture:
docker compose run --rm server npm run smoke:live -- --check

# Pass only the credential required by this backend:
docker compose run --rm -e OPENAI_API_KEY server npm run smoke:live -- local openai/gpt-5.4-mini
docker compose run --rm -e LETTA_API_KEY server npm run smoke:live -- cloud openai/gpt-5.4-mini
```

An ignored `.env` can stay in this worktree. Compose reads it for interpolation
but does not automatically export its keys into these containers; load the
selected key into your invoking environment. Do not mount `.env` or put secret
values in command arguments. Local tests use a fresh temporary HOME. Cloud tests
use the account's model access and SDK-managed execution, not a connected laptop.
Neither test uses an existing agent or changes account-level providers.

The test checks real answers, context recall, and a tool call to an independent
deterministic A2A peer. It prints created/deleted IDs, bounded tool diagnostics,
and cleanup outcomes, not credentials or reasoning traces. Cancellation is not proved by these successful
turns. Cloud sandbox termination on close is SDK best-effort, not independent
evidence that the sandbox stopped.

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
dependencies, a host editor cannot see the dependency volume; use an editor in an
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

`backend` selects the SDK connection, not the A2A transport:

```json
{ "type": "local" }
```

Local runs an SDK-managed App Server **inside the container**, using its isolated
Letta state. An agent on your Mac is not automatically available there.

```json
{ "type": "remote", "url": "http://host.docker.internal:4500", "tokenEnv": "APP_SERVER_TOKEN" }
```

Remote connects to an App Server you already operate. Its listener must be
reachable from Docker and appropriately authenticated; host-loopback alone may
not be reachable from the container. Omit `tokenEnv` only for a trusted,
unauthenticated development endpoint.

```json
{ "type": "cloud", "apiKeyEnv": "LETTA_API_KEY", "computer": { "deviceId": "device-example" } }
```

Cloud stores agent state in Letta Cloud. `computer` selects execution; omitting it
uses the SDK's managed-sandbox path. A top-level optional `cwd` refers to that
runtime's filesystem, not automatically the Docker filesystem. The managed-sandbox
path has live smoke coverage below; connected-computer execution remains unverified.

Keep secrets in an ignored `.env`. Compose does **not** automatically inject that
file into the container. Pass only the named secret needed for a command, e.g.
`docker compose run --rm --service-ports -e LETTA_API_KEY server`, with the value
exported in your shell. Do not mount your whole host Letta home to borrow auth.

## A2A behavior

- Agent Card: `/.well-known/agent-card.json`; JSON-RPC at `/`; health at `/healthz`.
- Text-only A2A 1.0 with streaming, task lookup, and context continuation.
- Optional `peers`, such as `{ "helper": "http://peer:41241/" }`, expose
  `a2a_invoke` and `a2a_task` to this server's sessions. Outbound tools execute in
  this server process, including for remote/Cloud runtimes. They are not global
  agent tools. Authenticated peer configuration is a later slice.
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
  Extracted durable/push internals are not yet exposed as server configuration.
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

Checkpoint (October 2, 2026): Node 24.19.0, Bun 1.4.2, installed SDK 0.8.28,
SDK-bundled Code 0.34.2, A2A SDK 1.1.0, and the pinned Effect/TypeScript toolchain
above. Clean Docker `npm ci` patches the compiler successfully; the current suite
passes 39 tests (211 assertions), Effect-enabled typecheck, and build. Compiled
Node imports also passed at the foundation checkpoint.
Compiled Node HTTP discovery and two-turn continuity also pass using fake SDK
sessions, with disposal awaited at scope exit.
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
version was not pinned. Remote App Server, Cloud connected-computer execution,
and live cancellation remain unverified. Successful turns do not prove cancellation.

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
