# AIStudioToAPI — Independently Maintained Version

[中文文档](README.md) | English

A browser automation service that exposes Google AI Studio Playground through OpenAI, Gemini and Anthropic compatible APIs, with account management, model scheduling, proxy nodes and usage dashboards.

This repository is independently maintained and derived from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI), which is itself based on [Ellinav/ais2api](https://github.com/Ellinav/ais2api). It is not an official upstream release. Existing attribution is retained, and this version uses **CC BY-NC 4.0** for noncommercial use under the license terms.

## Features and changes

Upstream features include browser automation, multiple accounts, compatible APIs, tool calls, image and speech models. Availability depends on account permissions and upstream model support.

This version adds or improves:

- A dedicated accounts page with credential, Cookie, CSV and authenticator imports, filtering, batch selection, login queues and expired-session recovery.
- Per-account, per-model scheduling, concurrency limits, queues, resource allocation, cooldowns and retries.
- A Mihomo proxy node pool with account bindings, including bindings before the first login.
- Realtime request statistics, latency and model usage stored in SQLite.
- An optional anonymous dashboard on a separate port with aggregate and per-model time windows.
- Persistent console configuration, effective-state feedback and managed restarts.
- Mobile layouts and batch operations for account, proxy and status pages.

## Quick start

Use Docker Engine / Docker Desktop and Docker Compose v2. Prebuilt images are published to [`ghcr.io/naoya666/aistudiotoapi`](https://github.com/Naoya666/AIStudioToAPI/pkgs/container/aistudiotoapi) for Linux amd64 and arm64. Deployment hosts can pull them without installing Node.js or compiling source.

### Pull a prebuilt image (recommended)

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
cp .env.example .env
```

Edit `.env` and replace the example credentials:

```dotenv
API_KEYS=replace-with-your-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-your-console-password
TZ=Asia/Shanghai
CHECK_UPDATE=false
```

Keep `CHECK_UPDATE=false`: the inherited checker refers to upstream releases and images. This repository publishes its own images through GitHub Actions.

Create `compose.image.yaml` in the repository directory:

```yaml
services:
  app:
    image: ghcr.io/naoya666/aistudiotoapi:main
    init: true
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "127.0.0.1:7860:7860"
    volumes:
      - ./configs/auth:/app/configs/auth
      - ./data:/app/data
```

```bash
mkdir -p configs/auth data
docker compose -f compose.image.yaml pull app
docker compose -f compose.image.yaml up -d --no-build app
docker compose -f compose.image.yaml logs -f app
```

Open `http://localhost:7860`, sign in with your console credentials, and add a Google account.

`main` tracks the latest successful main-branch publication. Use `:sha-<full-commit-id>` for a source revision, or a published `v*` tag. For production, pin `image` to the `ghcr.io/naoya666/aistudiotoapi@sha256:...` reference shown in the successful Actions run summary.

For an existing deployment, update the Build service's `image` in its original Compose file, remove that service's `build` and `pull_policy: never`, and retain its service name, ports, environment, networks and every mount. Do not replace a production configuration with the new-instance example above. The repository's `docker-compose.yml` continues to build locally.

### Build locally with Compose

After preparing source and `.env` as above, use the included Compose file. The first build downloads the Node.js base, system packages, Camoufox and Mihomo; later builds can reuse cached layers.

```bash
docker compose up -d --build
docker compose logs -f app
```

Open `http://localhost:7860`, sign in with your console credentials, and add a Google account.

The included [docker-compose.yml](docker-compose.yml) builds the current source as `aistudio-to-api:local`, reads `.env`, enables process reaping with `init: true`, and persists:

| Host directory   | Container directory | Contents                                                                 |
| ---------------- | ------------------- | ------------------------------------------------------------------------ |
| `./configs/auth` | `/app/configs/auth` | Account sessions                                                         |
| `./data`         | `/app/data`         | Accounts, statistics, scheduler state, proxies and managed configuration |

The API/management port binds to host `127.0.0.1:7860` by default. For remote access, use an SSH tunnel or [Nginx with HTTPS](docs/en/nginx-setup.md). To expose the service directly, change the port mapping to `7860:7860`. If you change container `PORT`, also change the container side of the mapping.

### Docker CLI alternative

After preparing `.env`, run these Bash commands from the repository root:

```bash
docker build -t aistudio-to-api:local .
mkdir -p configs/auth data
docker run -d \
  --name aistudio-to-api \
  --init \
  --env-file .env \
  -p 127.0.0.1:7860:7860 \
  -v "$(pwd)/configs/auth:/app/configs/auth" \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  aistudio-to-api:local
```

Windows users can use Compose instead of translating the shell commands.

## Run from source

Node.js **22.13.0 or newer** is required; Node.js 24 matches the Dockerfile. The full background login executor depends on Linux `/proc` and POSIX process groups, so Linux or Docker is recommended.

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
npm ci
cp .env.example .env
# Edit .env before continuing.
npm run setup-auth
npm start
```

The setup script checks dependencies, downloads Camoufox and guides you through login. Sessions are saved in `configs/auth/`. Set `CAMOUFOX_EXECUTABLE_PATH` to use an existing browser installation. Source installs do not include the container's VNC environment; install Mihomo separately and set `MIHOMO_PATH` if you need the node pool. The Docker image includes Mihomo.

`npm start` builds both frontends. Use `npm run quick-start` only when the frontends are already built and unchanged. Source installs store runtime data in the repository's `data/` directory.

## Direct Playground transport

Camoufox remains required. The service opens a temporary Playground chat and initializes the official WAA service, aborting the bootstrap generation before it leaves the browser. Business requests go directly from the server through the account page to `GenerateContent`, then return to the existing scheduler and API adapters.

No custom Build App, client script update, iframe relay or port 9998 WebSocket service is required. Deploy the new server and restart. See the [implementation and acceptance record](docs/zh/playground-direct-20261029.md) for supported endpoints and limits.

## Account management

Open `/accounts` to save email/password credentials and optional TOTP secrets, import CSV accounts, upload authentication JSON, or manage the login queue. Docker deployments also provide the `/auth` VNC entry for manual login. You can bind a proxy node before logging in.

Some Google challenges require manual intervention. Credentials use restricted local plaintext storage. Do not publish `.env`, `configs/auth/`, `data/`, account exports or login screenshots. See the [account login and recovery guide](docs/zh/account-auto-login-operations.md) in Chinese for detailed requirements.

## API usage

| Protocol             | Base URL                       | Common endpoints                                                                      |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| OpenAI compatible    | `http://localhost:7860/v1`     | `/chat/completions`, `/responses`, `/embeddings`, `/models`                           |
| Gemini format        | `http://localhost:7860/v1beta` | `/models`, `/models/{model}:generateContent`, `/models/{model}:streamGenerateContent` |
| Anthropic compatible | `http://localhost:7860/v1`     | `/messages`, `/messages/count_tokens`                                                 |

List available models, then replace `MODEL_ID` with an ID from the response:

```bash
curl http://localhost:7860/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

curl http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

See [API examples](docs/en/api-examples.md) for streaming, images, speech and tool calls.

## Configuration

See [.env.example](.env.example) for environment settings. Explicitly configure `API_KEYS`; otherwise the inherited fallback is `123456`. Console login uses `WEB_CONSOLE_USERNAME` and `WEB_CONSOLE_PASSWORD`, or falls back to API keys when neither is configured. Set `SECURE_COOKIES=true` when using HTTPS.

Saved console settings override their corresponding environment values and are persisted in `data/managed-config.json`. Change the console setting or restore its environment value when needed. Compose environment changes require recreating the container.

Scheduling options are documented in the [model-aware scheduling guide](docs/zh/model-aware-scheduling.md) in Chinese. Daily scheduler cooldown resets use the fixed `America/Los_Angeles` timezone independently of `TZ`.

### Optional public dashboard

Set `PUBLIC_DASHBOARD_ENABLED=true` and `PUBLIC_DASHBOARD_PORT=7861` in `.env`, and uncomment the `127.0.0.1:7861:7861` port mapping in Compose. Run `docker compose up -d` and open `http://localhost:7861`. This port serves anonymous aggregate statistics; management remains on `7860`. See the [dashboard guide](docs/zh/public-dashboard-design.md) in Chinese.

## Updates and backups

### Prebuilt images with Compose

Record the current image reference and inspect and back up `.env`, `configs/auth/`, `data/` and any additional mounts before updating. Stop the service before copying databases and verify the backup. For digest-pinned deployments, first set `image` to the new published digest; when using `main`, pull and recreate to update:

```bash
docker compose -f compose.image.yaml pull app
# Follow the existing procedure to stop the service and create and verify a backup before switching.
docker compose -f compose.image.yaml up -d --no-deps --no-build --pull never app
docker compose -f compose.image.yaml logs --tail=100 app
```

Substitute your existing Compose filename and service name where appropriate. Verify startup, accounts, saved configuration and API access. Retain the previous image for rollback; switch back to its reference while keeping current account and usage databases.

### Local builds with Compose

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

Local-build deployments rebuild the current source; prebuilt-image deployments pull the published image instead. Back up `.env`, `configs/auth/` and `data/` before upgrading. Stop the service before copying databases:

```bash
docker compose stop
# Copy .env, configs/auth/ and data/ to a secure backup location.
docker compose up -d
```

`docker compose down` removes containers but preserves host bind directories. Do not delete those directories or share one account/data set between multiple instances.

For source installs, run `git pull --ff-only`, `npm ci`, then `npm start`. For Docker CLI installs, rebuild the image, stop and remove the old container, then recreate it using the same bind mounts.

## Development

```bash
npm run dev
npm test
npm run lint
npm run build:ui
```

### Cloud builds and browser validation

The [Build and publish Docker image](https://github.com/Naoya666/AIStudioToAPI/actions/workflows/docker.yml) workflow tests, builds and publishes GHCR images on pushes to `main` or `v*` tags. Other branches and pull requests validate without publishing. To retry, open the workflow in Actions, select **Run workflow**, and choose `main`. Publication uses GitHub's built-in `GITHUB_TOKEN`, with no additional personal token or repository secret. The workflow publishes images; production backup and deployment happen separately.

Multi-stage builds start from a Node.js base pinned by digest and use `npm ci` with the committed lockfile. Releases never inherit the previous application image, so layer depth does not accumulate. BuildKit reuses unchanged dependency and browser layers.

- **Source tests:** the CI runner installs standard Firefox and Chromium for protocol, scheduler and UI integration tests. Installing these browsers on the runner does not include them in the production image.
- **Image acceptance:** each AMD64 and ARM64 candidate runs the [offline smoke script](scripts/ci/image-smoke.sh), launching the bundled Camoufox against synthetic HTML and checking application startup, API authentication, frontend assets and SQLite.
- **Production browser:** the image uses `/app/camoufox-linux/camoufox` via `CAMOUFOX_EXECUTABLE_PATH`. Playwright's `firefox.launch()` starts Camoufox when given that executable path. Standard Firefox in source tests does not replace the production browser.

Automated tests and offline image checks do not access live Google accounts or establish real-account login, generation or production compatibility. See the [container publishing guide](docs/en/container-publishing.md) for the full process.

## Attribution and license

This version is derived from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI), which is a fork of [ais2api](https://github.com/Ellinav/ais2api) by [Ellinav](https://github.com/Ellinav). Thanks to the original authors, upstream maintainers and contributors. Existing source attribution is retained.

This version adopts the upstream **CC BY-NC 4.0** license. All usage, distribution and modification must comply with its terms. See [LICENSE](LICENSE) and the [license summary](https://creativecommons.org/licenses/by-nc/4.0/). The changes are described above; upstream authors do not endorse this version.

Third-party components, including Node.js, Camoufox and Mihomo, retain their own licenses. The image stores Mihomo's license and source link in `/usr/share/licenses/mihomo/`.

### Gemini 4 Argon account eligibility

`gemini-4-argon` defaults to the host page’s MakerSuite GenerateContent bridge. Set a manual tier in Accounts: Free, Pro, Ultra 5x or Ultra 20x. Unset follows successful observations from the current session (TIER1/TIER2 fall back to Pro). Paid effective tiers pass local Argon admission; Free and unknown do not. `ARGON_VERIFIED_ACCOUNTS` is deprecated and ignored; tier edits take effect without restarting.

Use “Check paid benefits” for one account or select accounts across pages for a batch. The serial queue provides per-account progress and cancellation. It calls only `GetAiStudioBenefitTier`, without generation, model usage accounting or automatic login. At most one extra detection context is allowed when ordinary browser capacity is full. There is no published upstream throttling guarantee for this internal RPC. Adding, importing, rotating or first using an account does not force a query. Cookie replacement and relogin retain old observations as history requiring a recheck. Failed checks preserve the latest successful observation from the same session.

Manual tiers control local admission and quota estimates only. They never forge upstream entitlement headers or grant upstream permissions. A paid declaration conflicting with detected Free produces a warning but allows a real request; manual Free is never upgraded by detection. Tier edits, checks and model recovery preserve usage history. Actual model permission errors and 429 retain their existing account × model behavior. Ordinary Cookie downloads and existing CSV/ZIP exports omit tier and benefit metadata; the account SQLite database persists these fields and accepts older records without them.

Per-model daily estimate bases (Flash / Pro / Argon) are 100 / 10 / ineligible for unknown or Free, 100 / 50 / 50 for Pro, 500 / 100 / 100 for Ultra 5x, and 500 / 200 / 200 for Ultra 20x. Each account’s upstream attempts, including failures, are subtracted independently using America/Los_Angeles calendar days. Admin and public dashboards aggregate individual account bases. Estimates are not live upstream balances; reaching zero does not add a dispatch block.

Chat Completions, Responses, Anthropic and native Gemini support JSON and incremental SSE. Camoufox uses the current page’s authentication and entitlement context and generates a fresh WAA for each request. Tier estimates and upstream 429 handling remain in effect.

`node --test tests/build-benefit.test.js` runs real Firefox against a local TLS/CONNECT fixture without contacting Google (requires Playwright Firefox and OpenSSL). Offline success does not establish live account or Build model availability; live acceptance remains separate.

See the [production diagnosis and fix report](docs/zh/gemini-4-argon-production-diagnosis-20261017.md) for Camoufox differences and remaining live acceptance limits. Use `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH=/path/to/camoufox node --test tests/build-benefit.test.js` to exercise the fixture with that browser. The Camoufox fixture recreates documents through the production BrowserManager navigation path; standard Firefox continues to test native reload.

### Model transport compatibility

The bridge downgrades forced or named function selection to AUTO for preset/plugin compatibility. OpenAI `required` / named functions, Anthropic `any` / named tools, and Gemini `ANY` / `allowedFunctionNames` preserve tool declarations without enforcing a call or a particular name. These selectors no longer cause a bridge 400; neither tool execution nor a text response is guaranteed. This applies to JSON and incremental SSE. Disabling tools with `none` / `NONE` omits tools from the upstream request.

All models use Camoufox to call Playground GenerateContent directly. Build App, its relay WebSocket and legacy transport mapping are retired; old `MODEL_TRANSPORT_POLICY` values are ignored. `STREAMING_MODE=real|fake|early`, the configuration panel and per-model suffix overrides remain supported. The separate `legacy` account rotation strategy is unchanged.

In real mode, the browser reads `ReadableStream` incrementally, parses complete JSON+protobuf messages and forwards protocol events before upstream EOF. Successful completion is sent only after EOF validation. Late errors, truncated responses and cancellations cannot produce success; generation is not replayed after output. Fake mode buffers the full result before emitting SSE. Early mode retains Chat empty start events and waiting heartbeats; other protocols retain their previous fake behavior. Non-stream requests return aggregated JSON.

`MAKERSUITE_TIMEOUT_MS` (default 295000 ms, range 1–2147478647 ms) is the fixed generation budget covering authentication, WAA and body reading, with up to 5000 ms reserved for settlement. `STREAM_TIMEOUT_MS` limits real incremental idle waits after initial content. `FAKE_STREAM_TIMEOUT_MS` remains available for buffered queue waits, with the fixed Playground budget taking precedence. Queue deadlines are separate. Retries, chunks and keepalives cannot renew the budget. Saved changes apply to new requests.

Set `MAKERSUITE_TIMEOUT_MS=600000` for a ten-minute generation budget. Both the server and page fetch enforce the fixed budget through body reading. Build client synchronization is no longer necessary. Credentials, opaque entitlement data, proof and payloads are not logged by the transport.

Run `npm test`, `npm run test:transport:browser`, and `npm run test:transport:long` for regressions, browser checks, and a real local TLS response taking over 60 seconds. Set `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH` to test production Camoufox with the TLS fixture. CONNECT destinations are restricted; the fixture cannot connect to Google or production port 9998. Offline results do not establish real-account availability. Deployment and account switching require separate authorization. See the [implementation record](docs/zh/model-transport-compatibility-implementation-20261017.md).

### Authenticated local model health

Master and agent expose the same `GET /api/internal/model-health` on the public dashboard listener. Set `PUBLIC_DASHBOARD_HEALTH_TOKEN` and restart, then send `Authorization: Bearer <token>`. An empty token denies access. This credential is independent of `PUBLIC_DASHBOARD_AGENT_TOKEN`. Standalone does not expose the machine endpoint.

The endpoint projects only the existing local cache, including `schema_version: 1`, original `generated_at`, persistent `node_id`, `snapshot_sequence`, `service_status`, `usage_window`, and each model's `realtime.available_accounts`. It contains no account details or remote agent totals and triggers no statistics queries. Missing/incorrect credentials return 401; missing/expired cache or a service that is not ready returns 503. Existing cached responses retain their source timestamp and identity even on 503. Public display and master-to-agent collection endpoints retain their existing purposes.

Configure the channel controller with `aistudio.status_url: "http://aistudio:7861/api/internal/model-health"` and `aistudio.token_env: "AISTUDIO_HEALTH_TOKEN"`; inject the matching credential through that environment variable, including in dry-run. Channel switching policy remains unchanged.

See the [incremental streaming implementation and live validation record](docs/zh/playground-streaming-20261029.md).

See the [mode preservation correction and validation record](docs/zh/playground-stream-modes-20261029.md).

See [Playground capabilities](docs/zh/playground-capabilities.md) for tools, structured output, account-bound Drive files, local cachedContents, and proof recovery. Embeddings remain unsupported.
