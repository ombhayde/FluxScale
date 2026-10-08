import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  BrainCircuit,
  Clock3,
  Cpu,
  Database,
  Gauge,
  Eye,
  EyeOff,
  Search,
  KeyRound,
  LogOut,
  MemoryStick,
  Radio,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  Zap,
  type FluxIcon,
} from "@/components/brand/flux-icons";

import Loader from "@/components/kokonutui/loader";
import { FluxScaleMark } from "@/components/brand/fluxscale-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  buildTrafficSeries,
  fetchDashboardOverview,
  fetchControlPlaneHealth,
  fetchOperationsAudit,
  fetchServiceInstances,
  fetchServiceMetrics,
  isDashboardAuthenticationError,
  verifyDashboardReadToken,
  type FluxScaleApiError,
  type OperationalAuditEvent,
  type DashboardService,
  type ScalingAction,
  type ServiceStatus,
  type TrafficPoint,
} from "@/lib/api";
import {
  clearDashboardReadToken,
  hasDashboardReadToken,
  saveDashboardReadToken,
  validateDashboardReadToken,
} from "@/lib/auth";
import { cn } from "@/lib/utils";
import "@/styles/fluxscale-console.css";


const EMPTY_SUMMARY = {
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

interface KpiCardProps {
  label: string;
  value: string;
  detail: string;
  icon: FluxIcon;
  accentClass: string;
  index: number;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${formatNumber(value, 1)}%`;
}

function capacityPhaseLabel(
  phase: DashboardService["capacity"]["phase"],
): string {
  switch (phase) {
    case "warming_up":
      return "Warming up";
    case "learning":
      return "Learning";
    case "saturation_observed":
      return "Calibrated";
  }
}

function CapacityPhaseBadge({
  phase,
}: {
  phase: DashboardService["capacity"]["phase"];
}) {
  const styles = {
    warming_up: "border-amber-400/20 bg-amber-400/10 text-amber-700",
    learning: "border-cyan-400/20 bg-cyan-400/10 text-cyan-700",
    saturation_observed:
      "border-emerald-400/20 bg-emerald-400/10 text-emerald-700",
  };

  return (
    <Badge variant="outline" className={cn("gap-2", styles[phase])}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          phase === "warming_up" && "animate-pulse bg-amber-400",
          phase === "learning" && "animate-pulse bg-cyan-400",
          phase === "saturation_observed" && "bg-emerald-400",
        )}
      />
      {capacityPhaseLabel(phase)}
    </Badge>
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function formatSampleAge(value: string): string {
  const timestamp = new Date(value).getTime();

  if (!Number.isFinite(timestamp)) {
    return "Unknown";
  }

  const seconds = Math.max(
    0,
    Math.round((Date.now() - timestamp) / 1_000),
  );

  if (seconds < 2) {
    return "Just now";
  }

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  return `${Math.floor(seconds / 60)}m ago`;
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) {
    return `${formatNumber(seconds / 86_400, 0)} days`;
  }

  if (seconds >= 3_600) {
    return `${formatNumber(seconds / 3_600, 0)} hours`;
  }

  if (seconds >= 60) {
    return `${formatNumber(seconds / 60, 0)} minutes`;
  }

  return `${formatNumber(seconds)} seconds`;
}

function statusLabel(status: ServiceStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Degraded";
    case "critical":
      return "Critical";
    case "scaling":
      return "Scaling";
  }
}

function StatusBadge({ status }: { status: ServiceStatus }) {
  const styles: Record<ServiceStatus, string> = {
    healthy:
      "border-emerald-400/20 bg-emerald-400/10 text-emerald-700",
    degraded:
      "border-amber-400/20 bg-amber-400/10 text-amber-700",
    critical: "border-red-400/20 bg-red-400/10 text-red-700",
    scaling:
      "border-emerald-400/20 bg-emerald-400/10 text-emerald-700",
  };

  const dots: Record<ServiceStatus, string> = {
    healthy: "bg-emerald-400",
    degraded: "bg-amber-400",
    critical: "bg-red-400",
    scaling: "animate-pulse bg-emerald-400",
  };

  return (
    <Badge
      variant="outline"
      className={cn("gap-2 font-medium", styles[status])}
    >
      <span className={cn("size-1.5 rounded-full", dots[status])} />
      {statusLabel(status)}
    </Badge>
  );
}

function ActionBadge({ action }: { action: ScalingAction }) {
  if (action === "scale_up") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-400/20 bg-emerald-400/10 text-emerald-700"
      >
        <ArrowUpRight className="size-3" />
        Scale up
      </Badge>
    );
  }

  if (action === "scale_down") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-cyan-400/20 bg-cyan-400/10 text-cyan-700"
      >
        <ArrowDownRight className="size-3" />
        Scale down
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-stone-200 bg-stone-100 text-muted-foreground"
    >
      Hold
    </Badge>
  );
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  accentClass,
  index,
}: KpiCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.45,
        delay: index * 0.06,
        ease: "easeOut",
      }}
      className="console-metric group"
    >
      <div className={cn("console-metric__signal", accentClass)} />
      <div className="flex items-center gap-3">
        <div className="console-metric__icon">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="console-eyebrow">{label}</p>
          <p className="console-metric__value mt-1 truncate">
            {value}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-stone-500">{detail}</p>
        </div>
      </div>
    </motion.div>
  );
}

function DashboardError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="fluxscale-light flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg border-red-200 bg-white shadow-xl shadow-slate-200/60">
        <CardHeader>
          <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-red-400/10">
            <TriangleAlert className="size-5 text-red-700" />
          </div>

          <CardTitle>FluxScale API is unreachable</CardTitle>

          <CardDescription>
            Start the Rust backend on port 8080 and reconnect the
            dashboard.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <pre className="mb-5 overflow-auto rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-red-700">
            {message}
          </pre>

          <Button onClick={onRetry}>
            <RefreshCw className="size-4" />
            Retry connection
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function AuditOutcome({ event }: { event: OperationalAuditEvent }) {
  const isError = event.status >= 400;

  return (
    <Badge
      variant="outline"
      className={cn(
        "min-w-14 justify-center font-mono",
        event.rate_limited
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : isError
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700",
      )}
    >
      {event.status}
    </Badge>
  );
}

function LightTrafficChart({
  data,
  loading,
}: {
  data: TrafficPoint[];
  loading: boolean;
}) {
  const width = 920;
  const height = 310;
  const inset = { top: 22, right: 18, bottom: 34, left: 52 };
  const chartWidth = width - inset.left - inset.right;
  const chartHeight = height - inset.top - inset.bottom;
  const maximum = Math.max(
    1,
    ...data.flatMap((point) => [
      point.actual ?? 0,
      point.predicted ?? 0,
      point.capacity ?? 0,
    ]),
  );

  function x(index: number): number {
    return inset.left + (index / Math.max(1, data.length - 1)) * chartWidth;
  }

  function y(value: number): number {
    return inset.top + chartHeight - (value / maximum) * chartHeight;
  }

  function pathFor(key: "actual" | "predicted" | "capacity"): string {
    let drawing = false;

    return data
      .map((point, index) => {
        const value = point[key];

        if (value === null) {
          drawing = false;
          return "";
        }

        const command = drawing ? "L" : "M";
        drawing = true;
        return `${command}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
  }

  const latestActual = [...data].reverse().find((point) => point.actual !== null)?.actual ?? 0;
  const latestPredicted = [...data].reverse().find((point) => point.predicted !== null)?.predicted ?? 0;
  const ticks = [1, 0.75, 0.5, 0.25, 0];

  if (!data.length && !loading) {
    return (
      <div className="flex min-h-72 items-center justify-center rounded-xl border border-dashed border-stone-200 bg-stone-50 text-sm text-stone-500">
        Waiting for traffic samples.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
        <div className="flex items-center gap-5 text-xs text-stone-500">
          <span><strong className="text-stone-900">{formatCompact(latestActual)}</strong> actual RPS</span>
          <span><strong className="text-cyan-700">{formatCompact(latestPredicted)}</strong> predicted RPS</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-stone-500">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-emerald-600" />Actual</span>
          <span className="flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-cyan-500" />Forecast</span>
          <span className="flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-amber-500" />Estimated capacity</span>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block min-h-72 w-full"
        role="img"
        aria-label="Actual traffic, predicted traffic and available replica capacity"
      >
        <defs>
          <linearGradient id="traffic-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#397252" stopOpacity="0.18" />
            <stop offset="1" stopColor="#397252" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const tickY = inset.top + (1 - tick) * chartHeight;
          return (
            <g key={tick}>
              <line x1={inset.left} x2={width - inset.right} y1={tickY} y2={tickY} stroke="#e5e7dd" />
              <text x={inset.left - 12} y={tickY + 4} textAnchor="end" fontSize="11" fill="#7a8376">
                {formatCompact(maximum * tick)}
              </text>
            </g>
          );
        })}

        <motion.path
          key={`capacity-${data.length}`}
          d={pathFor("capacity")}
          fill="none"
          stroke="#d99a16"
          strokeWidth="1.5"
          strokeDasharray="5 6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.9 }}
          transition={{ duration: 0.35 }}
        />
        <motion.path
          key={`actual-${data.length}`}
          d={pathFor("actual")}
          fill="none"
          stroke="#397252"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
        <motion.path
          key={`predicted-${data.length}`}
          d={pathFor("predicted")}
          fill="none"
          stroke="#557f93"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="7 6"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 0.9, delay: 0.12, ease: "easeOut" }}
        />

        {data.length > 0 && (
          <>
            <text x={inset.left} y={height - 10} fontSize="11" fill="#7a8376">
              {formatTimestamp(data[0].timestamp)}
            </text>
            <text x={width - inset.right} y={height - 10} textAnchor="end" fontSize="11" fill="#7a8376">
              {formatTimestamp(data[data.length - 1].timestamp)}
            </text>
          </>
        )}
      </svg>

      {loading && (
        <div className="absolute inset-0 grid place-items-center bg-white/70 backdrop-blur-sm">
          <span className="flex items-center gap-2 text-sm font-medium text-stone-600">
            <RefreshCw className="size-4 animate-spin text-emerald-600" />
            Updating forecast
          </span>
        </div>
      )}
    </div>
  );
}

function DashboardAuthentication({
  message,
  onAuthenticate,
}: {
  message: string;
  onAuthenticate: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    try {
      const validated = validateDashboardReadToken(token);
      setSubmitting(true);
      await onAuthenticate(validated);
      setToken("");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The read token could not be verified.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fluxscale-light relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6 text-foreground">
      <div className="fluxscale-grid pointer-events-none absolute inset-0 opacity-70" />

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="relative w-full max-w-md"
      >
        <Card className="border-stone-200 bg-white/95 shadow-2xl shadow-slate-300/40 backdrop-blur-xl">
          <CardHeader>
            <div className="mb-4 flex items-center justify-between">
              <FluxScaleMark className="size-12 shadow-md" />

              <Badge
                variant="outline"
                className="border-emerald-400/20 bg-emerald-400/10 text-emerald-700"
              >
                Secure control plane
              </Badge>
            </div>

            <CardTitle className="text-xl">Authenticate dashboard</CardTitle>
            <CardDescription className="leading-6">
              Enter the FluxScale read token to access services, capacity
              learning and scaling decisions.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="fluxscale-read-token"
                  className="mb-2 block text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground"
                >
                  Read token
                </label>

                <div className="relative">
                  <input
                    id="fluxscale-read-token"
                    type={visible ? "text" : "password"}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={submitting}
                    placeholder="Paste FLUXSCALE_READ_TOKEN"
                    className="h-11 w-full rounded-xl border border-stone-200 bg-white px-3 pr-11 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-emerald-400 focus:ring-4 focus:ring-emerald-100 disabled:opacity-60"
                  />

                  <button
                    type="button"
                    onClick={() => setVisible((current) => !current)}
                    aria-label={visible ? "Hide read token" : "Show read token"}
                    className="absolute right-1.5 top-1.5 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-stone-100 hover:text-foreground"
                  >
                    {visible ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex gap-2 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2.5 text-xs leading-5 text-red-700">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {!error && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {message} The token is kept only for this browser tab and is
                  never written to FluxScale durable state.
                </p>
              )}

              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : (
                  <ShieldCheck className="size-4" />
                )}
                {submitting ? "Verifying token" : "Unlock dashboard"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

export default function App() {
  const connectedConsole = /^\/projects\/[A-Za-z0-9_-]{43}\/console\/?$/.test(window.location.pathname);
  const [requestedService, setSelectedService] = useState("");
  const [auditFilter, setAuditFilter] = useState<"all" | "limited" | "errors">("all");
  const [workspaceView, setWorkspaceView] = useState<
    "fleet" | "capacity" | "workloads" | "operations"
  >("fleet");
  const [activeRail, setActiveRail] = useState<
    "overview" | "fleet" | "capacity" | "workloads" | "operations"
  >("overview");
  const [authRevision, setAuthRevision] = useState(0);
  const [authRequired, setAuthRequired] = useState(false);
  const queryClient = useQueryClient();

  const healthQuery = useQuery({
    queryKey: ["control-plane-health", authRevision],
    queryFn: fetchControlPlaneHealth,
    retry: false,
    staleTime: 15_000,
  });

  const overviewQuery = useQuery({
    queryKey: ["dashboard-overview", authRevision],
    queryFn: fetchDashboardOverview,
    enabled: !authRequired,
    retry: (attempt, error) =>
      !isDashboardAuthenticationError(error) && attempt < 2,
  });

  const services = overviewQuery.data?.services ?? [];
  const recentDecisions =
    overviewQuery.data?.recent_decisions ?? [];
  const persistence = overviewQuery.data?.persistence;

  const selectedService = services.some(service => service.service === requestedService)
    ? requestedService : services[0]?.service ?? "";

  const metricsQuery = useQuery({
    queryKey: ["service-metrics", selectedService, authRevision],
    queryFn: () => fetchServiceMetrics(selectedService),
    enabled: selectedService.length > 0 && !authRequired,
    retry: (attempt, error) =>
      !isDashboardAuthenticationError(error) && attempt < 1,
  });

  const instancesQuery = useQuery({
    queryKey: ["service-instances", selectedService, authRevision],
    queryFn: () => fetchServiceInstances(selectedService),
    enabled: selectedService.length > 0 && !authRequired,
    refetchInterval: 2_000,
    retry: (attempt, error) =>
      !isDashboardAuthenticationError(error) && attempt < 1,
  });

  const auditSupported =
    healthQuery.data?.capabilities?.audit === true;

  const auditQuery = useQuery({
    queryKey: ["operations-audit", authRevision],
    queryFn: fetchOperationsAudit,
    enabled: auditSupported && !authRequired,
    refetchInterval: 5_000,
    retry: (attempt, error) =>
      !isDashboardAuthenticationError(error) && attempt < 1,
  });

  const authenticationError = [
    healthQuery.error,
    overviewQuery.error,
    metricsQuery.error,
    instancesQuery.error,
    auditQuery.error,
  ].find(isDashboardAuthenticationError) as FluxScaleApiError | undefined;

  const secureSessionNeedsToken =
    !connectedConsole &&
    healthQuery.data?.security.enabled === true &&
    !hasDashboardReadToken();

  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    if (event.type !== "updated" || event.action.type !== "error"
      || !isDashboardAuthenticationError(event.action.error)) return;
    clearDashboardReadToken();
    setAuthRequired(true);
    queryClient.removeQueries({ queryKey: ["dashboard-overview"] });
    queryClient.removeQueries({ queryKey: ["service-metrics"] });
    queryClient.removeQueries({ queryKey: ["service-instances"] });
    queryClient.removeQueries({ queryKey: ["operations-audit"] });
  }), [queryClient]);

  const selectedServiceData = services.find(
    (service) => service.service === selectedService,
  );

  const fleetInstances = instancesQuery.data?.instances ?? [];
  const freshInstances = fleetInstances.filter(
    (instance) => instance.fresh,
  );

  const auditEvents = useMemo(() => auditQuery.data?.events ?? [], [auditQuery.data]);
  const visibleAuditEvents = useMemo(() => {
    if (auditFilter === "limited") {
      return auditEvents.filter((event) => event.rate_limited);
    }

    if (auditFilter === "errors") {
      return auditEvents.filter((event) => event.status >= 400);
    }

    return auditEvents;
  }, [auditEvents, auditFilter]);

  const selectedDecision = recentDecisions.find(
    (decision) => decision.service === selectedService,
  );

  const trafficData = useMemo(() => buildTrafficSeries(
    metricsQuery.data ?? [],
    selectedDecision,
    selectedServiceData?.capacity.phase === "saturation_observed"
      ? selectedServiceData.capacity.safe_rps_per_replica : null,
  ), [metricsQuery.data, selectedDecision, selectedServiceData]);

  const summary = overviewQuery.data?.summary ?? EMPTY_SUMMARY;

  const predictedGrowth =
    selectedServiceData &&
    selectedServiceData.requests_per_second > 0
      ? ((selectedServiceData.predicted_rps -
          selectedServiceData.requests_per_second) /
          selectedServiceData.requests_per_second) *
        100
      : 0;

  const currentCapacity = selectedServiceData?.capacity.phase === "saturation_observed"
    && selectedServiceData.capacity.safe_rps_per_replica !== null
    ? selectedServiceData.current_replicas * selectedServiceData.capacity.safe_rps_per_replica
    : null;

  const capacityUtilization =
    selectedServiceData && currentCapacity !== null && currentCapacity > 0
      ? Math.min(
          100,
          (selectedServiceData.requests_per_second /
            currentCapacity) *
            100,
        )
      : 0;

  const refreshInProgress =
    overviewQuery.isFetching ||
    metricsQuery.isFetching ||
    instancesQuery.isFetching ||
    auditQuery.isFetching;

  function refreshDashboard() {
    void healthQuery.refetch();
    void overviewQuery.refetch();

    if (selectedService) {
      void metricsQuery.refetch();
      void instancesQuery.refetch();
    }

    if (auditSupported) {
      void auditQuery.refetch();
    }
  }

  async function authenticateDashboard(token: string) {
    await verifyDashboardReadToken(token);
    saveDashboardReadToken(token);
    setAuthRequired(false);
    setSelectedService("");
    queryClient.removeQueries({ queryKey: ["dashboard-overview"] });
    queryClient.removeQueries({ queryKey: ["service-metrics"] });
    queryClient.removeQueries({ queryKey: ["service-instances"] });
    queryClient.removeQueries({ queryKey: ["operations-audit"] });
    setAuthRevision((revision) => revision + 1);
  }

  function logoutDashboard() {
    clearDashboardReadToken();
    setAuthRequired(true);
    setSelectedService("");
    queryClient.removeQueries({ queryKey: ["dashboard-overview"] });
    queryClient.removeQueries({ queryKey: ["service-metrics"] });
    queryClient.removeQueries({ queryKey: ["service-instances"] });
    queryClient.removeQueries({ queryKey: ["operations-audit"] });
    setAuthRevision((revision) => revision + 1);
  }

  if (authRequired || authenticationError || secureSessionNeedsToken) {
    return (
      <TooltipProvider>
        <DashboardAuthentication
          message={
            authenticationError?.status === 403
              ? "The supplied credential does not have dashboard read permission."
              : "This FluxScale control plane requires authentication."
          }
          onAuthenticate={authenticateDashboard}
        />
      </TooltipProvider>
    );
  }

  if (overviewQuery.isPending) {
    return (
      <TooltipProvider>
        <div className="fluxscale-light flex min-h-screen items-center justify-center bg-background">
          <Loader
            title="Connecting to FluxScale"
            subtitle="Loading live services, metrics and scaling decisions"
            size="md"
          />
        </div>
      </TooltipProvider>
    );
  }

  if (overviewQuery.isError && !overviewQuery.data) {
    return (
      <TooltipProvider>
        <DashboardError
          message={
            overviewQuery.error instanceof Error
              ? overviewQuery.error.message
              : "Unknown API connection error"
          }
          onRetry={() => {
            void overviewQuery.refetch();
          }}
        />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <div className="fluxscale-console min-h-screen">
        <aside className="console-rail">
          <div className="console-rail__brand">
            <FluxScaleMark className="shadow-sm" />
            <div className="console-rail__brand-copy">
              <strong>FluxScale</strong>
              <span>Control plane</span>
            </div>
          </div>

          <nav className="console-rail__nav" aria-label="Control plane navigation">
            {([
              ["overview", "Overview", Activity],
              ["fleet", "Fleet", Radio],
              ["capacity", "Capacity", Gauge],
                    ["workloads", "Workloads", Cpu],
              ["operations", "Operations", ShieldCheck],
            ] as const).map(([view, label, Icon]) => {
              const active = activeRail === view;

              return (
                <button
                  key={view}
                  type="button"
                  className={cn("console-rail__nav-item", active && "is-active")}
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  onClick={() => {
                    setActiveRail(view);
                    if (view === "overview") {
                      setWorkspaceView("fleet");
                      document.getElementById("console-overview")?.scrollIntoView({ behavior: "smooth" });
                    } else {
                      setWorkspaceView(view);
                      document.getElementById("console-workbench")?.scrollIntoView({ behavior: "smooth" });
                    }
                  }}
                >
                  {active && (
                    <motion.span
                      layoutId="console-active-nav"
                      className="console-rail__active"
                      transition={{ type: "spring", stiffness: 430, damping: 34 }}
                    />
                  )}
                  <Icon className="relative z-10 size-[18px]" />
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="console-rail__footer">
            <div className="console-rail__pulse" aria-hidden="true">
              <span />
              <span />
            </div>
            <div>
              <strong>{persistence?.status === "degraded" ? "State degraded" : "State protected"}</strong>
              <span>{persistence?.last_successful_save_at ? `Saved ${formatSampleAge(persistence.last_successful_save_at)}` : "Checkpoint pending"}</span>
            </div>
          </div>
        </aside>

        <div className="console-stage">
          <header className="console-commandbar">
            <div className="min-w-0">
              <p className="console-commandbar__context">Workspace / {healthQuery.data?.workspace ?? 'Self-hosted'}</p>
              <div className="flex items-center gap-2">
                <h1>Deployment console</h1>
                <span className="console-release">{healthQuery.data?.version ?? "Connecting"}</span>
              </div>
            </div>

            <div className="console-commandbar__controls">
              <label className="console-service-picker">
                <span>Service</span>
                <select
                  value={selectedService}
                  onChange={(event) => setSelectedService(event.target.value)}
                  disabled={!services.length}
                  aria-label="Select service"
                >
                  {!services.length && <option value="">Waiting for telemetry</option>}
                  {services.map((service) => (
                    <option key={service.service} value={service.service}>{service.service}</option>
                  ))}
                </select>
              </label>

              <div className="console-live-status">
                <span className={cn("console-live-dot", overviewQuery.isError && "is-warning")} />
                <span>{overviewQuery.isError ? "Last known state" : "Live"}</span>
                <span className="hidden text-stone-400 sm:inline">· {formatTimestamp(overviewQuery.data?.generated_at ?? new Date().toISOString())}</span>
              </div>

              {connectedConsole && <a href="/connected" className="console-refresh">Your projects</a>}
              {!connectedConsole && healthQuery.data?.security.enabled && (
                <Button variant="outline" size="sm" onClick={logoutDashboard} className="console-icon-button">
                  <LogOut className="size-4" />
                  <span className="sr-only">Lock dashboard</span>
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={refreshDashboard}
                disabled={refreshInProgress}
                className="console-refresh"
              >
                <RefreshCw className={cn("size-4", refreshInProgress && "animate-spin")} />
                <span className="hidden sm:inline">Sync now</span>
              </Button>
            </div>
          </header>

          <main className="console-main">
            {overviewQuery.isError && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className="console-warning"
              >
                <TriangleAlert className="size-4 shrink-0" />
                Live refresh failed. Showing the most recently received telemetry.
              </motion.div>
            )}

            <section id="console-overview" className="scroll-mt-24">
              <div className="console-section-heading">
                <div>
                  <p className="console-eyebrow">Observe. Anticipate. Adjust.</p>
                  <h2>Capacity, in motion<span className="console-heading-dot">.</span></h2>
                  <p className="console-heading-description">A clear view of demand and the infrastructure that meets it.</p>
                </div>
                <div className="console-section-heading__meta">
                  <ShieldCheck className="size-4 text-emerald-600" />
                  {healthQuery.data?.security.enabled ? "Authenticated session" : "Local control plane"}
                </div>
              </div>

              <div className="console-metric-strip">
                <KpiCard
                  label="Traffic"
                  value={`${formatCompact(summary.total_requests_per_second)} RPS`}
                  detail={`${summary.services} services reporting`}
                  icon={Gauge}
                  accentClass="bg-emerald-500"
                  index={0}
                />
                <KpiCard
                  label="Service health"
                  value={`${summary.healthy_services}/${summary.services}`}
                  detail={`${summary.degraded_services} degraded · ${summary.critical_services} critical`}
                  icon={ShieldCheck}
                  accentClass="bg-emerald-500"
                  index={1}
                />
                <KpiCard
                  label="Mean service max P95"
                  value={`${formatNumber(summary.average_p95_latency_ms)} ms`}
                  detail="Across fresh instances"
                  icon={Activity}
                  accentClass="bg-cyan-500"
                  index={2}
                />
                <KpiCard
                  label="Backends"
                  value={formatNumber(summary.healthy_backends)}
                  detail={`${summary.scaling_services} services scaling`}
                  icon={Server}
                  accentClass="bg-emerald-500"
                  index={3}
                />
              </div>

              <div className="console-primary-grid">
                <motion.section
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.45, delay: 0.12 }}
                  className="console-panel console-forecast-panel"
                >
                  <div className="console-panel__header">
                    <div>
                      <p className="console-eyebrow">Demand model</p>
                      <h3>Traffic & capacity forecast</h3>
                    </div>
                    {selectedServiceData && <StatusBadge status={selectedServiceData.status} />}
                  </div>
                  <div className="console-panel__body">
                    <LightTrafficChart data={trafficData} loading={Boolean(selectedService) && metricsQuery.isPending} />
                  </div>
                </motion.section>

                <motion.aside
                  initial={{ opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.45, delay: 0.18 }}
                  className="console-decision"
                >
                  <div className="console-decision__top">
                    <div>
                      <p className="console-eyebrow text-emerald-200">Controller decision</p>
                      <h3>{selectedServiceData?.service ?? "Awaiting a service"}</h3>
                    </div>
                    {selectedServiceData && <ActionBadge action={selectedServiceData.action} />}
                  </div>

                  {selectedServiceData ? (
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={`${selectedServiceData.service}-${selectedServiceData.updated_at}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.25 }}
                        className="console-decision__content"
                      >
                        <div className="console-demand-comparison">
                          <div>
                            <span>Now</span>
                            <strong>{formatCompact(selectedServiceData.requests_per_second)}</strong>
                            <small>RPS</small>
                          </div>
                          <ArrowUpRight className={cn("size-5", predictedGrowth < 0 && "rotate-90")} />
                          <div>
                            <span>+10s forecast</span>
                            <strong>{formatCompact(selectedServiceData.predicted_rps)}</strong>
                            <small>RPS</small>
                          </div>
                        </div>

                        <div className="console-capacity-meter">
                          <div>
                            <span>Capacity in use</span>
                            <strong>{currentCapacity === null ? "Learning" : formatPercent(capacityUtilization)}</strong>
                          </div>
                          <div className="console-capacity-meter__track">
                            <motion.span
                              initial={{ width: 0 }}
                              animate={{ width: `${capacityUtilization}%` }}
                              transition={{ type: "spring", stiffness: 120, damping: 24 }}
                              className={cn(capacityUtilization >= 90 && "is-danger", capacityUtilization >= 75 && capacityUtilization < 90 && "is-warning")}
                            />
                          </div>
                        </div>

                        <div className="console-decision__stats">
                          <div><Boxes /><span>Replicas</span><strong>{selectedServiceData.current_replicas} → {selectedServiceData.desired_replicas}</strong></div>
                          <div><Activity /><span>Max instance P95</span><strong>{formatNumber(selectedServiceData.p95_latency_ms)} ms</strong></div>
                          <div><Cpu /><span>CPU</span><strong>{formatPercent(selectedServiceData.cpu_percent)}</strong></div>
                          <div><MemoryStick /><span>Memory</span><strong>{formatPercent(selectedServiceData.memory_percent)}</strong></div>
                        </div>

                        {selectedDecision?.reasons[0] && (
                          <div className="console-decision__reason">
                            <BrainCircuit className="size-4 shrink-0" />
                            <p>{selectedDecision.reasons[0]}</p>
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  ) : (
                    <div className="console-decision__empty">
                      <Radio className="size-7" />
                      <p>Send telemetry to start forecasting.</p>
                    </div>
                  )}
                </motion.aside>
              </div>
            </section>

            <section id="console-workbench" className="console-workbench scroll-mt-24">
              <div className="console-workbench__bar">
                <div>
                  <p className="console-eyebrow">Inspection workbench</p>
                  <h3>Service intelligence</h3>
                </div>
                <div className="console-tabs" role="tablist" aria-label="Service intelligence views">
                  {([
                    ["fleet", "Fleet", Radio],
                    ["capacity", "Capacity", Gauge],
                    ["workloads", "Workloads", Cpu],
                    ["operations", "Operations", ShieldCheck],
                  ] as const).map(([view, label, Icon]) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={workspaceView === view}
                      onClick={() => {
                        setWorkspaceView(view);
                        setActiveRail(view);
                      }}
                      className={cn("console-tab", workspaceView === view && "is-active")}
                    >
                      {workspaceView === view && <motion.span layoutId="console-active-tab" className="console-tab__active" />}
                      <Icon className="relative z-10 size-4" />
                      <span className="relative z-10">{label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={workspaceView}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                  className="console-workbench__content"
                >
                  {workspaceView === "fleet" && (
                    <div>
                      <div className="console-subhead">
                        <div>
                          <h4>Live process fleet</h4>
                          <p>Fresh per-process telemetry for {selectedService || "the selected service"}.</p>
                        </div>
                        {selectedService && (
                          <span className={cn("console-health-pill", freshInstances.length === 0 && "is-warning")}>
                            <span /> {freshInstances.length}/{fleetInstances.length} online
                          </span>
                        )}
                      </div>
                      <div className="console-table-wrap">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Instance</TableHead><TableHead>Status</TableHead><TableHead>Traffic</TableHead><TableHead>P95</TableHead><TableHead>CPU</TableHead><TableHead>Memory</TableHead><TableHead>Active</TableHead><TableHead className="text-right">Last sample</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {instancesQuery.isPending && selectedService ? (
                              <TableRow><TableCell colSpan={8} className="h-28 text-center text-stone-500">Loading fleet telemetry…</TableCell></TableRow>
                            ) : fleetInstances.length === 0 ? (
                              <TableRow><TableCell colSpan={8} className="h-28 text-center text-stone-500">{selectedService ? "No process identity has reported yet." : "Select a service to inspect its fleet."}</TableCell></TableRow>
                            ) : fleetInstances.map((instance, index) => (
                              <motion.tr
                                key={instance.instance_id}
                                initial={{ opacity: 0, y: 5 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: Math.min(index, 8) * 0.035 }}
                                className={cn("border-b transition-colors hover:bg-stone-50", !instance.fresh && "bg-amber-50/50")}
                              >
                                <TableCell className="max-w-64 font-mono text-xs"><span className="block truncate" title={instance.instance_id}>{instance.instance_id}</span></TableCell>
                                <TableCell><span className={cn("console-health-pill", !instance.fresh && "is-warning")}><span />{instance.fresh ? "Online" : "Stale"}</span></TableCell>
                                <TableCell>{formatCompact(instance.last_sample.requests_per_second)} <small>RPS</small></TableCell>
                                <TableCell>{formatNumber(instance.last_sample.p95_latency_ms)} <small>ms</small></TableCell>
                                <TableCell>{formatPercent(instance.last_sample.cpu_percent)}</TableCell>
                                <TableCell>{formatPercent(instance.last_sample.memory_percent)}</TableCell>
                                <TableCell>{formatNumber(instance.last_sample.active_requests)}</TableCell>
                                <TableCell className="text-right text-xs text-stone-500">{formatSampleAge(instance.last_sample.timestamp)}</TableCell>
                              </motion.tr>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                      {instancesQuery.data && <p className="console-table-note">Freshness window {formatNumber(instancesQuery.data.instance_stale_after_seconds)}s · auto-sync every 2s</p>}
                    </div>
                  )}

                  {workspaceView === "capacity" && (
                    <div>
                      <div className="console-subhead">
                        <div><h4>Adaptive capacity model</h4><p>Learned throughput boundaries from real service behavior.</p></div>
                        {selectedServiceData && <CapacityPhaseBadge phase={selectedServiceData.capacity.phase} />}
                      </div>
                      {selectedServiceData ? (
                        <div className="console-capacity-layout">
                          <div className="console-capacity-score">
                            <div className="console-capacity-score__ring" style={{ "--confidence": `${Math.min(100, selectedServiceData.capacity.confidence_percent)}%` } as CSSProperties}>
                              <span>{formatNumber(selectedServiceData.capacity.confidence_percent)}%</span>
                              <small>confidence</small>
                            </div>
                            <div>
                              <p className="console-eyebrow">{selectedServiceData.capacity.phase === "saturation_observed" ? "Learned safe estimate" : "Provisional estimate"}</p>
                              <strong>{selectedServiceData.capacity.safe_rps_per_replica === null ? "Learning" : formatCompact(selectedServiceData.capacity.safe_rps_per_replica)}</strong>
                              <span>{selectedServiceData.capacity.safe_rps_per_replica === null ? "Collecting a healthy baseline" : "RPS per replica"}</span>
                            </div>
                          </div>
                          <div className="console-capacity-facts">
                            <div><span>Healthy peak</span><strong>{formatCompact(selectedServiceData.capacity.observed_peak_rps_per_replica)} RPS</strong></div>
                            <div><span>Saturation</span><strong>{selectedServiceData.capacity.saturation_rps_per_replica === null ? "Not observed" : `${formatCompact(selectedServiceData.capacity.saturation_rps_per_replica)} RPS`}</strong></div>
                            <div><span>Baseline P95</span><strong>{formatNumber(selectedServiceData.capacity.baseline_p95_latency_ms)} ms</strong></div>
                            <div><span>Learning set</span><strong>{selectedServiceData.capacity.healthy_samples} healthy / {selectedServiceData.capacity.stressed_samples} stressed</strong></div>
                          </div>
                        </div>
                      ) : <div className="console-empty"><Gauge /><p>Waiting for capacity samples.</p></div>}
                    </div>
                  )}

                  {workspaceView === "workloads" && (
                    <div>
                      <div className="console-subhead"><div><h4>Application workload analysis</h4><p>Completed operations across fresh instances. P95 is the largest instance P95.</p></div></div>
                      {selectedServiceData?.workloads.length ? <Table>
                        <TableHeader><TableRow><TableHead>Workload</TableHead><TableHead>Completed RPS</TableHead><TableHead>Max instance P95</TableHead><TableHead>Completed in windows</TableHead><TableHead>Failed in windows</TableHead></TableRow></TableHeader>
                        <TableBody>{selectedServiceData.workloads.map(w => <TableRow key={w.name}><TableCell>{w.name}</TableCell><TableCell>{formatNumber(w.requests_per_second)} RPS</TableCell><TableCell>{formatNumber(w.p95_latency_ms)} ms</TableCell><TableCell>{formatNumber(w.completed_requests)}</TableCell><TableCell>{formatNumber(w.failed_requests)}</TableCell></TableRow>)}</TableBody>
                      </Table> : <div className="console-empty"><Cpu/><p>Enable SDK workload labels to see operation traffic.</p></div>}
                    </div>
                  )}

                  {workspaceView === "operations" && (
                    <div>
                      <div className="console-subhead">
                        <div><h4>Control-plane activity</h4><p>Correlated requests, isolated limits and security outcomes.</p></div>
                        <div className="console-filter-row">
                          {(["all", "errors", "limited"] as const).map((filter) => (
                            <button key={filter} type="button" onClick={() => setAuditFilter(filter)} className={cn(auditFilter === filter && "is-active")}>
                              {filter === "all" ? `All ${auditEvents.length}` : filter === "errors" ? `Errors ${auditEvents.filter((event) => event.status >= 400).length}` : `Limited ${auditEvents.filter((event) => event.rate_limited).length}`}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="console-operation-strip">
                        <span><KeyRound />{healthQuery.data?.operations.request_id_header || "X-Request-Id"}</span>
                        <span><Gauge />{formatNumber(healthQuery.data?.operations.limits_per_minute.read ?? 0)} reads/min</span>
                        <span><Database />{formatNumber(auditQuery.data?.audit_capacity ?? healthQuery.data?.operations.audit_capacity ?? 0)} event buffer</span>
                      </div>
                      {auditQuery.isError ? (
                        <div className="console-warning"><TriangleAlert className="size-4" />Operational history could not be refreshed.</div>
                      ) : visibleAuditEvents.length ? (
                        <div className="console-table-wrap console-audit-table">
                          <Table>
                            <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Request</TableHead><TableHead>Route</TableHead><TableHead>Class</TableHead><TableHead>Latency</TableHead><TableHead className="text-right">Outcome</TableHead></TableRow></TableHeader>
                            <TableBody>
                              {visibleAuditEvents.slice(0, 10).map((event, index) => (
                                <motion.tr key={`${event.request_id}-${event.timestamp}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: index * 0.025 }} className="border-b hover:bg-stone-50">
                                  <TableCell className="text-xs text-stone-500">{formatTimestamp(event.timestamp)}</TableCell>
                                  <TableCell className="max-w-52 font-mono text-xs"><span className="block truncate" title={event.request_id}>{event.request_id}</span></TableCell>
                                  <TableCell className="max-w-80"><span className="mr-2 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px]">{event.method}</span><span className="font-mono text-xs">{event.path}</span></TableCell>
                                  <TableCell className="capitalize text-stone-600">{event.request_class}</TableCell>
                                  <TableCell className="font-mono text-xs">{event.latency_ms} ms</TableCell>
                                  <TableCell className="text-right"><AuditOutcome event={event} /></TableCell>
                                </motion.tr>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      ) : <div className="console-empty"><Search /><p>No matching operational events.</p></div>}
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </section>

            <section className="console-lower-grid">
              <div className="console-panel">
                <div className="console-panel__header">
                  <div><p className="console-eyebrow">Inventory</p><h3>Monitored services</h3></div>
                  <span className="console-count">{services.length}</span>
                </div>
                <div className="console-service-list">
                  {services.length ? services.slice(0, 8).map((service, index) => (
                    <motion.button
                      key={service.service}
                      type="button"
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.035 }}
                      onClick={() => setSelectedService(service.service)}
                      className={cn("console-service-row", selectedService === service.service && "is-selected")}
                    >
                      <span className={cn("console-service-row__status", `is-${service.status}`)} />
                      <span className="min-w-0 flex-1 text-left"><strong>{service.service}</strong><small>{formatCompact(service.requests_per_second)} RPS · {formatNumber(service.p95_latency_ms)} ms P95</small></span>
                      <span className="console-service-row__replicas">{service.current_replicas}<small>/{service.desired_replicas}</small></span>
                      <ActionBadge action={service.action} />
                    </motion.button>
                  )) : <div className="console-empty compact"><Server /><p>No telemetry received yet.</p></div>}
                </div>
              </div>

              <div className="console-panel">
                <div className="console-panel__header">
                  <div><p className="console-eyebrow">Decision stream</p><h3>Recent controller actions</h3></div>
                  <Zap className="size-5 text-amber-500" />
                </div>
                <div className="console-decision-list">
                  {recentDecisions.length ? recentDecisions.slice(0, 6).map((decision, index) => (
                    <motion.div key={decision.id} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.04 }} className="console-decision-row">
                      <span className={cn("console-decision-row__line", decision.action === "scale_up" && "is-up", decision.action === "scale_down" && "is-down")} />
                      <div className="min-w-0 flex-1"><strong>{decision.service}</strong><small>{decision.reasons[0] || "Replica target held"}</small></div>
                      <div className="text-right"><span>{decision.current_replicas} → {decision.desired_replicas}</span><small>{formatSampleAge(decision.timestamp)}</small></div>
                    </motion.div>
                  )) : <div className="console-empty compact"><Zap /><p>No decisions recorded.</p></div>}
                </div>
              </div>
            </section>

            <section className="console-durability-strip">
              <div><Database /><span>Durability</span><strong>{persistence?.status === "degraded" ? "Degraded" : "Protected"}</strong></div>
              <div><Clock3 /><span>Last checkpoint</span><strong>{persistence?.last_successful_save_at ? formatSampleAge(persistence.last_successful_save_at) : "Pending"}</strong></div>
              <div><ShieldCheck /><span>Retention</span><strong>{formatDuration(persistence?.stale_service_ttl_seconds ?? 0)}</strong></div>
              <div><Trash2 /><span>Profiles removed</span><strong>{formatNumber(persistence?.services_removed_total ?? 0)}</strong></div>
            </section>

            <footer className="console-footer">
              <span>FluxScale {healthQuery.data?.version ?? "Connecting"}</span>
              <span>Rust control plane · adaptive learning · secure ingest</span>
            </footer>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
