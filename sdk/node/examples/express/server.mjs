import express from "express";
import { createFluxScale } from "@fluxscale/node";
import { installDatabaseWorkloads, workloadPaths } from './workloads.mjs';

const app = express();

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "127.0.0.1";
const instanceId = process.env.FLUXSCALE_INSTANCE_ID ?? `local-${process.pid}`;
const fluxScaleEndpoint =
  process.env.FLUXSCALE_ENDPOINT ?? "http://127.0.0.1:8080";
const serviceName = process.env.FLUXSCALE_SERVICE ?? "sdk-demo-api";

const requestedExecutionMode =
  process.env.FLUXSCALE_EXECUTION_MODE ?? "observe_only";

if (
  requestedExecutionMode !== "observe_only" &&
  requestedExecutionMode !== "managed"
) {
  throw new Error(
    "FLUXSCALE_EXECUTION_MODE must be observe_only or managed.",
  );
}

const executionMode = requestedExecutionMode;
const apiToken =
  executionMode === "managed"
    ? process.env.FLUXSCALE_MANAGED_TOKEN
    : process.env.FLUXSCALE_INGEST_TOKEN;

const authenticationRequired = ["1", "true", "yes"].includes(
  (process.env.FLUXSCALE_REQUIRE_AUTH ?? "").trim().toLowerCase(),
);

if (authenticationRequired && !apiToken) {
  const requiredVariable =
    executionMode === "managed"
      ? "FLUXSCALE_MANAGED_TOKEN"
      : "FLUXSCALE_INGEST_TOKEN";

  throw new Error(
    `${requiredVariable} is required when FLUXSCALE_REQUIRE_AUTH is enabled.`,
  );
}

const fluxScale = createFluxScale({
  service: serviceName,
  endpoint: fluxScaleEndpoint,
  flushIntervalMs: 1_000,
  timeoutMs: 5_000,
  executionMode,
  apiToken,
  workloadLabel: request => workloadPaths[request.path],

  currentReplicas: () => {
    const configured = Number.parseInt(
      process.env.FLUXSCALE_CURRENT_REPLICAS ?? "1",
      10,
    );

    return Number.isFinite(configured) && configured > 0
      ? configured
      : 1;
  },

  ignorePaths: [
    "/health",
    "/ready",
    "/debug/telemetry",
    "/debug/flush",
  ],

  logger: {
    debug(message, metadata) {
      if (process.env.FLUXSCALE_DEBUG === "1") {
        console.log(`[FluxScale] ${message}`, metadata);
      }
    },

    warn(message, metadata) {
      console.warn(`[FluxScale] ${message}`, metadata);
    },

    error(message, metadata) {
      console.error(`[FluxScale] ${message}`, metadata);
    },
  },
});

app.disable("x-powered-by");
app.use(express.json());
app.use(fluxScale.middleware);
const closeDatabase = installDatabaseWorkloads(app, instanceId);

app.get("/", (_request, response) => {
  response.json({
    application: "FluxScale Express SDK demo",
    service: serviceName,
    fluxscale_endpoint: fluxScaleEndpoint,
    execution_mode: executionMode,
    authentication: apiToken ? "bearer_token_configured" : "disabled",
    routes: {
      health: "/health",
      ready: "/ready",
      fast: "/api/fast",
      checkout: "/api/checkout?delay=250",
      cpu: "/api/cpu?duration=50",
      failure: "/api/failure",
      telemetry: "/debug/telemetry",
      flush: "/debug/flush",
    },
  });
});

app.get("/health", (_request, response) => {
  response.json({
    status: "ok",
    service: serviceName,
  });
});

app.get("/ready", (_request, response) => {
  response.json({ ready: true });
});

app.get("/api/fast", (_request, response) => {
  response.json({
    ok: true,
    route: "fast",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/checkout", async (request, response) => {
  const requestedDelay = Number.parseInt(
    String(request.query.delay ?? "250"),
    10,
  );

  const delay = Number.isFinite(requestedDelay)
    ? Math.min(2_000, Math.max(20, requestedDelay))
    : 250;

  await new Promise((resolve) => {
    setTimeout(resolve, delay);
  });

  response.json({
    ok: true,
    route: "checkout",
    processing_time_ms: delay,
    instance_id: instanceId,
  });
});

app.get("/api/cpu", (request, response) => {
  const requestedDuration = Number.parseInt(
    String(request.query.duration ?? "50"),
    10,
  );

  const duration = Number.isFinite(requestedDuration)
    ? Math.min(500, Math.max(5, requestedDuration))
    : 50;

  const startedAt = performance.now();
  let checksum = 0;

  while (performance.now() - startedAt < duration) {
    checksum += Math.sqrt(Math.random() * 10_000);
  }

  response.json({
    ok: true,
    route: "cpu",
    duration_ms: duration,
    checksum: Math.round(checksum),
    instance_id: instanceId,
  });
});

app.get("/api/failure", (_request, response) => {
  response.status(503).json({
    ok: false,
    error: "simulated_dependency_failure",
  });
});

app.get("/debug/telemetry", (_request, response) => {
  response.json(fluxScale.getSnapshot());
});

app.post("/debug/flush", async (_request, response) => {
  const result = await fluxScale.flush();

  if (!result) {
    response.status(503).json({
      accepted: false,
      error: "telemetry_delivery_failed",
    });
    return;
  }

  response.status(202).json(result);
});

const server = app.listen(port, host, () => {
  console.log(
    `FluxScale Express example listening on http://${host}:${port}`,
  );
  console.log(
    `Telemetry will be sent to ${fluxScaleEndpoint} as ${serviceName}`,
  );
  console.log(`FluxScale execution mode: ${executionMode}`);
  console.log(
    `FluxScale API authentication: ${apiToken ? "configured" : "not configured"}`,
  );
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down gracefully...`);

  const forcedShutdown = setTimeout(() => {
    console.error("Graceful shutdown timed out.");
    process.exit(1);
  }, 7_000);

  forcedShutdown.unref();

  server.close(async () => {
    try {
      await fluxScale.close();
      await closeDatabase();
      clearTimeout(forcedShutdown);
      console.log("FluxScale final telemetry window flushed.");
      process.exit(0);
    } catch (error) {
      console.error("Failed to close FluxScale SDK.", error);
      process.exit(1);
    }
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  void shutdown("uncaughtException");
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
  void shutdown("unhandledRejection");
});
