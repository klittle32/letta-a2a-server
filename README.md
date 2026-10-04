# Letta A2A Server

Expose configured, existing Letta agents through [A2A](https://a2a-protocol.org/). This server handles inbound A2A requests and adapts them to the Letta Agent SDK. Configure one agent directly or use named bindings for multiple agents on one listener.

Calling other agents belongs in the Letta agent's own tools, not this server. There is no server-managed outbound client, peer routing, or A2A tool injection.

## Quick start: one existing agent

Requires Docker Compose, a Letta API key, and an existing Cloud agent ID. The default service keeps agent state in Letta Cloud and executes in Docker—not a managed Cloud sandbox. Other [runtime backends](docs/configuration.md#runtime-backends) include fully local execution, a remote App Server, a Cloud sandbox, and a selected connected computer.

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
a2a --endpoint http://127.0.0.1:41241/ --transport jsonrpc --timeout 120s send --stream "Hello"
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

- [Configuration reference](docs/configuration.md): runtimes, named bindings, inbound/backend credentials, advertised URLs, persistence, and removal of obsolete `peers` settings.
- [Development and support](docs/development.md): checks, opt-in live fixtures, and verification limits.
- [Scope and acceptance plan](PLAN.md): the server-only product boundary and pending packaging work.

Compose publishes ports on host loopback. Bearer authentication does not add TLS, process isolation, or multi-tenant security. Bindings to the same Letta agent share its memory. A2A task/context mappings reset on restart unless durable state is configured. Interrupted work is not automatically replayed, and interruption does not prove the backend stopped.

Effect 4 owns configuration and resource lifecycle; the official A2A and Letta SDKs handle protocol and execution. Registry publication and installed-package verification remain pending. MIT licensing and third-party notices are retained.
