FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app

COPY plugins/admin/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/admin/public ./public
COPY plugins/admin/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
