import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { readCpuCount, readMemoryLimit } from "./resources.js";

import type { Request, RequestHandler } from "express";

export type ScalingAction = "scale_up" | "scale_down" | "hold";
export type ExecutionMode = "observe_only" | "managed";

export interface ScalingDecision {
  id: string;
  service: string;
  timestamp: string;
  action: ScalingAction;
  current_replicas: number;
  desired_replicas: number;
  current_rps: number;
  predicted_rps: number;
  prediction_horizon_seconds: number;
  reasons: string[];
}

export interface FluxScaleIngestResponse {
  accepted: boolean;
  duplicate?: boolean;
  decision: ScalingDecision;
  execution?: unknown;
}

export interface FluxScaleMetric {
  service: string;
  instance_id?: string;
  timestamp: string;
  requests_per_second: number;
  active_requests: number;
  p95_latency_ms: number;
  error_rate: number;
  cpu_percent: number;
  memory_percent: number;
  current_replicas: number;
  workloads?: WorkloadMetric[];
}

export interface WorkloadMetric {
  name: string;
  requests_per_second: number;
  completed_requests: number;
  failed_requests: number;
  p95_latency_ms: number;
}

export interface FluxScaleSnapshot extends FluxScaleMetric {
  window_seconds: number;
  completed_requests: number;
  failed_requests: number;
}

export interface FluxScaleLogger {
  debug?(message: string, metadata?: unknown): void;
  warn?(message: string, metadata?: unknown): void;
  error?(message: string, metadata?: unknown): void;
}

export type ReplicaProvider =
  | number
  | (() => number | Promise<number>);

export interface FluxScaleOptions {
  service: string;
  instanceId?: string;
  endpoint?: string;
  flushIntervalMs?: number;
  timeoutMs?: number;
  executionMode?: ExecutionMode;
  apiToken?: string;
  currentReplicas?: ReplicaProvider;
  headers?: Record<string, string>;
  ignorePaths?: Array<string | RegExp>;
  logger?: FluxScaleLogger;
  disabled?: boolean;
  workloadLabel?: (request: Request) => string | undefined;
}

interface MetricWindow {
  startedAt: number;
  requests: number;
  failures: number;
  durations: number[];
  workloads: Map<string, { requests: number; failures: number; durations: number[] }>;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:8080";
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DELIVERY_WARNING_INTERVAL_MS = 10_000;
const MAX_DURATION_SAMPLES = 10_000;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort(
    (first, second) => first - second,
  );

  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
  );

  return sorted[index] ?? 0;
}

function environmentReplicaCount(): number {
  const rawValue =
    process.env.FLUXSCALE_CURRENT_REPLICAS ??
    process.env.KUBERNETES_REPLICAS ??
    "1";

  const parsed = Number.parseInt(rawValue, 10);

  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : 1;
}

function normalizeEndpoint(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, "");

  if (!normalized) {
    throw new Error("FluxScale endpoint cannot be empty.");
  }

  const parsed = new URL(normalized);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "FluxScale endpoint must use the http or https protocol.",
    );
  }

  return normalized;
}

function normalizeServiceName(service: string): string {
  const normalized = service.trim();

  if (!normalized) {
    throw new Error("FluxScale service name cannot be empty.");
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
    throw new Error(
      "FluxScale service name may only contain letters, numbers, dots, underscores and hyphens.",
    );
  }

  return normalized;
}

function normalizeInstanceId(instanceId: string | undefined): string {
  const normalized = (
    instanceId ??
    process.env.FLUXSCALE_INSTANCE_ID ??
    `${hostname()}-${process.pid}`
  ).trim();

  if (
    !normalized ||
    normalized.length > 128 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(normalized)
  ) {
    throw new Error(
      "FluxScale instanceId must contain 1-128 letters, numbers, dots, underscores, colons or hyphens.",
    );
  }

  return normalized;
}

function normalizeExecutionMode(mode: ExecutionMode | undefined): ExecutionMode {
  return mode === "managed" ? "managed" : "observe_only";
}

function normalizeApiToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }

  if (token.length < 32 || token.length > 512) {
    throw new Error(
      "FluxScale apiToken must contain between 32 and 512 characters.",
    );
  }

  if (/\s/.test(token)) {
    throw new Error("FluxScale apiToken cannot contain whitespace.");
  }

  return token;
}

function normalizeCustomHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized = { ...headers };
  const reserved = new Set([
    "accept",
    "authorization",
    "content-type",
    "x-fluxscale-execution-mode",
  ]);

  for (const name of Object.keys(normalized)) {
    if (reserved.has(name.toLowerCase())) {
      throw new Error(
        `FluxScale header ${name} is reserved; use apiToken or executionMode instead.`,
      );
    }
  }

  return normalized;
}

export class FluxScale {
  readonly middleware: RequestHandler;

  private readonly service: string;
  private readonly instanceId: string;
  private readonly endpoint: string;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly executionMode: ExecutionMode;
  private readonly apiToken?: string;
  private readonly replicaProvider: ReplicaProvider;
  private readonly headers: Record<string, string>;
  private readonly ignorePaths: Array<string | RegExp>;
  private readonly logger?: FluxScaleLogger;
  private readonly disabled: boolean;
  private readonly workloadLabel?: FluxScaleOptions["workloadLabel"];
  private readonly workloadNames = new Set<string>();

  private activeRequests = 0;
  private metricWindow: MetricWindow;
  private lastCpuUsage = process.cpuUsage();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<FluxScaleIngestResponse | null>;
  private retryMetric?: FluxScaleMetric;
  private lastDeliveryWarningAt = 0;
  private suppressedDeliveryWarnings = 0;
  private closed = false;

  constructor(options: FluxScaleOptions) {
    this.service = normalizeServiceName(options.service);
    this.instanceId = normalizeInstanceId(options.instanceId);
    this.endpoint = normalizeEndpoint(
      options.endpoint ?? DEFAULT_ENDPOINT,
    );

    this.flushIntervalMs =
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executionMode = normalizeExecutionMode(options.executionMode);
    this.apiToken = normalizeApiToken(options.apiToken);
    this.replicaProvider =
      options.currentReplicas ?? environmentReplicaCount;

    this.headers = normalizeCustomHeaders(options.headers);
    this.ignorePaths = options.ignorePaths ?? [
      "/health",
      "/healthz",
      "/ready",
      "/readyz",
    ];

    this.logger = options.logger;
    this.disabled = options.disabled ?? false;
    this.workloadLabel = options.workloadLabel;

    if (this.flushIntervalMs < 250) {
      throw new Error(
        "FluxScale flushIntervalMs must be at least 250 milliseconds.",
      );
    }

    if (this.timeoutMs < 250) {
      throw new Error(
        "FluxScale timeoutMs must be at least 250 milliseconds.",
      );
    }

    this.metricWindow = this.createMetricWindow();

    this.middleware = (request, response, next) => {
      if (
        this.disabled ||
        this.closed ||
        this.shouldIgnore(request.path)
      ) {
        next();
        return;
      }

      const startedAt = performance.now();
      let finalized = false;
      let workload: string | undefined;
      try {
        const label = this.workloadLabel?.(request);
        if (label && /^[A-Za-z0-9._-]{1,32}$/.test(label) && (this.workloadNames.has(label) || this.workloadNames.size < 8)) {
          workload = label;
          this.workloadNames.add(label);
        }
      } catch {
        this.logger?.warn?.("Workload classification failed; request telemetry continues");
      }

      this.activeRequests += 1;
      this.metricWindow.requests += 1;

      const finalize = () => {
        if (finalized) {
          return;
        }

        finalized = true;
        this.activeRequests = Math.max(
          0,
          this.activeRequests - 1,
        );

        const duration = Math.max(
          0,
          performance.now() - startedAt,
        );

        if (
          this.metricWindow.durations.length <
          MAX_DURATION_SAMPLES
        ) {
          this.metricWindow.durations.push(duration);
        }

        if (response.statusCode >= 500) {
          this.metricWindow.failures += 1;
        }
        if (workload) {
          let group = this.metricWindow.workloads.get(workload);
          if (!group) {
            group = { requests: 0, failures: 0, durations: [] };
            this.metricWindow.workloads.set(workload, group);
          }
          group.requests++;
          if (response.statusCode >= 500) group.failures++;
          if (group.durations.length < MAX_DURATION_SAMPLES) group.durations.push(duration);
        }
      };

      response.once("finish", finalize);
      response.once("close", finalize);

      next();
    };

    if (!this.disabled) {
      this.start();
    }
  }

  getSnapshot(): Readonly<FluxScaleSnapshot> {
    return this.previewSnapshot();
  }

  flush(): Promise<FluxScaleIngestResponse | null> {
    if (this.disabled || this.closed) {
      return Promise.resolve(null);
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const task = this.performFlush().finally(() => {
      if (this.inFlight === task) {
        this.inFlight = undefined;
      }
    });

    this.inFlight = task;
    return task;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.inFlight) {
      await this.inFlight;
    }

    if (!this.disabled) {
      await this.flush();
    }

    this.closed = true;
  }

  private start(): void {
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    this.timer.unref();
  }

  private createMetricWindow(): MetricWindow {
    return {
      startedAt: performance.now(),
      requests: 0,
      failures: 0,
      durations: [],
      workloads: new Map([...this.workloadNames].map(name => [name, { requests: 0, failures: 0, durations: [] }])),
    };
  }

  private workloadSnapshot(window: MetricWindow, seconds: number): WorkloadMetric[] {
    return [...window.workloads].map(([name, group]) => ({ name, requests_per_second: group.requests / seconds, completed_requests: group.requests, failed_requests: group.failures, p95_latency_ms: percentile95(group.durations) }));
  }

  private shouldIgnore(path: string): boolean {
    return this.ignorePaths.some((matcher) => {
      if (typeof matcher === "string") {
        return path === matcher || path.startsWith(`${matcher}/`);
      }

      matcher.lastIndex = 0;
      return matcher.test(path);
    });
  }

  private previewSnapshot(): FluxScaleSnapshot {
    const now = performance.now();
    const elapsedSeconds = Math.max(
      (now - this.metricWindow.startedAt) / 1_000,
      0.001,
    );

    const replicaCount = this.resolveSynchronousReplicaCount();

    return {
      service: this.service,
      instance_id: this.instanceId,
      timestamp: new Date().toISOString(),
      requests_per_second:
        this.metricWindow.requests / elapsedSeconds,
      active_requests: this.activeRequests,
      p95_latency_ms: percentile95(
        this.metricWindow.durations,
      ),
      error_rate:
        this.metricWindow.requests > 0
          ? this.metricWindow.failures /
            this.metricWindow.requests
          : 0,
      cpu_percent: 0,
      memory_percent: this.readMemoryPercent(),
      current_replicas: replicaCount,
      workloads: this.workloadSnapshot(this.metricWindow, elapsedSeconds),
      window_seconds: elapsedSeconds,
      completed_requests:
        this.metricWindow.durations.length,
      failed_requests: this.metricWindow.failures,
    };
  }

  private async captureSnapshot(): Promise<FluxScaleSnapshot> {
    const capturedWindow = this.metricWindow;
    this.metricWindow = this.createMetricWindow();

    const now = performance.now();
    const elapsedSeconds = Math.max(
      (now - capturedWindow.startedAt) / 1_000,
      0.001,
    );

    const cpuUsage = process.cpuUsage();
    const cpuMicroseconds =
      cpuUsage.user -
      this.lastCpuUsage.user +
      (cpuUsage.system - this.lastCpuUsage.system);

    this.lastCpuUsage = cpuUsage;

    const logicalProcessors = readCpuCount();

    const cpuPercent = clamp(
      (cpuMicroseconds /
        (elapsedSeconds * 1_000_000 * logicalProcessors)) *
        100,
      0,
      100,
    );

    const currentReplicas = await this.resolveReplicaCount();

    return {
      service: this.service,
      instance_id: this.instanceId,
      timestamp: new Date().toISOString(),
      requests_per_second:
        capturedWindow.requests / elapsedSeconds,
      active_requests: this.activeRequests,
      p95_latency_ms: percentile95(
        capturedWindow.durations,
      ),
      error_rate:
        capturedWindow.requests > 0
          ? capturedWindow.failures /
            capturedWindow.requests
          : 0,
      cpu_percent: cpuPercent,
      memory_percent: this.readMemoryPercent(),
      current_replicas: currentReplicas,
      workloads: this.workloadSnapshot(capturedWindow, elapsedSeconds),
      window_seconds: elapsedSeconds,
      completed_requests:
        capturedWindow.durations.length,
      failed_requests: capturedWindow.failures,
    };
  }

  private readMemoryPercent(): number {
    const totalMemory = readMemoryLimit();

    if (totalMemory <= 0) {
      return 0;
    }

    return clamp(
      (process.memoryUsage().rss / totalMemory) * 100,
      0,
      100,
    );
  }

  private resolveSynchronousReplicaCount(): number {
    if (typeof this.replicaProvider === "number") {
      return Math.max(
        1,
        Math.floor(this.replicaProvider),
      );
    }

    return environmentReplicaCount();
  }

  private async resolveReplicaCount(): Promise<number> {
    const value =
      typeof this.replicaProvider === "function"
        ? await this.replicaProvider()
        : this.replicaProvider;

    if (!Number.isFinite(value) || value <= 0) {
      this.logger?.warn?.(
        "FluxScale replica provider returned an invalid value. Falling back to one replica.",
        { value },
      );

      return 1;
    }

    return Math.max(1, Math.floor(value));
  }

  private metricFromSnapshot(snapshot: FluxScaleSnapshot): FluxScaleMetric {
    return {
      service: snapshot.service,
      instance_id: snapshot.instance_id,
      timestamp: snapshot.timestamp,
      requests_per_second: snapshot.requests_per_second,
      active_requests: snapshot.active_requests,
      p95_latency_ms: snapshot.p95_latency_ms,
      error_rate: snapshot.error_rate,
      cpu_percent: snapshot.cpu_percent,
      memory_percent: snapshot.memory_percent,
      current_replicas: snapshot.current_replicas,
      workloads: snapshot.workloads,
    };
  }

  private warnDeliveryFailure(error: unknown): void {
    const now = Date.now();

    if (
      now - this.lastDeliveryWarningAt <
      DELIVERY_WARNING_INTERVAL_MS
    ) {
      this.suppressedDeliveryWarnings += 1;
      return;
    }

    this.logger?.warn?.(
      "FluxScale telemetry delivery failed. The window will be retried and application traffic was not affected.",
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
        suppressedWarnings:
          this.suppressedDeliveryWarnings,
      },
    );

    this.lastDeliveryWarningAt = now;
    this.suppressedDeliveryWarnings = 0;
  }

  private async performFlush(): Promise<FluxScaleIngestResponse | null> {
    const retrying = this.retryMetric !== undefined;
    const metric =
      this.retryMetric ??
      this.metricFromSnapshot(await this.captureSnapshot());

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    timeout.unref();

    try {
      const headers = new Headers(this.headers);
      headers.set("Accept", "application/json");
      headers.set("Content-Type", "application/json");
      headers.set("X-FluxScale-Execution-Mode", this.executionMode);

      if (this.apiToken) {
        headers.set("Authorization", `Bearer ${this.apiToken}`);
      }

      const response = await fetch(
        `${this.endpoint}/api/v1/metrics`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(metric),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          this.retryMetric = metric;
          this.warnDeliveryFailure(new Error(`Controller returned HTTP ${response.status}`));
          return null;
        }
        const responseBody = await response.text();

        this.logger?.warn?.(
          "FluxScale rejected a telemetry window.",
          {
            status: response.status,
            response: responseBody,
          },
        );

        if (this.retryMetric === metric) {
          this.retryMetric = undefined;
        }

        return null;
      }

      const result =
        (await response.json()) as FluxScaleIngestResponse;

      if (this.retryMetric === metric) {
        this.retryMetric = undefined;
      }

      this.logger?.debug?.(
        "FluxScale telemetry window accepted.",
        {
          service: this.service,
          requestsPerSecond:
            metric.requests_per_second,
          action: result.decision.action,
          desiredReplicas:
            result.decision.desired_replicas,
          executionMode: this.executionMode,
          retried: retrying,
          duplicate: result.duplicate ?? false,
        },
      );

      return result;
    } catch (error) {
      this.retryMetric = metric;
      this.warnDeliveryFailure(error);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createFluxScale(
  options: FluxScaleOptions,
): FluxScale {
  return new FluxScale(options);
}
