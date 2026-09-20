# Magic Context — pinned OpenCode 2.0.5 end-to-end image.
#
# Local/CI command (the wrapper builds the exact plugin artifact first):
#   tests/docker/opencode2/run.sh
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    nodejs \
    npm \
    sqlite3 \
    unzip \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:/test/host/node_modules/.bin:$PATH"

# The wrapper and native Linux binary are both explicit exact pins. Installing
# @opencode/client only equips the lane driver; product code never imports it.
RUN mkdir -p /test/host && npm install --prefix /test/host --no-audit --no-fund \
    @opencode/cli@2.0.5 \
    @opencode/cli-linux-x64@2.0.5 \
    @opencode/client@2.0.5

# Reconstruct the files npm publishes. The Docker build consumes the locally
# built dist plus the raw TUI sources rather than the registry release.
RUN mkdir -p /test/mc-package/src/features/magic-context/dreamer
COPY packages/plugin/package.json packages/plugin/index.js /test/mc-package/
COPY packages/plugin/dist/ /test/mc-package/dist/
COPY packages/plugin/src/tui/ /test/mc-package/src/tui/
COPY packages/plugin/src/tui-compiled/ /test/mc-package/src/tui-compiled/
COPY packages/plugin/src/v2/tui/ /test/mc-package/src/v2/tui/
COPY packages/plugin/src/shared/ /test/mc-package/src/shared/
COPY packages/plugin/src/config/ /test/mc-package/src/config/
COPY packages/plugin/src/agents/ /test/mc-package/src/agents/
COPY packages/plugin/src/features/magic-context/dreamer/cron.ts /test/mc-package/src/features/magic-context/dreamer/cron.ts
COPY packages/plugin/src/features/magic-context/dreamer/task-registry.ts /test/mc-package/src/features/magic-context/dreamer/task-registry.ts

RUN cd /test/mc-package \
    && npm pack --ignore-scripts --silent > /test/plugin-tarball-name \
    && mkdir -p /test/mc-install \
    && npm install --prefix /test/mc-install --no-audit --no-fund \
        "/test/mc-package/$(cat /test/plugin-tarball-name)"

COPY packages/e2e-tests/src/opencode2-runner/plugin-activation.ts /test/plugin-activation.ts
COPY tests/docker/opencode2/lane.mjs /test/lane.mjs
COPY tests/docker/opencode2/test-opencode2-e2e.sh /test/test-opencode2-e2e.sh
RUN chmod +x /test/test-opencode2-e2e.sh \
    && git config --global user.email "test@cortexkit.local" \
    && git config --global user.name "Magic Context CI" \
    && mkdir -p /test/project \
    && cd /test/project \
    && git init -q \
    && printf '{"name":"opencode2-e2e","private":true}\n' > package.json \
    && git add package.json \
    && git commit -q -m init

WORKDIR /test/project
ENTRYPOINT ["/test/test-opencode2-e2e.sh"]
