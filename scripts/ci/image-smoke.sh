#!/usr/bin/env bash
# No live credentials, host ports, production mounts or external network access.
set -euo pipefail
image=${1:?Usage: image-smoke.sh IMAGE}
name="aistudio-image-smoke-$$"
cleanup() { docker rm -fv "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --network none --entrypoint node "$image" -e '
const fs = require("node:fs");
for (const file of ["/app/ui/dist/index.html", "/app/ui-public/dist/index.html",
    "/app/ui/locales/en.json", "/app/docs/licenses/antigravity-gateway-MIT.txt",
    "/app/camoufox-linux/camoufox", "/usr/local/bin/mihomo"]) {
    if (!fs.existsSync(file)) throw Error("Missing runtime file: " + file);
}
require("node:sqlite");
require("playwright");
require("./src/core/ProxyServerSystem");
if (fs.existsSync("/app/node_modules/vite")) throw Error("Build dependencies leaked into runtime");
if (fs.existsSync("/app/.env")) throw Error("Environment file leaked into runtime");
'
docker run --rm --network none --entrypoint node "$image" -e '
const {firefox} = require("playwright");
(async () => {
    const browser = await firefox.launch({executablePath: process.env.CAMOUFOX_EXECUTABLE_PATH, headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent("<title>offline-smoke</title><p>synthetic fixture</p>");
        if (await page.title() !== "offline-smoke") throw Error("Browser smoke failed");
    } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exit(1); });
'
docker run -d --name "$name" --network none \
    -e API_KEYS=ci-placeholder-key -e CHECK_UPDATE=false "$image" >/dev/null
for attempt in $(seq 1 45); do
    if docker exec "$name" node -e '
        const http = require("node:http");
        const get = (path, status, headers = {}) => new Promise((resolve, reject) => {
            const req = http.get({host: "127.0.0.1", port: 7860, path, headers}, res => {
                res.resume();
                res.on("end", () => res.statusCode === status ? resolve() : reject(Error(path + ": " + res.statusCode)));
            });
            req.setTimeout(2000, () => req.destroy(Error("Timeout")));
            req.on("error", reject);
        });
        (async () => {
            await get("/livez", 200);
            await get("/v1/models", 200, {authorization: "Bearer ci-placeholder-key"});
            await get("/locales/en.json", 200);
            await get("/v1/models", 401);
        })().catch(() => process.exit(1));
    ' 2>/dev/null; then
        echo "Offline image startup, browser, assets and API checks passed."
        exit 0
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
        echo "Image exited before becoming ready." >&2
        exit 1
    fi
    sleep 2
done
echo "Image did not pass runtime checks within 90 seconds." >&2
exit 1
