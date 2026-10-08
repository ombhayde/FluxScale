FROM node:24-alpine AS console
WORKDIR /console
COPY dashboard-react/package*.json ./
RUN npm ci
COPY dashboard-react/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY connected/*.mjs connected/package.json ./
COPY --from=console /console/dist /app/console
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8090 FLUXSCALE_HUB_DATABASE=/data/connected.sqlite FLUXSCALE_HUB_DASHBOARD=/app/console
EXPOSE 8090
CMD ["node", "server.mjs"]
