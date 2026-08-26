FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS tools

WORKDIR /tools
COPY docker/tools/package.json docker/tools/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && node_modules/.bin/codex --version | grep -F "0.150.0-alpha.8" \
    && node_modules/.bin/claude --version | grep -F "2.1.217"

FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ARG TARGETARCH
ARG GH_VERSION=2.96.0
ARG GLAB_VERSION=1.111.0
ARG APM_VERSION=0.28.0

COPY docker/apm-requirements.txt /tmp/apm-requirements.txt

# Debian snapshot: 20260825T000000Z.
RUN set -eux; \
    sed -i \
      's#http://deb.debian.org/debian-security#http://snapshot.debian.org/archive/debian-security/20260825T000000Z#g; s#http://deb.debian.org/debian#http://snapshot.debian.org/archive/debian/20260825T000000Z#g' \
      /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends ca-certificates curl git python3 python3-pip; \
    rm -rf /var/lib/apt/lists/*; \
    case "$TARGETARCH" in \
      amd64) archive_arch=amd64; \
        gh_sha=83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60; \
        glab_sha=d3aa186428ce6668455e2e35184c6f60b013840d759c7ea4cf02bac68d2a1827 ;; \
      arm64) archive_arch=arm64; \
        gh_sha=06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909; \
        glab_sha=13737967bf713574ac6c9b7316a8878c9a5920e1c1c3ccdc99772eafd274020a ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${archive_arch}.tar.gz"; \
    echo "$gh_sha  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${archive_arch}/bin/gh"; \
    curl -fsSL -o /tmp/glab.tgz "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${archive_arch}.tar.gz"; \
    echo "$glab_sha  /tmp/glab.tgz" | sha256sum -c -; \
    tar -xzf /tmp/glab.tgz -C /usr/local bin/glab; \
    rm /tmp/gh.tgz /tmp/glab.tgz; \
    python3 -m pip install --break-system-packages --no-cache-dir --require-hashes \
      --requirement /tmp/apm-requirements.txt; \
    rm /tmp/apm-requirements.txt; \
    node --version | grep -E '^v24\.'; \
    gh --version | grep -F "gh version ${GH_VERSION}"; \
    glab --version | grep -F "glab ${GLAB_VERSION}"; \
    apm --version | grep -F "version ${APM_VERSION}"; \
    git --version

RUN groupadd --gid 10001 agent \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin agent \
    && mkdir -p /data /home/agent/.config/gh /home/agent/.config/glab-cli /home/agent/.codex /home/agent/.claude \
    && touch /home/agent/.claude.json \
    && chown -R agent:agent /data /home/agent

WORKDIR /app
COPY --from=build --chown=agent:agent /app/dist ./dist
COPY --from=build --chown=agent:agent /app/node_modules ./node_modules
COPY --from=build --chown=agent:agent /app/package.json ./package.json
COPY --from=tools --chown=agent:agent /tools/node_modules /opt/tools/node_modules
COPY --chown=agent:agent schemas ./schemas

ENV PATH=/opt/tools/node_modules/.bin:$PATH \
    HOME=/home/agent \
    CODEX_HOME=/home/agent/.codex \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    AGENT_FLOW_CONFIG_REPOSITORY=/config \
    AGENT_FLOW_DATA_DIRECTORY=/data \
    AGENT_FLOW_HEALTH_PORT=8080

USER 10001:10001
EXPOSE 8080
CMD ["node", "dist/main.js"]
