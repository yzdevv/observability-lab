# Shared image for the Node services. Build from the repo root:
#   docker build -f infra/node.Dockerfile --build-arg APP=gateway .
FROM node:24-alpine AS deps
ARG APP
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/${APP}/package.json apps/${APP}/
RUN pnpm install --frozen-lockfile --prod --filter "./apps/${APP}"

FROM node:24-alpine
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY apps/${APP}/src apps/${APP}/src
WORKDIR /app/apps/${APP}
USER node
