# Letta A2A Server — scope and acceptance plan

[Issue #3](https://github.com/klittle32/letta-a2a-server/issues/3) supersedes the earlier bidirectional extraction scope. This project is a focused server that exposes configured, existing Letta agents over A2A. Use the [README](README.md) for setup and [development reference](docs/development.md) for verification limits.

## Product boundary

```text
A2A caller → Letta A2A Server → Letta Agent SDK → configured Letta runtime
```

The server owns inbound transport, authentication, task/context lifecycle, and the adapter to Letta execution. It does not create agents on startup or install or replace their tools. Calling other A2A agents belongs in the agent's independently configured tools.

There is no production outbound A2A client, peer configuration, peer credential handling, outbound context store, or server-injected A2A tool. None is retained behind a flag, moved into another package, or reproduced as a demonstration subsystem. Official SDK clients in tests drive this server's inbound interfaces only.

Letta backend traffic remains required; server-only does not mean network-free. The bridge retains an optional inbound-task push-notification helper, but the CLI does not configure it or advertise that capability. [Issue #4](https://github.com/klittle32/letta-a2a-server/issues/4) tracks whether to expose or remove it. This cleanup does neither.

## Retained contract

- Bind explicit existing agent IDs; fail cleanly on retrieval or identity errors. Never provision or reconfigure an agent implicitly.
- Support local state/execution, Cloud state with local execution, direct remote App Servers, and Cloud execution in a managed sandbox or on a compatible connected computer. `cwd` belongs to the execution target. Implementation support is distinct from live verification.
- Keep single-agent configuration and fixed named bindings. Preserve public URLs, mounted paths, Agent Cards, text-only A2A 1.0 JSON-RPC/SSE, and truthful capability advertising.
- Preserve task/context continuation, readback, status streaming, cancellation, execution deadlines, and orderly shutdown.
- Publish only a settled final answer. Never expose provisional commentary through live output or restart recovery.
- Keep owner/binding isolation, separate durable directories, inbound bearer authentication, backend credentials, and loopback/HTTPS guards.
- Preserve noninteractive approval denial and the agent/runtime's normal configured tools. No server-supplied tool allowlist may become an allow-all policy.
- Preserve uncertain-execution quarantine and recovery without automatic replay. A cancellation request is not proof that the backend stopped.

## Configuration transition

Reject obsolete `peers` keys, including empty objects, with a sanitized instruction to remove them. Do not silently ignore obsolete security settings or print their values. Outbound credential references are no longer consumed.

Do not open, write, or delete existing `outbound-context.json` files. Do not reset inbound durable databases. Users remove obsolete configuration before activating the new server; existing state is left alone.

## Implementation and verification

Use focused tests first, demonstrate the intended failure where practical, make the smallest change, and rerun the retained inbound suite.

- Verify configuration rejection, no injected server tools, safe interactive denial, and unchanged agent/backend identity handling.
- Use an external official SDK client to discover a card, submit a turn, observe streaming status and one final answer, continue a context, and read matching task state.
- Keep failure/cancellation/restart answer-privacy tests, deadlines, shutdown ownership, partial-startup cleanup, and cross-owner/cross-binding access denial.
- Keep inbound missing/wrong/valid bearer checks and distinct backend credentials.
- Use the provider-free `--check` fixture for inbound HTTP/auth/protocol verification; paid disposable-agent trials remain separately opt-in. Historical trials are not new runtime validation.
- On the documented toolchain, pass `npm ci`, `npm test` (Bun), `npm run check`, `npm run build`, and `npm run smoke:live -- --check`.
- Inspect source, exports, built output, samples, and documentation: no supported outbound subsystem may remain. Remove dependencies only when no retained code needs them.

## Engineering constraints

Use Effect v4 for typed configuration/errors, scoped services, resource ownership, and process lifecycle. Retain the official SDK adapters; do not rewrite protocol or recovery code for style. Await owned cleanup without confusing fiber interruption with confirmed remote cancellation. Follow the [v4 devtools guidance](https://effect.website/docs/v4/getting-started/devtools); exact tooling versions are in the development reference.

Keep one Dockerfile and one Compose file. Ordinary `docker compose up -d` starts one configured agent; local-state and multi-binding choices remain explicit. Build source into the image, keep credentials in the environment, and retain runtime state in separate volumes. Never mount the host's entire Letta home.

Keep the repository small: no orchestration framework, gateway dependency, OAuth stack, new auth system, global agent tooling, or evidence archive. Preserve MIT licensing and third-party attribution from the original [lab extraction](https://github.com/klittle32/letta-a2a/issues/2).

## Next: Phase 5 packaging

After the server-only boundary passes review, verify a packed/installed artifact in a clean directory without checkout dependencies. Keep one clear install/start path and working single-agent/multi-binding instructions. Repository checks are not installed-package verification.

Registry publication, deployment, and changes to the source lab require separate approval.
