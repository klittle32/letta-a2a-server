# Development and support

## Toolchain and checks

The October 3 cleanup passes **88 tests / 414 assertions**, Effect compiler checks, build, the provider-free HTTP fixture, and compiled Node SQLite reopen/identity-guard checks. Regression checks fail against the original startup/factory code and when the durable-profile deadline is removed. No live model calls, dependency upgrades, image rebuilds, or persistent-service changes were made for this cleanup.

The recorded baseline used Node `24.19.0`, npm `11.17.0`, Bun `1.4.2` (test runner only), Letta Agent SDK `0.8.28`, bundled Code `0.34.2`, A2A SDK `1.1.0`, Effect and `@effect/platform-node` `4.0.0`, TypeScript `7.0.2`, and `@effect/tsgo` `0.48.0`. Live trials selected `openai/gpt-5.4-mini` explicitly. These are recorded versions, not a promise that every allowed SDK version was tested.

Build the shared Docker image before container commands:

```sh
docker compose build server
```

Provider-free checks in that image require no credentials or network:

```sh
docker run --rm --network none letta-a2a-server:dev npm test
docker run --rm --network none letta-a2a-server:dev npm run check
```

Host development uses npm and the lockfile; Bun is only the test runner:

```sh
npm ci
npm test
npm run check
npm run build
node dist/main.js config.local.json
```

For host-native execution, `config.local.json` must select an agent available to that host's backend, and `publicUrl` must match the listener's actual URL. Compose does not hot-mount source. In an editor, use the workspace TypeScript version so the Effect language-service plugin is available. If dependencies exist only in Docker, run `npm ci` in the host checkout and select its workspace compiler; no global TypeScript installation is required.

## Opt-in live fixtures

These commands create disposable agents and make paid model calls. Choose the backend and model explicitly; provide credentials through the environment, not source/config values. `--check` is provider-free and exercises the peer fixture over HTTP.

```sh
# Provider-free HTTP fixture check
docker run --rm --network none letta-a2a-server:dev npm run smoke:live -- --check

# Single-agent local, private remote App Server fixture, and Cloud sandbox
docker compose run --rm local npm run smoke:live -- local openai/gpt-5.4-mini
docker compose run --rm local npm run smoke:live -- remote openai/gpt-5.4-mini
docker compose run --rm server npm run smoke:live -- cloud openai/gpt-5.4-mini

# Cloud connected computer: set a selected device and a cwd on that computer
docker compose run --rm -e SMOKE_COMPUTER_DEVICE_ID=YOUR_DEVICE_ID -e SMOKE_CWD=/path/on/computer server npm run smoke:live -- computer openai/gpt-5.4-mini
```

Local uses a fresh temporary HOME. Remote starts an isolated authenticated App Server with local state. Cloud sandbox uses SDK-managed Cloud execution. Computer mode requires an explicit connected-computer ID and does not fall back to another machine; `SMOKE_CWD` belongs to that machine's filesystem. The selected computer must meet the fixture's Code minimum.

The paired two-binding fixture runs against a temporary local backend and two disposable agents. The `--delegate` form adds authenticated A2A delegation from the first agent to the second and makes two additional model calls:

```sh
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini --delegate
```

Close owned server/session resources before deleting disposable agents. Cleanup errors are reported. Successful turns do not prove backend cancellation or Cloud sandbox termination.

## Runtime evidence and limits

At base commit `7890e9c8c7bd732c9c4235634000a84a5da3f055`, the recorded provider-free baseline was **80 tests / 373 assertions**. The Phase 4 implementation and bounded runtime matrix were delivered; persistent-service activation is separate approval. The earlier persistent local Compose configuration remains the Phase 3 trial, and the Cloud-backed service was not activated as Phase 4.

| Runtime check at the base commit | Evidence recorded | Boundary |
| --- | --- | --- |
| Single-agent local | Explicit-model disposable trial: answer, context recall, authenticated peer invocation, status-first streaming, matching task readback, and exact-agent cleanup. | Does not establish every local SDK/Code version. |
| Two-binding local pair | Two disposable agents on one listener: authenticated discovery and invocation, reused message/context IDs with separate recall, cross-binding task denial, and exact-ID cleanup. The `--delegate` trial passed authenticated first-to-second delegation; it used six model calls. | Separate from the earlier persistent two-agent Phase 3 local trial. Shared Letta-agent memory is not isolated. |
| Private remote App Server | Fixture-owned Code `0.34.2`, local state: authenticated readiness, answer/recall, authenticated peer turn, status-first result/readback, exact-ID deletion and process cleanup. | Does not establish a separate host, Cloud state, public TLS, or other principal. |
| Cloud sandbox | Explicit-model disposable trial: answer/recall, peer turn, status-first result/readback, exact-agent cleanup. | Hosted Cloud Code version is unknown; close is best-effort and sandbox stop was not independently confirmed. |
| Earlier local API / Cloud identity | Compose Cloud-backed agent executed in Docker: answer, recall, status-first streaming, and retained IDs across service restart. | This is local API execution with Cloud identity, not SDK-managed Cloud sandbox; not an authenticated-peer Phase 4 rerun. |
| Phase 3 persistent local pair | Host Go CLI trial on local routes: separate recall and task isolation, then streaming turns. | Last persistent local trial; distinct from disposable Phase 4 delegation. |

The smoke fixture's base-commit `--check` had an incorrect ProtoJSON Bearer shape and a weak assertion. It has since been corrected to serialize the Agent Card with SDK `AgentCard.toJSON()` and exercise the protected fixture over actual HTTP, including Bearer enforcement, `private, no-store`, and wrong-token `401`. This fixture defect did not invalidate the separate authenticated route/delegation evidence above. The correction's RED/GREEN checks are recorded with the current code changes, not inferred from the historical assertion.

Still unverified: live backend stop after cancellation; independent Cloud sandbox termination; connected-computer execution (the machine checked October 3 had M1P Desktop Code `0.33.6`, below fixture minimum `0.34.2`); Windows; public TLS/reverse-proxy operation; a remote App Server on a separate host; and live-model crash recovery. Credential reference names do not independently establish the actual backend principal or machine.

## Dependency and compiler boundaries

A recorded `npm audit` snapshot reported four high-severity entries rooted in `sharp`: [sharp/libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) and [libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). The dependency path runs through the Letta SDK/Code and an Electron sharp wrapper. This is a recorded snapshot, not a fresh audit; no dependency upgrade or audit fix is included here.

The lockfile snapshot has 355 of 480 package entries without registry `resolved`/`integrity` metadata. The noted lock-only refresh preserved versions but did not fill the metadata. No lockfile repair is included here. `skipLibCheck` is enabled for upstream declarations; project application source remains strictly checked, but declaration internals in dependencies are outside that check.

Effect and `@effect/platform-node` are pinned together at `4.0.0`. TypeScript `7.0.2` and `@effect/tsgo` `0.48.0` form the project compiler pair; `npm ci` runs the local prepare hook. Follow the [v4 devtools guidance](https://effect.website/docs/v4/getting-started/devtools). Expected startup failures belong in the typed error channel; disposal failures remain visible, and resource acquisition retains uninterruptible ownership. SDK Promise adapters need not be rewritten into Effect. Package publication and install parity remain Phase 5 work.
