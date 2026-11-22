# Public page: the Vite build, served by nginx, which also proxies /api/ to the gateway.
# Build from the repo root: docker build -f infra/web.Dockerfile .
FROM node:24-alpine AS build
RUN npm install -g pnpm@11.5.2
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@lab/web..."
COPY apps/web apps/web
RUN pnpm --filter @lab/web build

FROM nginx:1.31-alpine
COPY infra/web-nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# Runs as the image's nginx user on a read-only root filesystem: no entrypoint scripts (they
# rewrite config files), pid and temp files in /tmp.
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
