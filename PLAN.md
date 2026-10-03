# Letta A2A Server — extraction plan

Status: Phases 1–4 are delivered in source at base commit `7890e9c8c7bd732c9c4235634000a84a5da3f055`. The currently approved focused cleanup also includes Effect/source/test fixes. Phase 5 packaging remains pending. Persistent-service activation, package publication, and deployment remain separate decisions.

Source: [letta-a2a issue #2](https://github.com/klittle32/letta-a2a/issues/2), reviewed against lab commit `2972081` on October 2, 2026.

## Product boundary

One installable, configurable Node.js service that exposes existing Letta agents as A2A agents. Each configured agent can receive A2A requests and call configured A2A peers through SDK session tools.

```text
A2A caller → Letta A2A Server → Letta Agent SDK → selected Letta runtime
                   │
                   └─ session-owned A2A client tools → A2A peer
```

The outbound tools execute in the server's SDK process, even when the Letta runtime is remote or Cloud-backed. They are available to sessions this server hosts; this does not install tools into every other conversation with that agent.

**Direct A2A communication is the baseline.** Neither agentgateway nor LiteLLM is a dependency, required service, configuration concept, or acceptance prerequisite. Kyle will test them separately. A gateway may sit in front of ordinary endpoints without the server knowing its implementation.

Keep one public server distribution. Preserve the reusable bridge/client separation internally; do not require separate library publication or introduce a plugin framework.

### Effect v4 implementation decision

Kyle approved Effect v4 and its official development-tooling guidance on October 2.
Use Effect-native configuration, typed errors, services/layers, and scoped resource
ownership for the application. Keep the official A2A and Letta SDKs as adapters;
do not replace their protocols or rewrite proven recovery logic just for style.
Fiber interruption remains distinct from confirmed remote cancellation.

Use Effect 4.0.0 and matching Node platform package, TypeScript 7.0.2, and
`@effect/tsgo` 0.48.0. The project-local prepare hook patches TypeScript; the
`@effect/language-service` tsconfig plugin supplies editor and build diagnostics.
Use one compiler diagnostics path rather than duplicate Oxlint/LSP reporting.
Enable strict checking, exact optional properties, checked indexed access, and
verbatim module syntax. Keep supported SDK/Code ranges separate from these pinned
tooling versions. Verify a floating Effect is actually rejected by the compiler.

References: [v4 devtools](https://effect.website/docs/v4/getting-started/devtools),
[installation](https://effect.website/docs/v4/getting-started/installation), and
[Schema compiler settings](https://effect.website/docs/v4/schema/introduction).

## Lean Docker development

Use Docker for local development, not as a required production dependency. Keep one Dockerfile and one Compose file alongside source, example configuration, a short README, and focused tests. No gateway or OAuth demo stack.

- Kyle's October 2 startup correction makes `docker compose up -d` the ordinary operating path. Build dependencies and the compiled application into the image; rebuild after edits rather than hot-mounting the checkout. Keep backend runtime state in separate volumes. Secrets stay in an ignored `.env`, and only the explicitly needed credential enters each service. Do not mount the host's entire Letta home or authentication directory.
- Publish development ports on host loopback only. The container may listen on its own network interface without making the service publicly accessible.
- SDK `local` mode runs inside the container. Connecting to the Mac's existing App Server uses `remote` mode; Cloud mode remains a separate configuration. Document this distinction.
- SDK-local `harnessBackend: "api"` also runs inside the container, but uses Cloud agent state and models. The ordinary Compose pair uses this native option for its Cloud-backed service and `harnessBackend: "local"` for its local-state service. Provision dedicated test identities once; normal server startup continues to bind explicit IDs only.
- Reuse a compact set of regression checks for retained behavior and one small direct-boundary smoke test. Use two configured agents to exercise isolation and bidirectional communication; do not import the lab's complete integration harness.
- Keep generated logs, reports, test artifacts, dependencies, build output, and local state out of Git. No evidence bundles, verifier frameworks, or elaborate release machinery.
- Start without live credentials using deterministic checks. Live runtime verification uses explicitly selected test agents and reports unavailable prerequisites rather than quietly borrowing production identities.

## What already exists

- `packages/letta-a2a-bridge/`: A2A 1.0 JSON-RPC/SSE handling, SDK turn runner, task/context ownership, cancellation, optional push and durable state.
- `packages/letta-a2a-client/`: outbound A2A client, context ownership, and `a2a_invoke` / `a2a_task` SDK tools.
- `examples/14-typescript-letta-agent-sdk/src/server.ts`: the closest small direct-server composition, including session-owned outbound tools.
- `services/bridge/src/index.ts` and `service-binding.ts`: an existing per-agent mounting pattern, but tied to lab OAuth, gateway routes, callbacks, and runtime setup.

Extract these foundations and their relevant tests, not the entire lab. Retain MIT notices and applicable third-party attribution. Do not rewrite protocol serialization or lifecycle machinery merely to make the new repository look different.

Concrete adaptation points:

- The lab service finds/creates agents by display name. The new server binds explicit existing agent IDs and does not create or reconfigure agents implicitly.
- The bridge currently accepts origin-only public URLs; the lab modifies cards separately to advertise mounted paths. Its `listenLoopback` helper also replaces advertised URLs with the bound loopback address. Let the new launcher own listening and exact public card URLs rather than treating that helper as a deployment API.
- The lab's remote-only client setup, `/workspace`, test model, empty-tool agents, OAuth fixture, and mandatory callback settings are not general server defaults.
- Historical live evidence is not verification of today's SDK or all three runtime modes.

## Phase 1 — verify the SDK seam and freeze the small scope (delivered)

**Goal:** establish the compatibility baseline before moving substantial code.

- Inventory the relevant tests and rerun a focused baseline; distinguish pre-existing failures from extraction regressions.
- Verify current SDK/Code APIs for existing-agent sessions, session-owned tools, close/abort behavior, and the three runtime choices below.
- Run a bounded proof against an explicitly selected test agent: one inbound turn and one outbound A2A tool call. Exercise local, remote, and Cloud paths sufficiently to expose setup or external-tool blockers early. Do not use a production agent implicitly.
- Confirm Cloud execution selection rather than assuming Cloud identity means managed-sandbox execution. Keep any unavailable path explicitly unverified; do not invent a fallback transport.
- Choose minimum supported versions from actual verification. Use the issue's `>=` policy for Letta dependency/support declarations; keep exact tested combinations and reproducible lockfiles separate from those open-ended ranges.
- Choose the ordinary noninteractive SDK permission configuration explicitly. Preserve existing approval/ownership safeguards without copying the lab's empty-tool restrictions onto every real agent or creating a new permission framework.

**Done when:** there is a short compatibility matrix, a tested SDK integration seam, and a precise list of extraction changes. Any Cloud blocker is named before advertising Cloud support.

Current registry observations, not verified compatibility: SDK `0.8.28`, Code `0.34.2`, A2A JS SDK `1.3.0`. The lab uses SDK `0.8.3` and A2A JS SDK `1.1.0`. SDK `0.8.28` itself pins Code `0.34.2`; distinguish that upstream packaging choice from this project's minimum-version policy. Do not force a broad A2A library/protocol upgrade into extraction unless necessary.

## Phase 2 — extract one working, bidirectional server (delivered)

**Goal:** a fresh local checkout can serve one existing agent and call one external peer, directly.

- Bring over the bridge, outbound client/SDK adapter, and focused tests. Leave the Letta Code mod adapter and unrelated lab applications behind.
- Add one runnable entry point, one configuration file format, environment-variable references for secrets, and clear startup errors.
- Configure one existing agent, one backend connection, its public endpoint/card identity, and optional named outbound peers. An empty peer list simply means no outbound A2A tools.
- Reuse the SDK adapter for outbound calls, binding tools to the actual ready conversation and awaiting their cleanup. Preserve bounded calls, cancellation propagation, and credential/destination restrictions.
- Default the first quick start to loopback. Use a small independent A2A test peer, not a gateway stack.
- Preserve the current text-only A2A 1.0 JSON-RPC/SSE profile and existing lifecycle semantics. Cards advertise only enabled capabilities; push callbacks are not mandatory.
- October 2 approved streaming refinement: publish safe, observed activity as standard working-status messages, then one complete final answer artifact. Do not forward assistant token deltas or private reasoning/tool payloads. Keep failure, cancellation, and input/authentication-required outcomes distinct. This changes output presentation, not the transport or execution-ownership rules.

**Done when:** an independent A2A client discovers the agent, sends a message, continues its context, and asks it to call a configured peer and return the result. No agentgateway, LiteLLM, Docker lab, global mod, or auto-created agent is required.

## Phase 3 — configure several fixed agent bindings (delivered)

**Delivered:** one process/port serves multiple fixed configured agents. The configuration and operational details are in [Configuration reference](docs/configuration.md).

Legacy and multi-binding configuration, optional inbound bearer authentication,
mounted card discovery, startup validation, and binding-owned resources are
implemented. The earlier local two-agent trial and its limits are summarized in
[Development and support](docs/development.md). The deleted Phase 3 worktree and
its activation procedure are historical; they are not setup instructions.

Compose is image-based: `docker compose run` and `docker compose up -d` do not
automatically rebuild an existing image after checkout changes. Run
`docker compose build server` before using newly changed source. Activating rebuilt code in persistent
services is separate approval. `docker compose up -d --build` rebuilds and may
recreate both services. The host CLI's local endpoint uses host port `41242`,
mapped to container port `41241`.

**Delivered boundaries:** each binding owns its route, task/conversation namespace, SDK client, peer context, and tools. Configuration validates route collisions and computes advertised paths from explicit public URLs. Caller-to-server, server-to-Letta, and server-to-peer credentials remain separate. A shared token is one trust domain; bindings that reference the same agent share its memory.

## Phase 4 — verify the complete runtime and protocol boundary (implementation delivered; activation pending)

**Goal:** the same server configuration model works across the promised runtime choices. The implementation and Phase 4 checks are delivered; persistent-service activation remains separate approval. See [Development and support](docs/development.md) for the matrix evidence and its explicit unverified cases.

| Mode | Runtime relationship |
| --- | --- |
| Local | SDK-managed local App Server; local state/execution; document the Code version supplied by the SDK. |
| Remote | Already-running App Server; its own authentication, state backend, execution machine, and lifecycle. |
| Cloud | Cloud agent/state with either a supported selected computer or managed sandbox; `cwd` belongs to that execution environment. |

The Phase 4 implementation and its bounded runtime matrix were delivered at the
base commit. The listed unverified combinations remain explicit limits; they are
not a new Phase 4 completion gate. Activating persistent services is separate
approval and does not imply that the Cloud service was activated. Evidence and
unverified cases are in
[Development and support](docs/development.md). Preserve the distinction between
cancellation requested and backend execution confirmed stopped; interruption,
disconnect, and successful turns do not prove remote stop.

## Phase 5 — package and document the standalone product (pending)

**Goal:** a new user can install it and make a successful direct call without studying the lab.

- Verify an installed/packed artifact in a clean temporary directory, not only imports from the development checkout. One common install/start path; verify it without the source repository's dependencies present.
- Keep a short product README and focused configuration/development references; avoid retaining internal worktree history or a new evidence archive.
- Retain focused tests and modest CI, not the entire lab suite. Keep raw lab history, old evidence bundles, gateway configurations, Python/Hermes demos, OAuth fixtures, and deployment experiments in `letta-a2a`.
- Review for unnecessary abstraction and configuration. Keep optional advanced capabilities out of the first quick start.
- The public repository is authorized at project initialization. Add a link from the lab when the extraction is ready and that lab change is approved. npm publication or deployment remains a separate action, not implied by implementation.

**Done when:** the packed artifact and one-agent/two-agent examples work from their instructions, licensing is intact, and all advertised behavior has evidence. Package publication and install parity have not been verified.

## Explicit non-goals

- Agent orchestration, schedulers, routing services, discovery directories, or dynamic tenants.
- A custom model-provider layer, inference gateway, OAuth issuer, or generic plugin system.
- New REST/gRPC bindings, legacy-protocol expansion, or rich media execution beyond the retained supported A2A profile.
- Distributed persistence, automatic crash replay, high availability, or a new recovery subsystem.
- Installing outbound A2A capabilities globally into unrelated Letta sessions.
- Making agentgateway or LiteLLM work as part of the server's release gate.

## Implementation rule

Work phase by phase. For each behavior change, add/update a focused test first, confirm the intended failure when practical, implement the smallest change, then run the relevant regression checks. Extraction preserves existing tests and behavior; it is not permission for unrelated refactoring. Stop at genuine compatibility or product decisions, not for new process machinery.

## Sources checked

- [Issue #2](https://github.com/klittle32/letta-a2a/issues/2)
- [Bridge foundation](https://github.com/klittle32/letta-a2a/tree/2972081/packages/letta-a2a-bridge)
- [Outbound client and SDK adapter](https://github.com/klittle32/letta-a2a/tree/2972081/packages/letta-a2a-client)
- [Direct SDK example](https://github.com/klittle32/letta-a2a/tree/2972081/examples/14-typescript-letta-agent-sdk)
- [Current SDK deployment documentation](https://docs.letta.com/agent-sdk/deployment/index.md)
- [Current SDK client-tool lifecycle documentation](https://docs.letta.com/agent-sdk/mcp/index.md)

Initial planning evidence: source, documentation, and registry metadata were inspected; no tests or live runtimes were run during planning. Record implementation verification concisely in the README rather than adding a separate evidence archive.
