# syntax=docker/dockerfile:1
# Update this digest deliberately; releases never inherit an older application image.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS frontend
COPY vite.config.js vite.public.config.js ./
COPY ui ./ui
COPY ui-public ./ui-public
ARG VERSION
RUN VERSION=${VERSION} npm run build:ui

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG TARGETARCH
ARG MIHOMO_VERSION=v1.19.31
ARG MIHOMO_SHA256_AMD64=04cf9f09671704f839ddbee2e93069dc831a4123a75281e725d1d96ab9ac1afc
ARG MIHOMO_SHA256_ARM64=9e0f11afbf38426b8bd88fdc594678f8161c57eccb4e1b77acb12b493904f1d4
ARG CAMOUFOX_VERSION=v135.0.1-beta.24
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxrandr2 libxss1 libxtst6 xvfb x11vnc websockify \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) asset="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"; checksum="${MIHOMO_SHA256_AMD64}" ;; \
        arm64) asset="mihomo-linux-arm64-${MIHOMO_VERSION}.gz"; checksum="${MIHOMO_SHA256_ARM64}" ;; \
        *) echo "Unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${asset}" -o /tmp/mihomo.gz; \
    echo "${checksum}  /tmp/mihomo.gz" | sha256sum -c -; \
    gzip -dc /tmp/mihomo.gz > /usr/local/bin/mihomo; \
    chmod 0755 /usr/local/bin/mihomo; \
    mkdir -p /usr/share/licenses/mihomo; \
    curl -fsSL --retry 3 "https://raw.githubusercontent.com/MetaCubeX/mihomo/${MIHOMO_VERSION}/LICENSE" -o /usr/share/licenses/mihomo/LICENSE; \
    printf '%s\n' "Source: https://github.com/MetaCubeX/mihomo/tree/${MIHOMO_VERSION}" > /usr/share/licenses/mihomo/SOURCE; \
    rm /tmp/mihomo.gz; \
    mihomo -v

# Download the browser independently of application source and npm dependencies.
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) browser_arch=x86_64 ;; \
        arm64) browser_arch=arm64 ;; \
        *) echo "Unsupported architecture" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 "https://github.com/daijro/camoufox/releases/download/${CAMOUFOX_VERSION}/camoufox-${CAMOUFOX_VERSION#v}-lin.${browser_arch}.zip" -o /tmp/camoufox.zip; \
    mkdir -p /tmp/camoufox /app/camoufox-linux; \
    # Camoufox contains Unicode font names that make unzip return warning status 1.
    unzip -q /tmp/camoufox.zip -d /tmp/camoufox || { status=$?; [ "$status" -eq 1 ] || exit "$status"; }; \
    if [ -f /tmp/camoufox/camoufox ]; then \
        cp -a /tmp/camoufox/. /app/camoufox-linux/; \
    else \
        browser=$(find /tmp/camoufox -mindepth 2 -maxdepth 2 -type f -name camoufox -print -quit); \
        test -n "${browser}"; \
        cp -a "$(dirname "${browser}")/." /app/camoufox-linux/; \
    fi; \
    chmod 0755 /app/camoufox-linux/camoufox; \
    rm -rf /tmp/camoufox /tmp/camoufox.zip

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json main.js LICENSE ./
COPY src ./src
COPY scripts ./scripts
COPY configs/models.json ./configs/models.json
COPY docs/licenses ./docs/licenses
COPY --from=frontend /app/ui/dist ./ui/dist
COPY --from=frontend /app/ui-public/dist ./ui-public/dist
COPY ui/locales ./ui/locales
COPY ui/public ./ui/public

# Retain the existing runtime user and interfaces for deployed Compose projects.
USER root
EXPOSE 7860 7861
ENV NODE_ENV=production \
    CHECK_UPDATE=false \
    CAMOUFOX_EXECUTABLE_PATH=/app/camoufox-linux/camoufox \
    MIHOMO_PATH=/usr/local/bin/mihomo
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const port = process.env.PORT || 7860; require('http').get('http://localhost:' + port + '/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1));" || exit 1
CMD ["node", "main.js"]
