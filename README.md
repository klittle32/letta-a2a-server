# Letta A2A Server

Expose configured, existing Letta agents through the [A2A protocol](https://a2a-protocol.org/). This server adapts inbound A2A requests to the Letta Agent SDK. Configure one agent directly or use fixed named bindings for multiple agents on one listener.

## Scope

```text
A2A client → Letta A2A Server → Letta Agent SDK → configured Letta agent
```

This project does one job: expose Letta agents over A2A, including their task/context lifecycle and streaming responses. It is **not an agent registry, orchestration framework, or complex permissions system**. Fixed bindings and optional bearer authentication are provided; user/tenant management, OAuth, and broader access policies are not.

For gateway routing, agent catalogs, or centralized access policy, see projects such as [LiteLLM](https://github.com/BerriAI/litellm) and [agentgateway](https://github.com/agentgateway/agentgateway). They are optional external infrastructure, not dependencies of this server; verify compatibility with its A2A 1.0 interface.

For client tooling, use the [official A2A CLI](https://github.com/a2aproject/a2a-cli) and its [maintained agent skill](https://github.com/a2aproject/a2a-cli/blob/main/skills/a2a-cli/SKILL.md). Calling other agents belongs in the Letta agent's own tools. This server neither supplies an outbound A2A client nor installs or replaces agent tools.

## Release status

Run from a source checkout or build the Docker image below. **npm publication is deferred**: the package remains private, and a packed/installed npm artifact has not been verified. See the [release checklist](docs/development.md#release-checklist) before preparing a release.

## Quick start: one existing agent

Requires a checkout of this repository, Docker Compose, a Letta API key, and an existing Cloud agent ID. Run the commands from the repository root. The default service keeps agent state in Letta Cloud and executes in Docker—not a managed Cloud sandbox. Other [runtime backends](docs/configuration.md#runtime-backends) include fully local execution, a remote App Server, a Cloud sandbox, and a selected connected computer.

1. Put `LETTA_API_KEY=your-key` in the ignored project-root `.env`.
2. Copy the configuration and replace `agentId` with your existing agent's ID:

   ```sh
   cp config.cloud.example.json config.cloud.local.json
   ```

3. Build and start the single default service:

   ```sh
   docker compose build server
   docker compose up -d
   docker compose ps
   ```

The server retrieves the configured agent; it never creates one on startup. The optional local-state service is enabled only when selected explicitly or through its `local` profile. See [configuration](docs/configuration.md) for local-state and multi-binding setup.

For a manual check, install the optional [official Go `a2a` CLI](https://github.com/a2aproject/a2a-cli) (previously tested with `0.3.0`):

```sh
a2a --endpoint http://127.0.0.1:41241/ --transport jsonrpc --a2a-version 1.0 --timeout 180s send --stream "Hello"
```

Streaming reports safe activity followed by one complete answer; it does not expose provisional answer tokens.

## Operations and configuration

```sh
docker compose logs -f server
docker compose restart server
docker compose up -d --build server
docker compose down
```

Source is built into the image; restart alone does not pick up code changes. `down` retains volumes; avoid `down -v` unless you intend to erase local state. Both service definitions share an image tag, so select the service you intend to update.

- [Configuration reference](docs/configuration.md): runtimes, named bindings, inbound/backend credentials, advertised URLs, and persistence.
- [Development and support](docs/development.md): checks, opt-in live fixtures, verification limits, and the deferred release checklist.

Compose publishes ports on host loopback. Bearer authentication does not add TLS, process isolation, or multi-tenant security. Bindings to the same Letta agent share its memory. A2A task/context mappings reset on restart unless durable state is configured. Interrupted work is not automatically replayed, and interruption does not prove the backend stopped.

Effect 4 owns configuration and resource lifecycle; the official A2A and Letta SDKs handle protocol and execution. This project is [MIT licensed](LICENSE); dependencies retain their own licenses.
