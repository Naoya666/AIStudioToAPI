# AIStudioToAPI — Independently Maintained Version

[中文](README.md) | English

Expose Google AI Studio's Gemini models through OpenAI, Gemini and Anthropic compatible APIs, with a console for accounts, model scheduling, proxy nodes and usage.

This repository is independently maintained from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) under **CC BY-NC 4.0**, for noncommercial use consistent with the license.

## Features

- **Multiple API formats:** OpenAI Chat Completions / Responses, native Gemini and Anthropic Messages, including streaming.
- **Two call backends:** Camoufox calling Playground directly by default, or a local Go / SpiderMonkey engine.
- **Account management:** credential login, Cookie / CSV / authenticator imports, batch operations, login queues, session recovery and paid-benefit checks.
- **Model scheduling:** account × model concurrency, queues, quotas, cooldowns, retries, Context warmup and proxy distribution.
- **Proxy node pool:** integrated Mihomo with account-to-exit binding.
- **Usage and operations:** SQLite request history, Token statistics, runtime status, visual configuration and an optional isolated public dashboard.
- **Optional generation features:** anti-truncation text transport, tail repair and experimental Build / SillyTavern channels.

Model, tool, image and audio support depends on the account, model and channel. A model appearing in the catalog does not guarantee account access.

## Quick start

Docker Compose v2 is recommended. Image builds target Linux amd64 / arm64 and include Camoufox, Mihomo and the local call engine.

### 1. Prepare configuration

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
cp .env.example .env
mkdir -p configs/auth data
```

Edit `.env` and set at least:

```dotenv
API_KEYS=replace-with-your-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-your-console-password
TZ=Asia/Shanghai
CHECK_UPDATE=false
```

`API_KEYS` accepts comma-separated keys. Set it explicitly: an empty value uses the default key `123456`. If neither console credential is configured, console login uses an API key.

### 2. Start the service

**Prebuilt image:** create `compose.image.yaml` in the repository root:

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
docker compose -f compose.image.yaml pull app
docker compose -f compose.image.yaml up -d --no-build app
docker compose -f compose.image.yaml logs -f app
```

`main` tracks successful main-branch publications. You can also use `sha-<full-commit>` or published `v*` tags. To pin a deployment, use the image digest from the Actions publication summary. See the [container publishing guide](docs/en/container-publishing.md).

**Build the current source:** after step 1, use the included [docker-compose.yml](docker-compose.yml):

```bash
docker compose up -d --build
docker compose logs -f app
```

The first build downloads base images, browser assets and native build dependencies. The repository's Compose file builds locally rather than pulling a GHCR image.

### 3. Sign in and add an account

Open `http://localhost:7860` and sign in with your console credentials. Use `/accounts` to add accounts:

- **Credential login:** store a Google email, password and optional TOTP secret for background login; CSV import is supported.
- **Cookie import:** upload an authentication JSON file or place existing session files in `configs/auth/`.
- **Manual login:** Docker deployments provide a VNC login entry at `/auth` for manual challenges and session saving.

Bind accounts to proxy nodes before login if they require a fixed exit. Follow console prompts for Google CAPTCHA or other manual challenges. See the [account login and recovery guide](docs/zh/account-auto-login-operations.md) in Chinese.

The default host port binds to loopback. For remote access, use an SSH tunnel or [Nginx with HTTPS](docs/zh/nginx-setup.md). If you change the container's `PORT`, update the Compose mapping too.

## API usage

| Format               | Base URL                       | Common endpoints                                                                                                     |
| -------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| OpenAI compatible    | `http://localhost:7860/v1`     | `/models`, `/chat/completions`, `/responses`                                                                         |
| Native Gemini        | `http://localhost:7860/v1beta` | `/models`, `/models/{model}:generateContent`, `/models/{model}:streamGenerateContent`, `/models/{model}:countTokens` |
| Anthropic compatible | `http://localhost:7860/v1`     | `/messages`, `/messages/count_tokens`                                                                                |

List models first:

```bash
curl http://localhost:7860/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Replace `MODEL_ID` with a returned model ID:

```bash
curl http://localhost:7860/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

Set `stream` to `true` for SSE. `STREAMING_MODE` supports:

| Mode    | Behavior                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------- |
| `real`  | Forward incremental upstream output; the default                                                                     |
| `fake`  | Buffer generation, then emit SSE                                                                                     |
| `early` | Chat Completions sends an empty initial chunk and waiting heartbeats before buffered content; other formats use fake |

Built-in search, code execution, URL context, function tools and structured output are supported within model capabilities. Playground downgrades forced or named function selection to `AUTO`, so execution of a particular tool is not guaranteed. Embeddings, including `embedContent` / `batchEmbedContents`, currently return **501**.

File APIs support upload, listing, download and deletion. Playground files are bound to the uploading account and cannot be combined across accounts. Gemini `cachedContents` is an in-memory compatibility cache cleared on restart. See [Playground capabilities and limits](docs/zh/playground-capabilities.md) and [API examples](docs/zh/api-examples.md), both in Chinese.

## Configuration and backends

See [.env.example](.env.example) for environment variables. Use the console configuration page for routine changes: saved overrides take precedence over corresponding environment values. The page shows running values, saved values and pending restart changes.

| Setting                                         | Purpose                                                 |
| ----------------------------------------------- | ------------------------------------------------------- |
| `API_KEYS`                                      | Comma-separated client API keys                         |
| `WEB_CONSOLE_USERNAME` / `WEB_CONSOLE_PASSWORD` | Console credentials                                     |
| `HOST` / `PORT`                                 | Default: `0.0.0.0` / `7860`                             |
| `CALL_BACKEND`                                  | `browser` (default) or `local`; restart required        |
| `CAMOUFOX_EXECUTABLE_PATH` / `MIHOMO_PATH`      | Custom browser and proxy binary paths                   |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`       | Outbound proxies and bypass rules                       |
| `STREAMING_MODE`                                | `real` / `fake` / `early`                               |
| `TZ` / `SECURE_COOKIES`                         | Display timezone / HTTPS Cookie settings                |
| `PUBLIC_DASHBOARD_ENABLED`                      | Enable the isolated anonymous dashboard; off by default |

Managed configuration is stored in `data/managed-config.json`. If an environment change has no effect, check for a console override. Compose environment changes require container recreation.

### Call backend

- **browser:** calls Playground directly using Camoufox account sessions; the default deployment backend.
- **local:** sends requests through a Node-managed local Go / SpiderMonkey child process. Supports Linux amd64 / arm64 and is included in Docker images. Source installs must run `npm run build:engine`, requiring Go 1.27.0; the script downloads the other native build dependencies.

Save the backend in Settings and restart the service to apply it. Both backends share accounts, proxies, scheduling and statistics, with no automatic fallback between them. Account login can still use a browser in local mode. See [backend operations and scope](docs/zh/local-browserless-backend.md) and the [validation record](docs/zh/local-browserless-validation-20261105.md) for completed live checks and remaining limits. Long-running Cookie renewal remains unverified.

### Account permissions and scheduling

Accounts can be assigned Free, Pro, Ultra 5x or Ultra 20x tiers, or follow successful benefit checks for the current session. Manual tiers affect local admission and quota estimates; actual access remains subject to Google permissions and rate limits.

Manage model permissions in the console tier allowlist and check authorization when adding models. Usage and quota displays are local measurements or estimates, not live upstream balances. The daily scheduler cooldown reset uses `America/Los_Angeles`, independently of `TZ`.

See [model scheduling](docs/zh/model-aware-scheduling.md), [tiers and benefits](docs/zh/account-tiers-and-argon-eligibility-design.md), [model allowlists](docs/zh/account-tier-model-allowlist-design.md) and [Token accounting](docs/zh/token-statistics.md).

### Optional features

- **Anti-truncation:** default policy is `off`. Enable for OpenAI Chat Completions using the `anti-` model prefix or `anti_truncation` request field. Only adapted models and combinations are supported; see the [guide](docs/zh/anti-truncation.md).
- **Build channels (experimental):** disabled by default and exposed only through Chat Completions. `build/` packages the full conversation; `build-st/` uses segmentation from the bundled SillyTavern adapter. Check model permissions after enabling. See [Build setup, media, tools and cleanup](docs/zh/build-dual-channel.md).
- **Tail repair:** `TAIL_REPAIR_ENABLED` defaults to false. Adds a user continuation instruction when the last turn is a model message; configurable in Settings.
- **Public dashboard:** set `PUBLIC_DASHBOARD_ENABLED=true`, add `127.0.0.1:7861:7861` to Compose ports and recreate the container. Serves isolated, read-only aggregate data. Clusters support master / agent roles with independent account pools. See the [dashboard guide](docs/zh/public-dashboard-design.md) and [multi-node deployment](docs/zh/public-dashboard-multi-node-design.md).

## Run from source

Requires **Node.js ≥ 22.13.0**; Node.js 24 matches the Docker image. Full background login depends on Linux `/proc` and POSIX process groups, so Linux or Docker is recommended.

```bash
git clone https://github.com/Naoya666/AIStudioToAPI.git
cd AIStudioToAPI
npm ci
cp .env.example .env
# Edit .env to set API keys and console credentials.
npm run setup-auth
npm start
```

The authentication script downloads Camoufox and guides login, saving sessions to `configs/auth/`. Set `CAMOUFOX_EXECUTABLE_PATH` to use an existing browser. Install Mihomo separately and set `MIHOMO_PATH` if you need the node pool.

`npm start` builds both frontends first. Use `npm run quick-start` when they are already built and unchanged. Source installs do not include the container's VNC environment.

## Updates and data

Persist the following:

| Path            | Contents                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------- |
| `.env`          | Initial environment settings and secrets                                                 |
| `configs/auth/` | Account sessions                                                                         |
| `data/`         | Account database, request history, scheduler state, proxy pool and managed configuration |

Passwords, TOTP secrets and Cookies use restricted local plaintext storage. These paths, account exports and login screenshots contain sensitive data; keep them out of public repositories. Stop the service before copying databases, and verify a complete backup. Separate instances must use independent data directories and account pools.

**Prebuilt image deployments:** after backup, run:

```bash
docker compose -f compose.image.yaml pull app
docker compose -f compose.image.yaml up -d --no-deps --no-build app
docker compose -f compose.image.yaml logs --tail=100 app
```

For pinned deployments, update the image digest first. Preserve existing service names, networks and all mounts. When switching from local builds, remove the service's `build` and `pull_policy: never` settings.

**Local image builds:** after backup, run:

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 app
```

**Source installs:** stop and back up the service, then run `git pull --ff-only`, `npm ci` and `npm start`. Rebuild the engine when needed for the local backend.

Check startup logs, accounts and API calls after upgrading. Retain the previous image reference and pre-upgrade data backup for rollback.

## Development

```bash
cp .env.example .env.development
# Edit .env.development before starting development mode.
npm run dev
npm test
npm run lint
npm run build:ui
```

Production reads `.env`; development reads `.env.development`. Browser integration tests require Playwright Firefox / Chromium, and some local TLS tests require OpenSSL. Local engine tests require a built engine. Additional commands are listed in [package.json](package.json).

The [image workflow](.github/workflows/docker.yml) validates pushes and PRs and publishes images only for main or `v*` tags. Automated offline checks do not establish real Google account access or support for every model combination.

## Attribution and license

Based on [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI), which derives from [Ellinav/ais2api](https://github.com/Ellinav/ais2api). Original attribution is retained, with thanks to upstream authors, maintainers and contributors.

The project retains **CC BY-NC 4.0 (Attribution–NonCommercial 4.0 International)**; see [LICENSE](LICENSE) for the full terms. This independently maintained version does not imply upstream endorsement.

Third-party components and adapted code retain their respective licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for sources and changes, and [local-engine/LICENSE.MIT](local-engine/LICENSE.MIT) for local engine MIT notices.
