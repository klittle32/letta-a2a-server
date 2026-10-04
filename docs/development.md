# Development and support

## Toolchain and checks

The automated suite covers startup, configuration, noninteractive approval denial, scoped shutdown, streaming, binding isolation, inbound credentials, and recovery. Recovery checks use deterministic interruption checkpoints and fake SDK execution; they are not live-backend crash or cancellation proofs. Test clients use the official A2A SDK to exercise inbound interfaces; there is no production outbound client.

The recorded baseline used Node `24.19.0`, npm `11.17.0`, Bun `1.4.2` (test runner only), Letta Agent SDK `0.8.28`, bundled Code `0.34.2`, A2A SDK `1.1.0`, Effect and `@effect/platform-node` `4.0.0`, TypeScript `7.0.2`, and `@effect/tsgo` `0.48.0`. Live trials selected `openai/gpt-5.4-mini` explicitly. These are recorded versions, not a promise that every allowed SDK version was tested.

Build the shared Docker image before container commands:

```sh
docker compose build server
```

Provider-free checks in that image require no credentials or network:

```sh
docker run --rm --network none letta-a2a-server:dev npm test
docker run --rm --network none letta-a2a-server:dev npm run check
docker run --rm --network none letta-a2a-server:dev npm run build
docker run --rm --network none letta-a2a-server:dev npm run smoke:live -- --check
```

Host development uses npm and the lockfile; Bun is only the test runner:

```sh
npm ci
npm test
npm run check
npm run build
npm run smoke:live -- --check
node dist/main.js config.local.json
```

For host-native execution, `config.local.json` must select an agent available to that host's backend, and `publicUrl` must match the listener's actual URL. Compose does not hot-mount source. In an editor, use the workspace TypeScript version so the Effect language-service plugin is available. If dependencies exist only in Docker, run `npm ci` in the host checkout and select its workspace compiler; no global TypeScript installation is required.

`npm run build` replaces generated `dist/` output so deleted source modules cannot linger in the artifact. Do not store configuration or state there.

Server-only verification at `9b24790` on October 4, 2026 used a fresh dependency directory in Linux arm64: `npm ci`, all 87 tests, compiler checks, build, and provider-free `--check` passed. Compiled output contained no outbound client or injected-tool surface; all three configuration samples parsed, and native Node SQLite reopen/identity checks passed. Installation still emitted upstream dependency warnings. No live backend trial or persistent-service restart was performed for that change.

## Runtime structure

Single-agent and named-binding JSON normalize into one application configuration and startup path. Application tests and smoke fixtures use that same path rather than a separate single-agent server. SDK clients created through the application factory are application-owned; a live fixture keeps its management client separate for provisioning and cleanup. Lower-level protocol tests can still exercise the bridge directly.

The turn runner borrows its SDK client and owns each SDK session through asynchronous disposal. It uses ordinary session options and safe activity updates, without a second tool-resource lifecycle or provisional-text callback. Disposal must settle before publishing an answer or recording eligible final text. The durable execution hooks, context locks, and uncertain-execution guards remain separate and necessary.

The subsequent simplification was verified on October 4, 2026 in the cached Linux arm64 development image, with current source/tests/scripts mounted read-only and networking disabled: 89 tests / 432 assertions, `npm run check -- --noUnusedLocals --noUnusedParameters`, build, and provider-free smoke all passed. The smoke completed three fake SDK turns with zero agent creations or model calls. Regression coverage includes disposal-before-publication, the durable pre-session guard, and distinct owner-scoped conversations for identical wire context IDs. Independent review left no outstanding findings. This is source-level verification, not a new live-backend or installed-package proof; persistent services and the shared image were unchanged.

## Request diagnostics

The application's bridge error hook uses the configured Effect logger, minimum log level, and inherited annotations. Request failures log at `Error`; known turn-cancellation exceptions log at `Info`. Each diagnostic includes `bindingId`, `taskId` (`unassigned` when unavailable), and a fixed `errorType` classification. These are diagnostic events, not independent proof that a backend stopped.

This hook does not forward arbitrary error names, messages, stacks, causes, request bodies, or tool payloads to the logger. It classifies known error types without reading their contents; other thrown values become `unknown`. Logger failures cannot change task outcomes or prevent resource cleanup. Upstream SDK logging is separate and unchanged. No telemetry service or additional logger dependency is required.

## Opt-in live fixtures

Unlike the provider-free `--check` above, these commands create disposable agents and make paid model calls. Choose the backend and model explicitly; provide credentials through the environment, not source/config values.

```sh
# Single-agent local, private remote App Server fixture, and Cloud sandbox
docker compose run --rm local npm run smoke:live -- local openai/gpt-5.4-mini
docker compose run --rm local npm run smoke:live -- remote openai/gpt-5.4-mini
docker compose run --rm server npm run smoke:live -- cloud openai/gpt-5.4-mini

# Cloud connected computer: set a selected device and a cwd on that computer
docker compose run --rm -e SMOKE_COMPUTER_DEVICE_ID=YOUR_DEVICE_ID -e SMOKE_CWD=/path/on/computer server npm run smoke:live -- computer openai/gpt-5.4-mini
```

Local uses a fresh temporary HOME. Remote starts an isolated authenticated App Server with local state. Cloud sandbox uses SDK-managed Cloud execution. Computer mode requires an explicit connected-computer ID and does not fall back to another machine; `SMOKE_CWD` belongs to that machine's filesystem. The selected computer must meet the fixture's Code minimum.

The paired two-binding fixture runs inbound checks against a temporary local backend and two disposable agents:

```sh
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini
```

Close owned server/session resources before deleting disposable agents. Cleanup errors are reported. Successful turns do not prove backend cancellation or Cloud sandbox termination.

## Runtime evidence and limits

The following is historical verification at commit `7890e9c8c7bd732c9c4235634000a84a5da3f055`, before removal of the outbound subsystem. It does not validate the current server-only code or describe currently running containers. Historical delegation references below record past trials, not supported features. Live fixtures have been adapted but not rerun for this scope reduction. Rebuilding or activating any persistent service is a separate action.

| Runtime check at the base commit | Evidence recorded | Boundary |
| --- | --- | --- |
| Single-agent local | Explicit-model disposable trial: answer, context recall, authenticated peer invocation, status-first streaming, matching task readback, and exact-agent cleanup. | Does not establish every local SDK/Code version. |
| Two-binding local pair | Two disposable agents on one listener: authenticated discovery and invocation, reused message/context IDs with separate recall, cross-binding task denial, and exact-ID cleanup. The `--delegate` trial passed authenticated first-to-second delegation; it used six model calls. | Separate from the earlier persistent two-agent Phase 3 local trial. Shared Letta-agent memory is not isolated. |
| Private remote App Server | Fixture-owned Code `0.34.2`, local state: authenticated readiness, answer/recall, authenticated peer turn, status-first result/readback, exact-ID deletion and process cleanup. | Does not establish a separate host, Cloud state, public TLS, or other principal. |
| Cloud sandbox | Explicit-model disposable trial: answer/recall, peer turn, status-first result/readback, exact-agent cleanup. | Hosted Cloud Code version is unknown; close is best-effort and sandbox stop was not independently confirmed. |
| Earlier local API / Cloud identity | Compose Cloud-backed agent executed in Docker: answer, recall, status-first streaming, and retained IDs across service restart. | This is local API execution with Cloud identity, not SDK-managed Cloud sandbox; not an authenticated-peer Phase 4 rerun. |
| Phase 3 persistent local pair | Host Go CLI trial on local routes: separate recall and task isolation, then streaming turns. | Last persistent local trial; distinct from disposable Phase 4 delegation. |

The provider-free fixture checks actual inbound HTTP discovery and invocation with a fake SDK: missing/wrong/valid bearer authentication, same-context continuation, status-first streaming with one final artifact, and matching task readback. It checks configuration mapping for four backend choices without executing them. It neither creates an agent nor makes a model call, and does not replace live runtime verification.

Still unverified: live backend stop after cancellation; independent Cloud sandbox termination; connected-computer execution (the machine checked October 3 had M1P Desktop Code `0.33.6`, below fixture minimum `0.34.2`); Windows; public TLS/reverse-proxy operation; a remote App Server on a separate host; and live-model crash recovery. Credential reference names do not independently establish the actual backend principal or machine.

## Dependency and compiler boundaries

A recorded `npm audit` snapshot reported four high-severity entries rooted in `sharp`: [sharp/libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) and [libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). The dependency path runs through the Letta SDK/Code and an Electron sharp wrapper. This is a recorded snapshot, not a fresh audit; no dependency upgrade or audit fix is included here.

The lockfile snapshot has 355 of 480 package entries without registry `resolved`/`integrity` metadata. The noted lock-only refresh preserved versions but did not fill the metadata. No lockfile repair is included here. `skipLibCheck` is enabled for upstream declarations; project application source remains strictly checked, but declaration internals in dependencies are outside that check.

Effect and `@effect/platform-node` are pinned together at `4.0.0`. TypeScript `7.0.2` and `@effect/tsgo` `0.48.0` form the project compiler pair; `npm ci` runs the local prepare hook. Follow the [v4 devtools guidance](https://effect.website/docs/v4/getting-started/devtools). Expected startup failures belong in the typed error channel; disposal failures remain visible, and resource acquisition retains uninterruptible ownership. SDK Promise adapters need not be rewritten into Effect. Package publication and install parity remain Phase 5 work.
