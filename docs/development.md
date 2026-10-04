# Development and support

## Toolchain and checks

The automated suite covers startup, configuration, noninteractive approval denial, scoped shutdown, streaming, binding isolation, inbound credentials, diagnostics, and recovery. Recovery checks use deterministic interruption checkpoints and fake SDK execution; they are not live-backend crash or cancellation proofs. Test clients use the official A2A SDK to exercise this server's inbound interfaces.

Use Node `24.19.0` or newer, the declared npm `11.17.0`, and Bun `1.4.2` for tests. The lockfile's verification baseline includes Letta Agent SDK `0.8.28`, bundled Code `0.34.2`, A2A SDK `1.1.0`, Effect and `@effect/platform-node` `4.0.0`, TypeScript `7.0.2`, and `@effect/tsgo` `0.48.0`. These are tested versions, not a promise that every version allowed by the package ranges has been exercised.

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
```

To start a real host-native server after these checks, run `node dist/main.js ./my-config.json` with an [explicit configuration](configuration.md) and credentials in the process environment. Its agent must already exist in the selected backend, and `publicUrl` must match the host listener's actual URL. Compose does not hot-mount source. In an editor, use the workspace TypeScript version so the Effect language-service plugin is available; no global TypeScript installation is required.

`npm run build` replaces generated `dist/` output so deleted source modules cannot linger in the artifact. Do not store configuration or state there.

### macOS temporary-path caveat

The October 4 host check found three CLI-entrypoint test failures when the temporary directory used macOS's `/var` → `/private/var` alias. The current entrypoint compares its module URL with the invoked path without resolving filesystem aliases, so those subprocesses exited without starting the application. All tests passed with a canonical temporary path:

```sh
TMPDIR="$(node -e 'process.stdout.write(require("node:fs").realpathSync(require("node:os").tmpdir()))')" npm test
```

Use canonical filesystem paths for host CLI launches as well. This is a verified test workaround, not a runtime fix for symlinked entrypoints.

## Runtime structure

Single-agent and named-binding JSON normalize into one application configuration and startup path. Application tests and smoke fixtures use that same path rather than a separate single-agent server. SDK clients created through the application factory are application-owned; a live fixture keeps its management client separate for provisioning and cleanup. Lower-level protocol tests can still exercise the bridge directly.

The turn runner borrows its SDK client and owns each SDK session through asynchronous disposal. It uses ordinary session options and safe activity updates, without a second tool-resource lifecycle or provisional-text callback. Disposal must settle before publishing an answer or recording eligible final text. The durable execution hooks, context locks, and uncertain-execution guards remain separate and necessary.

The CLI does not configure or advertise push notifications. An internal bridge helper remains; [issue #4](https://github.com/klittle32/letta-a2a-server/issues/4) tracks the decision to expose or remove it. It is not a supported CLI feature.

## Request diagnostics

The application's bridge error hook uses the configured Effect logger, minimum log level, and inherited annotations. Request failures log at `Error`; known turn-cancellation exceptions log at `Info`. Each diagnostic includes `bindingId`, `taskId` (`unassigned` when unavailable), and a fixed `errorType` classification. These are diagnostic events, not independent proof that a backend stopped.

This hook does not forward arbitrary error names, messages, stacks, causes, request bodies, or tool payloads to the logger. It classifies known error types without reading their contents; other thrown values become `unknown`. Logger failures cannot change task outcomes or prevent resource cleanup. Upstream SDK logging is separate and unchanged. No telemetry service or additional logger dependency is required.

## Opt-in live fixtures

Unlike the provider-free `--check` above, these commands create disposable agents and make paid model calls. Choose the backend and model explicitly; provide credentials through the environment, not source/config values. The examples use `openai/gpt-5.4-mini`, which was selected for the recorded trials.

Build the image first and create the ignored config files required by the selected Compose service's bind mounts, even though the fixtures supply their own temporary server configuration. Local/remote trials require `OPENAI_API_KEY`; Cloud/computer trials require `LETTA_API_KEY`.

```sh
# Single-agent local, private remote App Server fixture, and Cloud sandbox
docker compose run --rm local npm run smoke:live -- local openai/gpt-5.4-mini
docker compose run --rm local npm run smoke:live -- remote openai/gpt-5.4-mini
docker compose run --rm server npm run smoke:live -- cloud openai/gpt-5.4-mini

# Cloud connected computer: set a selected device and a cwd on that computer
docker compose run --rm -e SMOKE_COMPUTER_DEVICE_ID=YOUR_DEVICE_ID -e SMOKE_CWD=/path/on/computer server npm run smoke:live -- computer openai/gpt-5.4-mini
```

Local uses a fresh temporary HOME. Remote starts an isolated authenticated App Server with local state. Cloud sandbox uses SDK-managed Cloud execution. Computer mode requires an explicit connected-computer ID and does not fall back to another machine; `SMOKE_CWD` belongs to that machine's filesystem. The fixture currently requires a connected-computer listener running Code `0.34.2` or newer.

The remote fixture defaults to the CLI path inside the Docker image. For a host-native run, set `SMOKE_LETTA_CLI` to the absolute path of `node_modules/@letta-ai/letta-code/letta.js` in the checkout.

The paired two-binding fixture runs inbound checks against a temporary local backend and two disposable agents:

```sh
docker compose run --rm local node --import tsx scripts/smoke-bindings.ts openai/gpt-5.4-mini
```

Close owned server/session resources before deleting disposable agents. Cleanup errors are reported. Successful turns do not prove backend cancellation or Cloud sandbox termination.

## Runtime evidence and limits

Verification is scoped, not a claim of complete A2A or runtime parity:

- **Provider-free checks:** startup, configuration, task/context ownership, bearer checks, streaming answer privacy, diagnostics, shutdown, and deterministic recovery. Run the commands above against the checkout you intend to use.
- **Live server-only checks at `aa72569` (October 4, 2026):** managed Cloud sandbox and selected connected-computer execution, authenticated Agent Cards, status-first streaming with one final answer, and cross-binding task denial through an HTTPS reverse proxy. Same-context continuation and direct completed-task retrieval were also exercised on the Cloud sandbox path. These are bounded interoperability checks, not certification of every protocol method, gateway, tool, or filesystem operation.
- **Earlier local and remote checks:** local state, Cloud state with local execution, a local two-binding setup, and an authenticated fixture-owned remote App Server were exercised before the server-only cleanup. Those trials are historical evidence, not a rerun of all current runtime combinations.

The provider-free fixture checks actual inbound HTTP discovery and invocation with a fake SDK: missing/wrong/valid bearer authentication, same-context continuation, status-first streaming with one final artifact, and matching task readback. It checks configuration mapping for four backend choices without executing them. It neither creates an agent nor makes a model call, and does not replace live runtime verification.

Still unverified: live backend stop after cancellation, independent Cloud sandbox termination, Windows, a remote App Server on a separate host, live-model crash recovery, and packed/installed npm execution. The HTTPS trial is not a public-internet deployment or security audit. Credential reference names do not independently establish the actual backend principal or machine.

## Dependency and compiler boundaries

The October 4, 2026 `npm audit` reports four high-severity entries rooted in `sharp`: [sharp/libvips advisory](https://github.com/advisories/GHSA-f88m-g3jw-g9cj) and [libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). The dependency path runs through the Letta SDK/Code and an Electron sharp wrapper. No dependency upgrade or audit fix is included in this documentation cleanup; rerun the audit when assessing a release.

The lockfile has 355 of 480 dependency entries without registry `resolved`/`integrity` metadata (excluding the root package). No lockfile repair is included here. `skipLibCheck` is enabled for upstream declarations; project application source remains strictly checked, but declaration internals in dependencies are outside that check.

Effect and `@effect/platform-node` are pinned together at `4.0.0`. TypeScript `7.0.2` and `@effect/tsgo` `0.48.0` form the project compiler pair; `npm ci` runs the local prepare hook. Follow the [v4 devtools guidance](https://effect.website/docs/v4/getting-started/devtools). Expected startup failures belong in the typed error channel; disposal failures remain visible, and resource acquisition retains uninterruptible ownership. SDK Promise adapters need not be rewritten into Effect.

## Release checklist

**npm publication is deferred.** `package.json` remains `private: true` at `0.1.0-dev.0`; the supported setup is a source checkout or a locally built Docker image. There is no published npm installation/start workflow to document yet.

Before preparing an npm release:

- Decide the package contents and a single clear install/start interface. The current manifest has no `bin` entry or explicit published-file allowlist.
- Verify a packed artifact installed in a clean directory, without checkout dependencies; exercise single-agent and named-binding setup from that installation.
- Rerun the test, compiler, build, and provider-free checks; review dependency advisories and lockfile integrity.
- Retain the MIT license and third-party notices in the distribution, and document the actually verified installation commands.

Passing repository checks is not installed-package verification. Publishing or deploying a release is a separate, explicit action.
