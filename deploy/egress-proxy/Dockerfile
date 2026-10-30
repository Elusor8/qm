FROM envoyproxy/envoy:v1.31.5@sha256:2ef22f7a72d3008d68bd4912f52b9a3d466d00db31a567dffa1b103e42eb9198 AS envoy

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy

RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY deploy/egress-proxy/envoy.yaml deploy/egress-proxy/start.sh ./
RUN chmod +x start.sh
# A rejected config is a fleet-wide outage: start.sh kills the container when Envoy dies, so an
# invalid envoy.yaml has to fail the build, not the deploy.
RUN envoy --mode validate -c /app/envoy.yaml

ENV NODE_ENV=production
EXPOSE 48080

CMD ["/app/start.sh"]
