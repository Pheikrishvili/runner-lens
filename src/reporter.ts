import type {
  MetricSample, SystemInfo,
  AggregatedReport, StepMetrics,
} from './types';
import { stats, safeMax } from './stats';
import { REPORT_VERSION } from './constants';

function aggregate(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  durationSec: number,
  steps?: StepMetrics[],
): AggregatedReport {
  if (samples.length === 0) {
    const now = new Date().toISOString();
    return {
      version: REPORT_VERSION,
      system: sysInfo,
      duration_seconds: durationSec,
      sample_count: 0,
      started_at: now,
      ended_at: now,
      cpu: { avg: 0, max: 0, min: 0, latest: 0 },
      memory: { avg: 0, max: 0, min: 0, latest: 0, total_mb: 0, swap_max_mb: 0 },
      load: { avg_1m: 0, max_1m: 0 },
    };
  }

  // Extract arrays once — reused for both stats and timeline.
  const cpuUsage = samples.map((s) => s.cpu.usage);
  const memUsed  = samples.map((s) => s.memory.used_mb);
  const swapUsed = samples.map((s) => s.memory.swap_used_mb);

  const cpuStats = stats(cpuUsage);
  const memStats = stats(memUsed);
  // Use the max reported total_mb across samples (guards against a
  // corrupted sample reporting 0).
  const memTotals = samples.map((s) => s.memory.total_mb).filter((v) => v > 0);
  const memTotal = memTotals.length > 0 ? safeMax(memTotals) : 0;
  const swapMax  = safeMax(swapUsed);

  const loadVals = samples.map((s) => s.load?.load1 ?? 0);
  const loadAvg  = loadVals.length > 0
    ? loadVals.reduce((a, b) => a + b, 0) / loadVals.length
    : 0;

  const last = samples[samples.length - 1];

  const timeline = samples.length >= 2 ? {
    cpu_pct: cpuUsage,
    cpu_user: samples.map(s => s.cpu.user),
    cpu_nice: samples.map(s => s.cpu.nice),
    cpu_system: samples.map(s => s.cpu.system),
    cpu_idle: samples.map(s => s.cpu.idle),
    cpu_iowait: samples.map(s => s.cpu.iowait),
    cpu_steal: samples.map(s => s.cpu.steal),
    mem_mb: memUsed,
    mem_available_mb: samples.map(s => s.memory.available_mb),
    mem_cached_mb: samples.map(s => s.memory.cached_mb),
    mem_swap_mb: swapUsed,
    mem_usage_pct: samples.map(s => s.memory.usage_pct),
    load_1m: loadVals,
    load_5m: samples.map(s => s.load?.load5 ?? 0),
    load_15m: samples.map(s => s.load?.load15 ?? 0),
  } : undefined;

  const report: AggregatedReport = {
    version: REPORT_VERSION,
    system: sysInfo,
    duration_seconds: durationSec,
    sample_count: samples.length,
    started_at: new Date(samples[0].timestamp * 1000).toISOString(),
    ended_at:   new Date(last.timestamp * 1000).toISOString(),
    cpu: cpuStats,
    memory: { ...memStats, total_mb: memTotal, swap_max_mb: swapMax },
    load: {
      avg_1m: loadAvg,
      max_1m: safeMax(loadVals),
    },
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(timeline ? { timeline } : {}),
  };

  return report;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export function processMetrics(
  samples: MetricSample[],
  sysInfo: SystemInfo,
  durationSec: number,
  steps?: StepMetrics[],
): {
  report: AggregatedReport;
} {
  const report = aggregate(samples, sysInfo, durationSec, steps);
  return { report };
}
