# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

# ---- Git from source --------------------------------------------------------
# Debian trixie ships git 2.47; mono repos that enable the
# `relativeWorktrees` extension (added in git 2.48) fail every git command
# with `fatal: unknown repository extension found: relativeworktrees`.
# Build a newer git in a builder stage so build deps don't bloat runtime.
FROM node:22-trixie-slim AS git-builder
ARG GIT_VERSION=2.53.0
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        gettext \
        libcurl4-openssl-dev \
        libexpat1-dev \
        libssl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz" \
        -o /tmp/git.tar.xz && \
    mkdir -p /tmp/git-src && \
    tar -xJf /tmp/git.tar.xz -C /tmp/git-src --strip-components=1 && \
    cd /tmp/git-src && \
    make -j"$(nproc)" prefix=/usr/local NO_TCLTK=1 NO_PERL=1 all && \
    make prefix=/usr/local NO_TCLTK=1 NO_PERL=1 DESTDIR=/opt/git-install install && \
    rm -rf /tmp/git.tar.xz /tmp/git-src

FROM node:22-trixie-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.116
ARG AGENT_BROWSER_VERSION=latest
ARG VERCEL_VERSION=latest
ARG BUN_VERSION=1.3.12
# @devcontainers/cli — used by the `add-coding-agent` skill's
# devcontainer backend + the in-container `devcontainer-cli` MCP tool
# server. Pinned for reproducibility.
ARG DEVCONTAINER_CLI_VERSION=0.85.0
# GitHub CLI — used by the `add-coding-agent` skill's `gh` MCP tool
# server and the host-side PR monitor. Pinned via the upstream apt
# repo's version-stamped package name. Bump deliberately.
ARG GH_VERSION=2.65.0

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2t64 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# ---- GitHub CLI -------------------------------------------------------------
# `gh` is consumed by the host-side PR monitor (sub-task 8) and the
# in-container `gh` MCP server (sub-task 7). Installed from the official
# GitHub releases tarball so the pinned version is reproducible (the apt
# repo at cli.github.com only stocks the latest release, breaking pinned
# builds whenever GitHub publishes a new version).
RUN arch=$(dpkg --print-architecture) && \
    case "$arch" in \
        amd64) gh_arch=linux_amd64 ;; \
        arm64) gh_arch=linux_arm64 ;; \
        *) echo "unsupported arch for gh: $arch" && exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/gh.tgz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${gh_arch}.tar.gz" && \
    tar -xzf /tmp/gh.tgz -C /tmp && \
    install -m 0755 "/tmp/gh_${GH_VERSION}_${gh_arch}/bin/gh" /usr/local/bin/gh && \
    rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_${gh_arch}" && \
    gh --version

# ---- Git (built from source above) ------------------------------------------
# /usr/local/bin precedes /usr/bin in PATH, so /usr/local/bin/git wins. Also
# symlink /usr/bin/git so absolute-path callers (scripts, hooks, MCP tools)
# get the new git instead of the apt-installed 2.47.
COPY --from=git-builder /opt/git-install/usr/local /usr/local
RUN ln -sf /usr/local/bin/git /usr/bin/git && \
    git --version

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" >> /root/.npmrc && \
    pnpm install -g "vercel@${VERCEL_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# @devcontainers/cli — driver for the `add-coding-agent` skill. Pure JS
# CLI, no postinstall surface, fits cleanly in this pnpm-global block.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@devcontainers/cli@${DEVCONTAINER_CLI_VERSION}"

# ---- ICM (Infinite Context Memory) ------------------------------------------
# Opt-in per agent group via mcpServers.icm in groups/<f>/container.json.
# Binary is always present in the image; the agent-runner only wires the MCP
# server when the group's container.json requests it.
# .deb for amd64; tarball for arm64.
RUN arch=$(dpkg --print-architecture) && \
    if [ "$arch" = "amd64" ]; then \
        curl -fsSL -o /tmp/icm.deb https://github.com/rtk-ai/icm/releases/latest/download/icm_amd64.deb && \
        dpkg -i /tmp/icm.deb && rm /tmp/icm.deb; \
    elif [ "$arch" = "arm64" ]; then \
        curl -fsSL -o /tmp/icm.tgz https://github.com/rtk-ai/icm/releases/latest/download/icm-aarch64-unknown-linux-gnu.tar.gz && \
        tar -xzf /tmp/icm.tgz -C /usr/local/bin --strip-components=1 && \
        chmod +x /usr/local/bin/icm && rm /tmp/icm.tgz; \
    else echo "unsupported arch for ICM: $arch" && exit 1; fi && \
    icm --version

# ---- Operator-supplied bind mounts ------------------------------------------
# Backoffice MCP server is operator-supplied — not bundled in this image.
# Operator bind-mounts /opt/backoffice-mcp via container.json additionalMounts:
#   { hostPath: "/path/to/backoffice-mcp", containerPath: "/opt/backoffice-mcp", readonly: true }
# Wired by the add-backoffice-tool skill when BO_API_URL + BO_AUTH_TOKEN env
# vars are set. See .claude/skills/add-backoffice-tool/SKILL.md.

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
