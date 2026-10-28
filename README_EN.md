# AIStudioToAPI — Independently Maintained Version

[中文文档](README.md) | English

A browser automation service that exposes Google AI Studio Build App through OpenAI, Gemini and Anthropic compatible APIs, with account management, model scheduling, proxy nodes and usage dashboards.

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

## Local Docker build

Use Docker Engine / Docker Desktop and Docker Compose v2. The Dockerfile supports Linux amd64 and arm64 and downloads the Node.js base image, system packages, Camoufox and Mihomo during the build.

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

Keep `CHECK_UPDATE=false`: the inherited checker refers to upstream releases and images. Update this version by pulling source and rebuilding locally.

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
npm install
cp .env.example .env
# Edit .env before continuing.
npm run setup-auth
npm start
```

The setup script checks dependencies, downloads Camoufox and guides you through login. Sessions are saved in `configs/auth/`. Set `CAMOUFOX_EXECUTABLE_PATH` to use an existing browser installation. Source installs do not include the container's VNC environment; install Mihomo separately and set `MIHOMO_PATH` if you need the node pool. The Docker image includes Mihomo.

`npm start` builds both frontends. Use `npm run quick-start` only when the frontends are already built and unchanged. Source installs store runtime data in the repository's `data/` directory.

## Create your own Build App

Attach [build.js](scripts/client/build.js) and [index.html](scripts/client/index.html) from the same version as your deployment in Google AI Studio Build, then send the [complete copyable prompt](docs/zh/build-app-prompt.md) (Chinese). It requires the original protocol and author information to be preserved, with actual project files and compilation checks.

After creating the App, set `this.targetUrl` in `src/core/BrowserManager.js` to its AI Studio App page URL, then rebuild and restart the service. Follow the [Build App guide](docs/en/build-app-guide.md) for the full steps. Preview identity or connection failures do not imply compilation failure: the editor lacks service-injected identity and the local WebSocket. Validate identity, a real connection and API processing separately after integration.

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

For Compose:

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

Updates rebuild this repository locally; `docker compose pull` is unnecessary. Back up `.env`, `configs/auth/` and `data/` before upgrading. Stop the service before copying databases:

```bash
docker compose stop
# Copy .env, configs/auth/ and data/ to a secure backup location.
docker compose up -d
```

`docker compose down` removes containers but preserves host bind directories. Do not delete those directories or share one account/data set between multiple instances.

For source installs, run `git pull --ff-only`, `npm install`, then `npm start`. For Docker CLI installs, rebuild the image, stop and remove the old container, then recreate it using the same bind mounts.

## Development

```bash
npm run dev
npm test
npm run lint
npm run build:ui
```

Automated tests do not replace real Google login and upstream request validation. The Docker workflow is a manual build check only: it does not publish images or require upstream registry credentials.

## Attribution and license

This version is derived from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI), which is a fork of [ais2api](https://github.com/Ellinav/ais2api) by [Ellinav](https://github.com/Ellinav). Thanks to the original authors, upstream maintainers and contributors. Existing source attribution is retained.

This version adopts the upstream **CC BY-NC 4.0** license. All usage, distribution and modification must comply with its terms. See [LICENSE](LICENSE) and the [license summary](https://creativecommons.org/licenses/by-nc/4.0/). The changes are described above; upstream authors do not endorse this version.

Third-party components, including Node.js, Camoufox and Mihomo, retain their own licenses. The image stores Mihomo's license and source link in `/usr/share/licenses/mihomo/`.

### Gemini 4 Argon account eligibility

`gemini-4-argon` defaults to the host page’s MakerSuite GenerateContent bridge. Set a manual tier in Accounts: Free, Pro, Ultra 5x or Ultra 20x. Unset follows successful observations from the current session (TIER1/TIER2 fall back to Pro). Paid effective tiers pass local Argon admission; Free and unknown do not. `ARGON_VERIFIED_ACCOUNTS` is deprecated and ignored; tier edits take effect without restarting.

Use “Check paid benefits” for one account or select accounts across pages for a batch. The serial queue provides per-account progress and cancellation. It calls only `GetAiStudioBenefitTier`, without generation, model usage accounting or automatic login. At most one extra detection context is allowed when ordinary browser capacity is full. There is no published upstream throttling guarantee for this internal RPC. Adding, importing, rotating or first using an account does not force a query. Cookie replacement and relogin retain old observations as history requiring a recheck. Failed checks preserve the latest successful observation from the same session.

Manual tiers control local admission and quota estimates only. They never forge upstream entitlement headers or grant upstream permissions. A paid declaration conflicting with detected Free produces a warning but allows a real request; manual Free is never upgraded by detection. Tier edits, checks and model recovery preserve usage history. Actual model permission errors and 429 retain their existing account × model behavior. Ordinary Cookie downloads and existing CSV/ZIP exports omit tier and benefit metadata; the account SQLite database persists these fields and accepts older records without them.

Per-model daily estimate bases (Flash / Pro / Argon) are 100 / 10 / ineligible for unknown or Free, 100 / 50 / 50 for Pro, 500 / 100 / 100 for Ultra 5x, and 500 / 200 / 200 for Ultra 20x. Each account’s upstream attempts, including failures, are subtracted independently using America/Los_Angeles calendar days. Admin and public dashboards aggregate individual account bases. Estimates are not live upstream balances; reaching zero does not add a dispatch block.

Chat Completions, Responses, Anthropic and native Gemini retain JSON/SSE compatibility. Streaming for this exact model is buffered unary output, including global `real`, the `-real` suffix and native `alt=sse`. Other models keep their streaming behavior. The bridge uses the current host page’s real benefit and authentication context and generates a new WAA for the converted payload. There is no automatic cross-channel fallback. Local quota follows the tier estimates above; upstream 429 handling remains active.

`node --test tests/build-benefit.test.js` runs real Firefox against a local TLS/CONNECT fixture without contacting Google (requires Playwright Firefox and OpenSSL). Offline success does not establish live account or Build model availability; live acceptance remains separate.

See the [production diagnosis and fix report](docs/zh/gemini-4-argon-production-diagnosis-20261017.md) for Camoufox differences and remaining live acceptance limits. Use `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH=/path/to/camoufox node --test tests/build-benefit.test.js` to exercise the fixture with that browser. The Camoufox fixture recreates documents through the production BrowserManager navigation path; standard Firefox continues to test native reload.

### Model transport compatibility

All models default to the MakerSuite GenerateContent bridge and keep their original IDs. The legacy endpoint no longer works; existing explicit `legacy` overrides still take precedence and should be changed to `makersuite` or removed. The configuration UI provides model ID rows with legacy / bridge selectors. Saved transport overrides require a restart; environment overrides remain JSON mappings:

```dotenv
MODEL_TRANSPORT_POLICY={"gemini-3.7-flash":"makersuite","gemini-4-argon":"makersuite"}
```

Only canonical model IDs and `legacy` / `makersuite` are accepted. Requests keep their transport snapshot through retries and continuation rounds. There is no automatic channel fallback or model renaming. Argon uses the shared account tier policy and the current page’s real authentication and entitlement headers. Manual tiers do not grant upstream permissions.

The bridge buffers the upstream result. JSON and SSE formats remain available; requested real streaming becomes buffered output. Chat supports early headers and keepalives; other adapters retain buffered SSE. The panel’s bridge generation timeout (`MAKERSUITE_TIMEOUT_MS`, default 295000 ms) controls the complete bridge generation budget, including authentication, WAA, fetch and body reading. It is independent of `FAKE_STREAM_TIMEOUT_MS` (default 300000 ms), which controls ordinary buffered generation. Up to 5000 ms is added for bridge response settlement. Both settings accept 1–2147478647 ms, within JavaScript’s timer range. Saved values apply to new requests; accepted requests retain their snapshot. Retries, continuation rounds, chunks and keepalives never renew the fixed budget. `STREAM_TIMEOUT_MS` remains the legacy real-stream idle timeout. Queue deadlines are separate; configure gateways and callers to cover queueing, generation and settlement.

For example, set the bridge generation timeout to `600000` for ten minutes without changing the ordinary buffered timeout. The browser must run this version’s [build.js](scripts/client/build.js) to honor the server’s remaining budget. Synchronize the client code in existing custom Build Apps; older clients may still abort after 300 seconds. The project does not automatically modify saved Build Apps. Internal correlation markers are removed before outbound Google calls. Credentials, opaque benefit data, proof and payloads are not logged by the transport.

Run `npm test`, `npm run test:transport:browser`, and `npm run test:transport:long` for regressions, browser checks, and a real local TLS response taking over 60 seconds. Set `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH` to test production Camoufox with the TLS fixture. CONNECT destinations are restricted; the fixture cannot connect to Google or production port 9998. Offline results do not establish real-account availability. Deployment and account switching require separate authorization. See the [implementation record](docs/zh/model-transport-compatibility-implementation-20261017.md).


### Authenticated local model health

Master and agent expose the same `GET /api/internal/model-health` on the public dashboard listener. Set `PUBLIC_DASHBOARD_HEALTH_TOKEN` and restart, then send `Authorization: Bearer <token>`. An empty token denies access. This credential is independent of `PUBLIC_DASHBOARD_AGENT_TOKEN`. Standalone does not expose the machine endpoint.

The endpoint projects only the existing local cache, including `schema_version: 1`, original `generated_at`, persistent `node_id`, `snapshot_sequence`, `service_status`, `usage_window`, and each model's `realtime.available_accounts`. It contains no account details or remote agent totals and triggers no statistics queries. Missing/incorrect credentials return 401; missing/expired cache or a service that is not ready returns 503. Existing cached responses retain their source timestamp and identity even on 503. Public display and master-to-agent collection endpoints retain their existing purposes.

Configure the channel controller with `aistudio.status_url: "http://aistudio:7861/api/internal/model-health"` and `aistudio.token_env: "AISTUDIO_HEALTH_TOKEN"`; inject the matching credential through that environment variable, including in dry-run. Channel switching policy remains unchanged.
