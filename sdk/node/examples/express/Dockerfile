FROM node:22-alpine
WORKDIR /app/sdk
COPY sdk/node/package.json sdk/node/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY sdk/node/tsconfig.json ./
COPY sdk/node/src/ ./src/
RUN npm run build
WORKDIR /app/sdk/examples/express
COPY sdk/node/examples/express/package.json sdk/node/examples/express/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY sdk/node/examples/express/server.mjs ./
COPY sdk/node/examples/express/workloads.mjs ./
ENV HOST=0.0.0.0 PORT=3000 FLUXSCALE_EXECUTION_MODE=managed FLUXSCALE_REQUIRE_AUTH=true
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
