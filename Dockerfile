# syntax=docker/dockerfile:1
# Builds the AI agent worker (apps/agent) for LiveKit Cloud agent deployment.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS base
ENV HOME="/app"
# ca-certificates: the LiveKit native core reads the system trust store at runtime.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent/package.json apps/agent/
# Install only the agent workspace and what it depends on
RUN npm ci --workspace apps/agent --include-workspace-root=false --ignore-scripts
# Pre-download plugin models before copying sources so the layer is cached
RUN npx livekit-agents download-files
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/agent apps/agent
RUN npm prune --omit=dev --workspace apps/agent

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
ENV NODE_ENV=production
WORKDIR /app/apps/agent
CMD ["npm", "start"]
