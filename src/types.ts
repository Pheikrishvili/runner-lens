// ─────────────────────────────────────────────────────────────
// RunnerLens — Type Definitions
// ─────────────────────────────────────────────────────────────

export interface CpuSample {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  steal: number;
  usage: number;
}

export interface MemorySample {
  total_mb: number;
  used_mb: number;
  available_mb: number;
  cached_mb: number;
  swap_total_mb: number;
  swap_used_mb: number;
  usage_pct: number;
}

export interface LoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

export interface CollectorSample {
  cpu_pct: number;
  mem_mb: number;
}

export interface MetricSample {
  timestamp: number;
  cpu: CpuSample;
  memory: MemorySample;
  load: LoadAverage;
  collector?: CollectorSample;
}

export interface SystemInfo {
  cpu_count: number;
  cpu_model: string;
  total_memory_mb: number;
  os_release: string;
  kernel: string;
  runner_name: string;
  runner_os: string;
  runner_arch: string;
  metric_source?: string;
}

export interface MonitorConfig {
  sampleInterval: number;
  maxSizeMb: number;
  githubToken: string;
}

export interface MetricStats {
  avg: number;
  max: number;
  min: number;
  latest: number;
}

export interface StepMetrics {
  name: string;
  number: number;
  duration_seconds: number;
  cpu_avg: number;
  cpu_max: number;
  mem_avg_mb: number;
  mem_max_mb: number;
  sample_count: number;
  started_at: string;
  completed_at: string;
}

export interface AggregatedReport {
  version: string;
  system: SystemInfo;
  duration_seconds: number;
  sample_count: number;
  started_at: string;
  ended_at: string;

  cpu: MetricStats;
  memory: MetricStats & { total_mb: number; swap_max_mb: number };

  load: { avg_1m: number; max_1m: number };
  steps?: StepMetrics[];
  timeline?: {
    cpu_pct: number[];    // total CPU usage %, 0-100
    cpu_user: number[];   // user CPU %
    cpu_nice: number[];   // nice CPU %
    cpu_system: number[]; // system CPU %
    cpu_idle: number[];   // idle CPU %
    cpu_iowait: number[]; // I/O wait CPU %
    cpu_steal: number[];  // hypervisor steal CPU %
    mem_mb: number[];         // memory usage in MB
    mem_available_mb: number[]; // available memory in MB
    mem_cached_mb: number[];  // filesystem cache in MB
    mem_swap_mb: number[];    // swap usage in MB
    mem_usage_pct: number[];  // memory usage %, 0-100
    load_1m: number[];    // 1-minute load average
    load_5m: number[];    // 5-minute load average
    load_15m: number[];   // 15-minute load average
  };
}
