# AIStudioToAPI — Independently Maintained Version

[中文文档](README.md) | English

A browser automation service that exposes Google AI Studio Build App through OpenAI, Gemini and Anthropic compatible APIs, with account management, model scheduling, proxy nodes and usage dashboards.

This repository is independently maintained and derived from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI), which is itself based on [Ellinav/ais2api](https://github.com/Ellinav/ais2api). It is not an official upstream release. Existing attribution is retained, and this version uses **CC BY-NC 4.0** for noncommercial use under the license terms.

Protocol update (2026-10-16): generation now uses a MakerSuite `GenerateContent` bridge, adapted with permission from [yunx738/ais2api](https://github.com/yunx738/ais2api/commit/79807728179482509cf1f8a4f5e3e175d9dd6702). Existing Build app scripts need no manual update. Responses, including `real` mode, are currently buffered; `early` provides keepalives while waiting. Search, URL context, code execution, file references, structured schemas, image/audio output options, non-AUTO tool choice and thinking levels other than LOW/HIGH are explicitly unsupported. Disable forced built-in tools to use basic generation. See the [implementation and verification record](docs/zh/makersuite-generate-content-protocol-repair-plan-20261016.md#9-实施记录).

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
