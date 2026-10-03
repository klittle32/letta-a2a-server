# Letta A2A Server

Expose existing Letta agents through the [A2A](https://a2a-protocol.org/) protocol. The server accepts A2A requests, runs the selected agent with the Letta Agent SDK, and can give that session tools for calling configured A2A peers. It supports a legacy single-agent configuration and multiple fixed agent bindings on one listener.

The application uses Effect 4 for configuration, resource ownership, and process lifecycle. The A2A and Letta SDKs handle protocol and agent execution. This is an early standalone server; it is not a multi-tenant security boundary or a claim of complete runtime parity. Package publication and installation from a registry remain pending.

## Quick start with Docker Compose

Requires Docker Compose and credentials for the two example runtimes. This setup runs both agents in Docker: one with Cloud state and one with local state. For Cloud sandbox or connected-computer execution, choose a different [runtime backend](docs/configuration.md#runtime-backends).

1. Put `LETTA_API_KEY` and `OPENAI_API_KEY` in the ignored project-root `.env`. Compose passes only the Letta key to `server`, and only the OpenAI key to `local`.
2. Copy the example configurations and set each `agentId` to an existing agent ID available to that service:

   ```sh
   cp config.cloud.example.json config.cloud.local.json
   cp config.example.json config.local.json
   ```

3. Build the shared image before provisioning or starting. Compose `run` and `up` do not automatically rebuild an existing image just because the checkout changed:

   ```sh
   docker compose build server
   ```

4. If you need dedicated agents, provision each once with the Letta CLI. For example:

   ```sh
   docker compose run --rm server node_modules/.bin/letta --backend api agents create --name "A2A Compose Cloud" --model openai/gpt-5.4-mini
   docker compose run --rm local node_modules/.bin/letta --backend local agents create --name "A2A Compose Local" --model openai/gpt-5.4-mini
   ```

   Put each returned ID in its matching config. A local agent must exist in the `local` service's runtime volume; it is separate from the host's Letta home. The server only connects to configured IDs and never creates agents on startup.

5. Start both services:

   ```sh
   docker compose up -d
   docker compose ps
   ```

For a manual check, install the optional [official Go `a2a` CLI](https://github.com/a2aproject/a2a-cli) (tested with `0.3.0`), then send to either service:

```sh
a2a --endpoint http://127.0.0.1:41241/ --transport jsonrpc --timeout 120s send "Hello"
a2a --endpoint http://127.0.0.1:41242/ --transport jsonrpc --timeout 120s send --stream "Hello"
```

Compose maps host port `41242` to container port `41241` for the local service; use `41242` from the host. Streaming reports safe activity followed by one complete answer. It does not stream answer tokens.

For logs, restart, stop, or rebuild:

```sh
docker compose logs -f
docker compose restart
docker compose down
docker compose up -d --build
```

`down` retains volumes and agent state; avoid `down -v` unless you intend to erase local state. `docker compose up -d --build` rebuilds and may recreate both services. To rebuild only the shared image without activating it, use `docker compose build server`; a service-specific `up -d --build local` rebuilds and recreates only `local`.

## Configuration and limits

- [Configuration reference](docs/configuration.md): single-agent and multi-binding formats, local/remote/Cloud runtimes, authentication, peers, persistence, and advertised URLs.
- [Development and support](docs/development.md): Effect toolchain, checks, historical runtime evidence, and unverified cases.

Compose publishes both ports on host loopback. This is a development trust assumption, not a network security guarantee. Bearer authentication does not add TLS, isolate SDK child processes, or make bindings multi-tenant. Bindings to the same Letta agent share its memory. A2A task and context mappings reset on restart unless durable state is configured. Interrupted work is not automatically replayed, and interruption does not prove the backend stopped. No agent is created implicitly.

MIT licensing and third-party notices are retained in the repository.
