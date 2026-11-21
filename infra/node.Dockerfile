# Shared image for the Node services. Build from the repo root:
#   docker build -f infra/node.Dockerfile --build-arg APP=gateway .
FROM node:24-alpine AS deps
ARG APP
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/telemetry/package.json packages/telemetry/
COPY apps/${APP}/package.json apps/${APP}/
# "@lab/<app>..." = the app plus the workspace packages it depends on.
RUN pnpm install --frozen-lockfile --prod --filter "@lab/${APP}..."

FROM node:24-alpine
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY packages/telemetry/src packages/telemetry/src
COPY apps/${APP}/src apps/${APP}/src
WORKDIR /app/apps/${APP}
USER node
