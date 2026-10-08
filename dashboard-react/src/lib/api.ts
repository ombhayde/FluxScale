import { getDashboardReadToken } from "./auth.ts";

export type ScalingAction = "scale_up" | "scale_down" | "hold";
export type ServiceStatus = "healthy" | "degraded" | "critical" | "scaling";
export type CapacityPhase = "warming_up" | "learning" | "saturation_observed";
export type PersistenceStatus = "healthy" | "degraded";
export type RestoreSource = "empty" | "primary" | "backup";

export interface ControlPlaneSecurity {
  enabled: boolean;
  public_health: boolean;
  permissions: string[];
}

export interface ControlPlaneCapabilities {
  audit: boolean;
  observability: {
    metrics: string;
    ready: string;
  };
  draining: boolean;
  adaptive_capacity: boolean;
  secure_ingest: boolean;
}

export interface ControlPlaneHealth {
  workspace?: string;
  version: string;
  status: string;
  phase: number;
  release: string;
  capabilities: ControlPlaneCapabilities;
  security: ControlPlaneSecurity;
  operations: ControlPlaneOperations;
}

export interface ControlPlaneOperations {
  request_id_header: string;
  audit_endpoint: string;
  audit_capacity: number;
  rate_limiting_enabled: boolean;
  limits_per_minute: {
    health: number;
    read: number;
    ingest: number;
    audit: number;
  };
  credential_storage: string;
}

export type AuditRequestClass = "health" | "read" | "ingest" | "audit";

export interface OperationalAuditEvent {
  timestamp: string;
  request_id: string;
  method: string;
  path: string;
  request_class: AuditRequestClass;
  status: number;
  latency_ms: number;
  rate_limited: boolean;
}

export interface OperationsSnapshot {
  generated_at: string;
  rate_limiting_enabled: boolean;
  audit_capacity: number;
  events: OperationalAuditEvent[];
}

export class FluxScaleApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "FluxScaleApiError";
    this.status = status;
    this.code = code;
  }
}

export interface MetricSample {
  timestamp: string;
  requests_per_second: number;
  active_requests: number;
  p95_latency_ms: number;
  error_rate: number;
  cpu_percent: number;
  memory_percent: number;
  current_replicas: number;
}

export interface FleetInstance {
  instance_id: string;
  fresh: boolean;
  last_sample: MetricSample;
  last_decision_id: string;
}

export interface ServiceInstancesResponse {
  service: string;
  instance_stale_after_seconds: number;
  instances: FleetInstance[];
}

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

export interface CapacityEstimate {
  phase: CapacityPhase;
  safe_rps_per_replica: number | null;
  observed_peak_rps_per_replica: number;
  saturation_rps_per_replica: number | null;
  confidence: number;
  confidence_percent: number;
  sample_count: number;
  healthy_samples: number;
  stressed_samples: number;
  baseline_p95_latency_ms: number;
  baseline_error_rate: number;
  manual_input_required: boolean;
}

export interface WorkloadMetric {
  name: string; requests_per_second: number; completed_requests: number; failed_requests: number; p95_latency_ms: number;
}

export interface DashboardService {
  workloads: WorkloadMetric[];
  service: string;
  status: ServiceStatus;
  requests_per_second: number;
  predicted_rps: number;
  p95_latency_ms: number;
  error_rate: number;
  cpu_percent: number;
  memory_percent: number;
  current_replicas: number;
  desired_replicas: number;
  healthy_backends: number;
  action: ScalingAction;
  updated_at: string;
  capacity: CapacityEstimate;
}

export interface DashboardSummary {
  services: number;
  healthy_services: number;
  degraded_services: number;
  critical_services: number;
  scaling_services: number;
  healthy_backends: number;
  total_requests_per_second: number;
  average_p95_latency_ms: number;
  average_cpu_percent: number;
  average_memory_percent: number;
  average_capacity_confidence: number;
  capacity_warming_up_services: number;
  capacity_learning_services: number;
  saturation_observed_services: number;
}

export interface DashboardOverview {
  generated_at: string;

  adaptive_capacity: {
    enabled: boolean;
    manual_input_required: boolean;
  };

  persistence: PersistenceOverview;

  summary: DashboardSummary;
  services: DashboardService[];
  recent_decisions: ScalingDecision[];
}

export interface PersistenceOverview {
  enabled: boolean;
  status: PersistenceStatus;
  state_schema_version: number;
  path: string;
  restore_source: RestoreSource;
  restored_at: string | null;
  restored_services: number;
  restored_metric_samples: number;
  restored_decisions: number;
  last_successful_save_at: string | null;
  last_save_error: string | null;
  last_cleanup_at: string | null;
  services_removed_total: number;
  stale_service_ttl_seconds: number;
  maintenance_interval_seconds: number;
}

export interface ServiceCapacityResponse {
  service: string;
  adaptive_capacity: boolean;
  manual_input_required: boolean;
  estimate: CapacityEstimate;
}

export interface TrafficPoint {
  timestamp: string;
  actual: number | null;
  predicted: number | null;
  capacity: number | null;
}

type UnknownRecord = Record<string, unknown>;

const TELEMETRY_STALE_AFTER_MS = 15_000;

const EMPTY_CAPACITY: CapacityEstimate = {
  phase: "warming_up",
  safe_rps_per_replica: null,
  observed_peak_rps_per_replica: 0,
  saturation_rps_per_replica: null,
  confidence: 0,
  confidence_percent: 0,
  sample_count: 0,
  healthy_samples: 0,
  stressed_samples: 0,
  baseline_p95_latency_ms: 0,
  baseline_error_rate: 0,
  manual_input_required: false,
};

const EMPTY_SUMMARY: DashboardSummary = {
  services: 0,
  healthy_services: 0,
  degraded_services: 0,
  critical_services: 0,
  scaling_services: 0,
  healthy_backends: 0,
  total_requests_per_second: 0,
  average_p95_latency_ms: 0,
  average_cpu_percent: 0,
  average_memory_percent: 0,
  average_capacity_confidence: 0,
  capacity_warming_up_services: 0,
  capacity_learning_services: 0,
  saturation_observed_services: 0,
};

const EMPTY_PERSISTENCE: PersistenceOverview = {
  enabled: false,
  status: "degraded",
  state_schema_version: 0,
  path: "",
  restore_source: "empty",
  restored_at: null,
  restored_services: 0,
  restored_metric_samples: 0,
  restored_decisions: 0,
  last_successful_save_at: null,
  last_save_error: null,
  last_cleanup_at: null,
  services_removed_total: 0,
  stale_service_ttl_seconds: 0,
  maintenance_interval_seconds: 0,
};

function asRecord(value: unknown): UnknownRecord {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(
  value: unknown,
  fallback = 0,
): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function asOptionalNumber(
  value: unknown,
): number | null {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const parsed = asNumber(
    value,
    Number.NaN,
  );

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function asInteger(
  value: unknown,
  fallback = 0,
): number {
  return Math.max(
    0,
    Math.round(
      asNumber(value, fallback),
    ),
  );
}

function asBoolean(
  value: unknown,
  fallback = false,
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (
    typeof value === "string" &&
    value.toLowerCase() === "true"
  ) {
    return true;
  }

  if (
    typeof value === "string" &&
    value.toLowerCase() === "false"
  ) {
    return false;
  }

  return fallback;
}

function asString(
  value: unknown,
  fallback = "",
): string {
  return typeof value === "string" &&
    value.trim()
    ? value
    : fallback;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
    : null;
}

function asTimestamp(
  value: unknown,
): string {
  const fallback =
    new Date().toISOString();

  const parsed = new Date(
    asString(value, fallback),
  );

  return Number.isNaN(
    parsed.getTime(),
  )
    ? fallback
    : parsed.toISOString();
}

function normalizeAction(
  value: unknown,
): ScalingAction {
  const action = asString(
    value,
    "hold",
  ).toLowerCase();

  return action === "scale_up" ||
    action === "scale_down"
    ? action
    : "hold";
}

function normalizeCapacityPhase(
  value: unknown,
): CapacityPhase {
  const phase = asString(
    value,
    "warming_up",
  ).toLowerCase();

  if (
    phase === "learning" ||
    phase === "saturation_observed"
  ) {
    return phase;
  }

  return "warming_up";
}

function normalizeCapacity(
  value: unknown,
  observedFallback = 0,
): CapacityEstimate {
  const capacity = asRecord(value);

  const confidence = Math.min(
    1,
    Math.max(
      0,
      asNumber(capacity.confidence),
    ),
  );

  return {
    ...EMPTY_CAPACITY,

    phase: normalizeCapacityPhase(
      capacity.phase,
    ),

    safe_rps_per_replica:
      asOptionalNumber(
        capacity.safe_rps_per_replica,
      ),

    observed_peak_rps_per_replica:
      asNumber(
        capacity
          .observed_peak_rps_per_replica,
        observedFallback,
      ),

    saturation_rps_per_replica:
      asOptionalNumber(
        capacity
          .saturation_rps_per_replica,
      ),

    confidence,

    confidence_percent:
      asNumber(
        capacity.confidence_percent,
        confidence * 100,
      ),

    sample_count:
      asInteger(
        capacity.sample_count,
      ),

    healthy_samples:
      asInteger(
        capacity.healthy_samples,
      ),

    stressed_samples:
      asInteger(
        capacity.stressed_samples,
      ),

    baseline_p95_latency_ms:
      asNumber(
        capacity
          .baseline_p95_latency_ms,
      ),

    baseline_error_rate:
      asNumber(
        capacity.baseline_error_rate,
      ),

    manual_input_required:
      asBoolean(
        capacity
          .manual_input_required,
        false,
      ),
  };
}

function normalizePersistence(value: unknown): PersistenceOverview {
  const persistence = asRecord(value);
  const requestedStatus = asString(
    persistence.status,
    "degraded",
  ).toLowerCase();
  const requestedRestoreSource = asString(
    persistence.restore_source,
    "empty",
  ).toLowerCase();

  return {
    ...EMPTY_PERSISTENCE,
    enabled: asBoolean(persistence.enabled),
    status:
      requestedStatus === "healthy"
        ? "healthy"
        : "degraded",
    state_schema_version: asInteger(
      persistence.state_schema_version,
    ),
    path: asString(persistence.path),
    restore_source:
      requestedRestoreSource === "primary" ||
      requestedRestoreSource === "backup"
        ? requestedRestoreSource
        : "empty",
    restored_at: asOptionalString(persistence.restored_at),
    restored_services: asInteger(
      persistence.restored_services,
    ),
    restored_metric_samples: asInteger(
      persistence.restored_metric_samples,
    ),
    restored_decisions: asInteger(
      persistence.restored_decisions,
    ),
    last_successful_save_at: asOptionalString(
      persistence.last_successful_save_at,
    ),
    last_save_error: asOptionalString(
      persistence.last_save_error,
    ),
    last_cleanup_at: asOptionalString(
      persistence.last_cleanup_at,
    ),
    services_removed_total: asInteger(
      persistence.services_removed_total,
    ),
    stale_service_ttl_seconds: asInteger(
      persistence.stale_service_ttl_seconds,
    ),
    maintenance_interval_seconds: asInteger(
      persistence.maintenance_interval_seconds,
    ),
  };
}

function isFresh(
  timestamp: string,
): boolean {
  const age =
    Date.now() -
    new Date(timestamp).getTime();

  return Number.isFinite(age) &&
    age <= TELEMETRY_STALE_AFTER_MS;
}

function inferStatus(
  requested: unknown,
  action: ScalingAction,
  errorRate: number,
  latency: number,
  cpu: number,
  updatedAt: string,
  currentReplicas: number,
  healthyBackends: number,
): ServiceStatus {
  if (action !== "hold") {
    return "scaling";
  }

  if (
    errorRate >= 0.05 ||
    latency >= 2_000 ||
    cpu >= 90
  ) {
    return "critical";
  }

  if (
    errorRate >= 0.02 ||
    latency >= 800 ||
    cpu >= 80
  ) {
    return "degraded";
  }

  if (!isFresh(updatedAt)) {
    return "critical";
  }

  const status = asString(
    requested,
  ).toLowerCase();

  if (
    status === "critical" &&
    currentReplicas > 0 &&
    healthyBackends === 0
  ) {
    return "healthy";
  }

  if (
    [
      "healthy",
      "degraded",
      "critical",
      "scaling",
    ].includes(status)
  ) {
    return status as ServiceStatus;
  }

  return "healthy";
}

function normalizeMetric(
  value: unknown,
): MetricSample {
  const metric = asRecord(value);

  return {
    timestamp: asTimestamp(
      metric.timestamp,
    ),

    requests_per_second:
      asNumber(
        metric.requests_per_second,
      ),

    active_requests:
      asInteger(
        metric.active_requests,
      ),

    p95_latency_ms:
      asNumber(
        metric.p95_latency_ms,
      ),

    error_rate:
      asNumber(
        metric.error_rate,
      ),

    cpu_percent:
      asNumber(
        metric.cpu_percent,
      ),

    memory_percent:
      asNumber(
        metric.memory_percent,
      ),

    current_replicas: Math.max(
      1,
      asInteger(
        metric.current_replicas,
        1,
      ),
    ),
  };
}

function normalizeDecision(
  value: unknown,
): ScalingDecision {
  const decision = asRecord(value);

  return {
    id: asString(
      decision.id,
      "unknown",
    ),

    service: asString(
      decision.service,
      "unknown-service",
    ),

    timestamp: asTimestamp(
      decision.timestamp,
    ),

    action: normalizeAction(
      decision.action,
    ),

    current_replicas:
      asInteger(
        decision.current_replicas,
      ),

    desired_replicas:
      asInteger(
        decision.desired_replicas,
      ),

    current_rps:
      asNumber(
        decision.current_rps,
      ),

    predicted_rps:
      asNumber(
        decision.predicted_rps,
      ),

    prediction_horizon_seconds:
      asInteger(
        decision
          .prediction_horizon_seconds,
      ),

    reasons: asArray(
      decision.reasons,
    )
      .map((item) =>
        asString(item),
      )
      .filter(Boolean),
  };
}

function normalizeService(
  value: unknown,
): DashboardService {
  const service = asRecord(value);

  const latest = asRecord(
    service.latest,
  );

  const decision = asRecord(
    service.latest_decision ??
      service.decision,
  );

  const action = normalizeAction(
    service.action ??
      decision.action,
  );

  const requests = asNumber(
    service.requests_per_second ??
      latest.requests_per_second,
  );

  const predicted = asNumber(
    service.predicted_rps ??
      decision.predicted_rps,
    requests,
  );

  const latency = asNumber(
    service.p95_latency_ms ??
      latest.p95_latency_ms,
  );

  const errorRate = asNumber(
    service.error_rate ??
      latest.error_rate,
  );

  const cpu = asNumber(
    service.cpu_percent ??
      latest.cpu_percent,
  );

  const memory = asNumber(
    service.memory_percent ??
      latest.memory_percent,
  );

  const current = Math.max(
    1,
    asInteger(
      service.current_replicas ??
        decision.current_replicas ??
        latest.current_replicas,
      1,
    ),
  );

  const desired = Math.max(
    1,
    asInteger(
      service.desired_replicas ??
        decision.desired_replicas,
      current,
    ),
  );

  const healthyBackends =
    asInteger(
      service.healthy_backends,
      current,
    );

  const updatedAt = asTimestamp(
    service.updated_at ??
      service.timestamp ??
      latest.timestamp ??
      decision.timestamp,
  );

  return {
    service: asString(
      service.service ??
        service.name,
      "unknown-service",
    ),

    status: inferStatus(
      service.status,
      action,
      errorRate,
      latency,
      cpu,
      updatedAt,
      current,
      healthyBackends,
    ),

    requests_per_second:
      requests,

    predicted_rps:
      predicted,

    p95_latency_ms:
      latency,

    error_rate:
      errorRate,

    cpu_percent:
      cpu,

    memory_percent:
      memory,

    current_replicas:
      current,

    desired_replicas:
      desired,

    healthy_backends:
      healthyBackends,

    action,

    updated_at:
      updatedAt,

    workloads: Array.isArray(service.workloads) ? service.workloads.slice(0,8).map(value => { const w = asRecord(value); return { name: asString(w.name), requests_per_second: Math.max(0,asNumber(w.requests_per_second)), completed_requests: Math.max(0,asNumber(w.completed_requests)), failed_requests: Math.max(0,asNumber(w.failed_requests)), p95_latency_ms: Math.max(0,asNumber(w.p95_latency_ms)) }; }) : [],
    capacity: normalizeCapacity(
      service.capacity,
      requests / current,
    ),
  };
}

function calculatedSummary(
  services: DashboardService[],
): DashboardSummary {
  if (!services.length) {
    return {
      ...EMPTY_SUMMARY,
    };
  }

  const count = (
    status: ServiceStatus,
  ) =>
    services.filter(
      (service) =>
        service.status === status,
    ).length;

  const total = (
    select: (
      service: DashboardService,
    ) => number,
  ) =>
    services.reduce(
      (sum, service) =>
        sum + select(service),
      0,
    );

  const capacityCount = (
    phase: CapacityPhase,
  ) =>
    services.filter(
      (service) =>
        service.capacity.phase === phase,
    ).length;

  return {
    services: services.length,

    healthy_services:
      count("healthy"),

    degraded_services:
      count("degraded"),

    critical_services:
      count("critical"),

    scaling_services:
      count("scaling"),

    healthy_backends:
      total(
        (service) =>
          service.healthy_backends,
      ),

    total_requests_per_second:
      total(
        (service) =>
          service.requests_per_second,
      ),

    average_p95_latency_ms:
      total(
        (service) =>
          service.p95_latency_ms,
      ) / services.length,

    average_cpu_percent:
      total(
        (service) =>
          service.cpu_percent,
      ) / services.length,

    average_memory_percent:
      total(
        (service) =>
          service.memory_percent,
      ) / services.length,

    average_capacity_confidence:
      total(
        (service) =>
          service.capacity.confidence,
      ) / services.length,

    capacity_warming_up_services:
      capacityCount("warming_up"),

    capacity_learning_services:
      capacityCount("learning"),

    saturation_observed_services:
      capacityCount(
        "saturation_observed",
      ),
  };
}

interface RequestJsonOptions {
  token?: string;
}

function responseError(
  status: number,
  statusText: string,
  body: string,
): FluxScaleApiError {
  let code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "api_error";
  let message = body || `FluxScale API returned ${status} ${statusText}`;

  if (body) {
    try {
      const document = asRecord(JSON.parse(body));
      const error = asRecord(document.error);

      code = asString(error.code, code);
      message = asString(error.message, message);
    } catch {
      // Non-JSON server responses remain useful as plain-text messages.
    }
  }

  return new FluxScaleApiError(status, code, message);
}

async function requestJson(
  path: string,
  options: RequestJsonOptions = {},
): Promise<unknown> {
  const headers = new Headers({
    Accept: "application/json",
  });

  const token = options.token ?? getDashboardReadToken();
  const connectedProject = typeof window !== 'undefined' ? window.location.pathname.match(/^\/projects\/([A-Za-z0-9_-]{43})\/console\/?$/)?.[1] : undefined;

  if (token && !connectedProject) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(connectedProject ? `/api/projects/${connectedProject}/console${path}` : path, {
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    if (connectedProject && response.status === 401) window.location.assign('/connected');
    throw responseError(
      response.status,
      response.statusText,
      await response.text(),
    );
  }

  return response.json() as Promise<unknown>;
}

export function isDashboardAuthenticationError(error: unknown): boolean {
  return (
    error instanceof FluxScaleApiError &&
    (error.status === 401 || error.status === 403)
  );
}

export async function verifyDashboardReadToken(token: string): Promise<void> {
  await requestJson("/api/v1/services", { token });
}

export async function fetchControlPlaneHealth(): Promise<ControlPlaneHealth> {
  const response = asRecord(await requestJson("/health"));
  const security = asRecord(response.security);
  const operations = asRecord(response.operations);
  const limits = asRecord(operations.limits_per_minute);
  const capabilities = asRecord(response.capabilities);
  const observabilityCapability = asRecord(capabilities.observability);

  return {
    workspace: asString(response.workspace) || undefined,
    status: asString(response.status, "unknown"),
    phase: asInteger(response.phase),
    release: asString(response.release, `${asInteger(response.phase)}`),
    version: asString(response.version, "Unknown version"),
    capabilities: {
      audit: asBoolean(capabilities.audit),
      observability: {
        metrics: asString(
          observabilityCapability.metrics,
          "/api/v1/observability/metrics",
        ),
        ready: asString(
          observabilityCapability.ready,
          "/api/v1/observability/ready",
        ),
      },
      draining: asBoolean(capabilities.draining),
      adaptive_capacity: asBoolean(capabilities.adaptive_capacity),
      secure_ingest: asBoolean(capabilities.secure_ingest),
    },
    security: {
      enabled: asBoolean(security.enabled),
      public_health: asBoolean(security.public_health, true),
      permissions: asArray(security.permissions)
        .map((permission) => asString(permission))
        .filter(Boolean),
    },
    operations: {
      request_id_header: asString(
        operations.request_id_header,
        "X-Request-Id",
      ),
      audit_endpoint: asString(
        operations.audit_endpoint,
        "/api/v1/audit",
      ),
      audit_capacity: asInteger(operations.audit_capacity, 2_000),
      rate_limiting_enabled: asBoolean(
        operations.rate_limiting_enabled,
      ),
      limits_per_minute: {
        health: asInteger(limits.health),
        read: asInteger(limits.read),
        ingest: asInteger(limits.ingest),
        audit: asInteger(limits.audit),
      },
      credential_storage: asString(
        operations.credential_storage,
        "fingerprint_only",
      ),
    },
  };
}

export async function fetchOperationsAudit(): Promise<OperationsSnapshot> {
  const response = asRecord(await requestJson("/api/v1/audit"));

  const events = asArray(response.events).map((value): OperationalAuditEvent => {
    const event = asRecord(value);
    const requestClass = asString(event.request_class, "read");

    return {
      timestamp: asTimestamp(event.timestamp),
      request_id: asString(event.request_id, "unknown"),
      method: asString(event.method, "GET").toUpperCase(),
      path: asString(event.path, "/"),
      request_class: (
        ["health", "read", "ingest", "audit"].includes(requestClass)
          ? requestClass
          : "read"
      ) as AuditRequestClass,
      status: asInteger(event.status),
      latency_ms: asInteger(event.latency_ms),
      rate_limited: asBoolean(event.rate_limited),
    };
  });

  return {
    generated_at: asTimestamp(response.generated_at),
    rate_limiting_enabled: asBoolean(response.rate_limiting_enabled),
    audit_capacity: asInteger(response.audit_capacity, 2_000),
    events,
  };
}

export async function fetchDashboardOverview():
Promise<DashboardOverview> {
  const response = asRecord(
    await requestJson(
      "/api/v1/dashboard/overview",
    ),
  );

  const adaptive = asRecord(
    response.adaptive_capacity,
  );

  const persistence = normalizePersistence(
    response.persistence,
  );

  const services = asArray(
    response.services,
  ).map(normalizeService);

  return {
    generated_at: asTimestamp(
      response.generated_at,
    ),

    adaptive_capacity: {
      enabled: asBoolean(
        adaptive.enabled,
        true,
      ),

      manual_input_required:
        asBoolean(
          adaptive
            .manual_input_required,
          false,
        ),
    },

    persistence,

    summary:
      calculatedSummary(services),

    services,

    recent_decisions:
      asArray(
        response.recent_decisions,
      ).map(normalizeDecision),
  };
}

export async function fetchServiceMetrics(
  service: string,
): Promise<MetricSample[]> {
  if (!service.trim()) {
    return [];
  }

  const response = await requestJson(
    `/api/v1/services/${
      encodeURIComponent(service)
    }/metrics`,
  );

  return asArray(response)
    .map(normalizeMetric)
    .sort(
      (first, second) =>
        new Date(
          first.timestamp,
        ).getTime() -
        new Date(
          second.timestamp,
        ).getTime(),
    );
}

export async function fetchServiceInstances(
  service: string,
): Promise<ServiceInstancesResponse | null> {
  if (!service.trim()) {
    return null;
  }

  const response = asRecord(
    await requestJson(
      `/api/v1/services/${
        encodeURIComponent(service)
      }/instances`,
    ),
  );

  const instances = asArray(
    response.instances,
  )
    .map((value): FleetInstance => {
      const instance = asRecord(value);

      return {
        instance_id: asString(
          instance.instance_id,
          "unknown-instance",
        ),
        fresh: asBoolean(instance.fresh),
        last_sample: normalizeMetric(
          instance.last_sample,
        ),
        last_decision_id: asString(
          instance.last_decision_id,
        ),
      };
    })
    .sort((left, right) => {
      if (left.fresh !== right.fresh) {
        return left.fresh ? -1 : 1;
      }

      return left.instance_id.localeCompare(
        right.instance_id,
      );
    });

  return {
    service: asString(
      response.service,
      service,
    ),
    instance_stale_after_seconds:
      asInteger(
        response
          .instance_stale_after_seconds,
      ),
    instances,
  };
}

export async function fetchServiceCapacity(
  service: string,
): Promise<ServiceCapacityResponse | null> {
  if (!service.trim()) {
    return null;
  }

  const response = asRecord(
    await requestJson(
      `/api/v1/services/${
        encodeURIComponent(service)
      }/capacity`,
    ),
  );

  return {
    service: asString(
      response.service,
      service,
    ),

    adaptive_capacity:
      asBoolean(
        response.adaptive_capacity,
        true,
      ),

    manual_input_required:
      asBoolean(
        response.manual_input_required,
        false,
      ),

    estimate: normalizeCapacity(
      response.estimate,
    ),
  };
}

export function buildTrafficSeries(
  metrics: MetricSample[],
  decision?: ScalingDecision,
  learnedCapacityPerReplica?:
    number | null,
): TrafficPoint[] {
  const recent =
    metrics.slice(-30);

  if (!recent.length) {
    return [];
  }

  const learned =
    learnedCapacityPerReplica ?? 0;

  const perReplicaCapacity =
    Number.isFinite(learned) &&
    learned > 0
      ? learned
      : null;

  const points =
    recent.map<TrafficPoint>(
      (metric, index) => ({
        timestamp:
          metric.timestamp,

        actual:
          metric.requests_per_second,

        predicted:
          index === recent.length - 1
            ? metric.requests_per_second
            : null,

        capacity:
          perReplicaCapacity === null ? null : metric.current_replicas * perReplicaCapacity,
      }),
    );

  const finalMetric =
    recent.at(-1);

  if (decision && finalMetric) {
    points.push({
      timestamp: new Date(
        new Date(
          finalMetric.timestamp,
        ).getTime() +
          decision
            .prediction_horizon_seconds
            * 1_000,
      ).toISOString(),

      actual: null,

      predicted:
        decision.predicted_rps,

      capacity:
        perReplicaCapacity === null ? null : Math.max(
          1,
          decision.desired_replicas,
        ) * perReplicaCapacity,
    });
  }

  return points;
}
