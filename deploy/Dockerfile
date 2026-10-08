FROM node:24-alpine AS console
WORKDIR /console
COPY dashboard-react/package.json dashboard-react/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dashboard-react/ ./
RUN npm run build

FROM rust:1.90-alpine AS controller
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY src/ ./src/
COPY fluxscale.local.toml ./
RUN cargo build --release --locked -j 2

FROM docker:29-cli
WORKDIR /app
COPY --from=controller /source/target/release/fluxscale-core /usr/local/bin/fluxscale-core
COPY --from=console /console/dist /app/console
ENV FLUXSCALE_STATE_PATH=/data/fluxscale-state.json
ENTRYPOINT ["fluxscale-core"]
CMD ["/app/fluxscale.toml"]
