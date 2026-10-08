import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";

export function cpuCountForQuota(cpuMax: string | undefined, parallelism: number): number {
  const available = Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 1;
  const parts = cpuMax?.trim().split(/\s+/);
  if (parts?.length !== 2 || !parts.every(part => /^\d+$/.test(part))) return available;
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  const count = quota / period;
  return Number.isFinite(count) && count > 0 && Number.isFinite(quota) && Number.isFinite(period)
    && quota > 0 && period > 0
    ? Math.min(available, count) : available;
}

export function readCpuCount(): number {
  let cpuMax: string | undefined;
  if (process.platform === "linux") {
    // ponytail: supports the Docker cgroup-v2 namespace root; add hierarchy/v1 discovery for other hosts.
    try { cpuMax = readFileSync("/sys/fs/cgroup/cpu.max", "utf8"); } catch { }
  }
  return cpuCountForQuota(cpuMax, availableParallelism());
}

export function memoryLimitForConstraint(constrained: number, host: number): number {
  return Number.isFinite(constrained) && constrained > 0
    ? Math.min(host, constrained) : host;
}

export function readMemoryLimit(): number {
  return memoryLimitForConstraint(process.constrainedMemory(), totalmem());
}
