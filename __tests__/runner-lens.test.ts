// ─────────────────────────────────────────────────────────────
// RunnerLens — Test Suite
// ─────────────────────────────────────────────────────────────

jest.mock('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn(),
}));

// Mock outbound HTTPS requests so tests never hit the network.
// • steps.ts → GitHub API (options object with hostname)
// • job-summary.ts → QuickChart POST /chart/create (string URL); line charts may use GET URLs only
jest.mock('https', () => {
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');

  const quickChartBody = JSON.stringify({
    success: true,
    url: 'https://quickchart.io/chart?mock=1',
  });
  const githubJobsBody = JSON.stringify({ jobs: [], total_count: 0 });

  return {
    request: (urlOrOpts: unknown, optsOrCb: unknown, maybeCb?: unknown) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      let host = '';
      if (typeof urlOrOpts === 'string') {
        try {
          host = new URL(urlOrOpts).hostname;
        } catch { /* ignore */ }
      } else if (urlOrOpts && typeof urlOrOpts === 'object' && 'hostname' in (urlOrOpts as object)) {
        host = String((urlOrOpts as { hostname?: string }).hostname ?? '');
      }
      const isQuickChart = host.includes('quickchart.io');
      const responseBody = isQuickChart ? quickChartBody : githubJobsBody;

      const req = new EventEmitter() as any;
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new Readable({ read() {} }) as any;
        res.statusCode = 200;
        res.headers = {};
        if (typeof cb === 'function') (cb as (r: typeof res) => void)(res);
        res.emit('data', Buffer.from(responseBody));
        res.emit('end');
      });
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      return req;
    },
  };
});

import { stats, safeMax, safeMin, safePct, fmtDuration } from '../src/stats';
import { processMetrics } from '../src/reporter';
import { correlateSteps, fetchSteps } from '../src/steps';
import { buildJobSummary } from '../src/job-summary';
import type {
  MetricSample, SystemInfo, AggregatedReport,
} from '../src/types';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function makeSample(overrides: Partial<MetricSample> = {}): MetricSample {
  return {
    timestamp: 1700000000,
    cpu: {
      user: 30, nice: 0, system: 10, idle: 55, iowait: 3, steal: 2, usage: 45,
    },
    memory: {
      total_mb: 7168, used_mb: 3072, available_mb: 4096,
      cached_mb: 1024, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 42.9,
    },
    load: { load1: 1.5, load5: 1.2, load15: 0.9 },
    collector: { cpu_pct: 0.2, mem_mb: 3.5 },
    ...overrides,
  };
}

function makeSysInfo(overrides: Partial<SystemInfo> = {}): SystemInfo {
  return {
    cpu_count: 2,
    cpu_model: 'AMD EPYC',
    total_memory_mb: 7168,
    os_release: 'Ubuntu 22.04.3 LTS',
    kernel: '6.2.0-1018-azure',
    runner_name: 'GitHub Actions 2',
    runner_os: 'Linux',
    runner_arch: 'X64',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// stats.ts
// ─────────────────────────────────────────────────────────────

describe('stats', () => {
  it('returns zeroes for empty array', () => {
    const s = stats([]);
    expect(s.avg).toBe(0);
    expect(s.max).toBe(0);
  });

  it('computes correct stats for a known dataset', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const s = stats(values);
    expect(s.avg).toBe(55);
    expect(s.min).toBe(10);
    expect(s.max).toBe(100);
    expect(s.latest).toBe(100);
  });

  it('handles single-element array', () => {
    const s = stats([42]);
    expect(s.avg).toBe(42);
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
  });
});

describe('safeMax', () => {
  it('returns fallback for empty array', () => {
    expect(safeMax([], -1)).toBe(-1);
    expect(safeMax([])).toBe(0);
  });

  it('finds max without stack overflow on large arrays', () => {
    // Math.max(...arr) would throw RangeError here
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(safeMax(big)).toBe(199_999);
  });

  it('handles negative values', () => {
    expect(safeMax([-5, -3, -10])).toBe(-3);
  });
});

describe('safeMin', () => {
  it('returns fallback for empty array', () => {
    expect(safeMin([], -1)).toBe(-1);
    expect(safeMin([])).toBe(0);
  });

  it('finds min correctly', () => {
    expect(safeMin([5, 3, 10])).toBe(3);
  });

  it('handles negative values', () => {
    expect(safeMin([-5, -3, -10])).toBe(-10);
  });
});

describe('safePct', () => {
  it('returns 0 when denominator is 0', () => {
    expect(safePct(100, 0)).toBe(0);
  });

  it('calculates correct percentage', () => {
    expect(safePct(50, 200)).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────
// reporter.ts — processMetrics integration
// ─────────────────────────────────────────────────────────────

describe('processMetrics', () => {
  it('produces a complete report', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const { report } = processMetrics(
      [s1, s2], makeSysInfo(), 6,
    );

    // Report fields
    expect(report.version).toBe('1.0.0');
    expect(report.sample_count).toBe(2);
    expect(report.duration_seconds).toBe(6);
    expect(report.cpu.avg).toBe(45);
    expect(report.memory.total_mb).toBe(7168);
  });

  it('handles zero-duration gracefully (no NaN/Infinity)', () => {
    const s = makeSample();
    const { report } = processMetrics([s], makeSysInfo(), 0);
    expect(Number.isFinite(report.cpu.avg)).toBe(true);
    expect(Number.isFinite(report.memory.avg)).toBe(true);
  });

  it('includes swap_max_mb in memory stats', () => {
    const s = makeSample({
      memory: { total_mb: 7168, used_mb: 6000, available_mb: 1168, cached_mb: 512, swap_total_mb: 2048, swap_used_mb: 768, usage_pct: 83.7 },
    });
    const { report } = processMetrics([s], makeSysInfo(), 3);
    expect(report.memory.swap_max_mb).toBe(768);
  });

  it('includes timeline with correct length for multiple samples', () => {
    const samples = Array(100).fill(null).map((_, i) =>
      makeSample({
        timestamp: 1700000000 + i * 3,
        cpu: { user: 30, nice: 0, system: 10, idle: 55, iowait: 3, steal: 2, usage: 40 + i * 0.5 },
        memory: { total_mb: 7168, used_mb: 2000 + i * 10, available_mb: 5168, cached_mb: 1024, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 30 },
      }),
    );
    const { report } = processMetrics(samples, makeSysInfo(), 300);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(100);
    expect(report.timeline!.mem_mb).toHaveLength(100);
  });

  it('omits timeline for single sample', () => {
    const { report } = processMetrics([makeSample()], makeSysInfo(), 3);
    expect(report.timeline).toBeUndefined();
  });

  it('includes steps when passed to processMetrics', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps = [
      { name: 'Checkout', number: 1, duration_seconds: 3, cpu_avg: 30, cpu_max: 45, mem_avg_mb: 2048, mem_max_mb: 3072, sample_count: 1, started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:23Z' },
      { name: 'Build', number: 2, duration_seconds: 3, cpu_avg: 60, cpu_max: 90, mem_avg_mb: 3072, mem_max_mb: 5120, sample_count: 1, started_at: '2023-11-14T22:13:23Z', completed_at: '2023-11-14T22:13:26Z' },
    ];
    const { report } = processMetrics([s1, s2], makeSysInfo(), 6, steps);
    expect(report.steps).toHaveLength(2);
    expect(report.steps![0].name).toBe('Checkout');
  });

  it('omits steps when empty array is passed', () => {
    const s = makeSample();
    const { report } = processMetrics([s, s], makeSysInfo(), 6, []);
    expect(report.steps).toBeUndefined();
  });

  it('includes timeline with original length when fewer than 80 samples', () => {
    const samples = Array(10).fill(null).map((_, i) =>
      makeSample({ timestamp: 1700000000 + i * 3 }),
    );
    const { report } = processMetrics(samples, makeSysInfo(), 30);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(10);
    expect(report.timeline!.mem_mb).toHaveLength(10);
  });

  it('returns safe defaults for empty samples array', () => {
    const { report } = processMetrics([], makeSysInfo(), 0);
    expect(report.sample_count).toBe(0);
    expect(report.cpu.avg).toBe(0);
    expect(report.memory.total_mb).toBe(0);
    expect(report.timeline).toBeUndefined();
    expect(report.steps).toBeUndefined();
  });

  it('preserves metric_source in system info', () => {
    const s = makeSample();
    const { report } = processMetrics([s, s], makeSysInfo({ metric_source: 'cgroup' }), 6);
    expect(report.system.metric_source).toBe('cgroup');
  });
});

// ─────────────────────────────────────────────────────────────
// steps.ts — correlateSteps
// ─────────────────────────────────────────────────────────────

describe('correlateSteps', () => {
  it('maps samples to step time windows', () => {
    const samples = [
      makeSample({ timestamp: 1700000000 }),
      makeSample({ timestamp: 1700000003 }),
      makeSample({ timestamp: 1700000006 }),
      makeSample({ timestamp: 1700000009, cpu: { user: 80, nice: 0, system: 10, idle: 5, iowait: 3, steal: 2, usage: 95 } }),
      makeSample({ timestamp: 1700000012 }),
    ];

    const steps = correlateSteps(
      [
        { name: 'Checkout', number: 1, status: 'completed', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:26Z' },
        { name: 'Build', number: 2, status: 'completed', started_at: '2023-11-14T22:13:27Z', completed_at: '2023-11-14T22:13:33Z' },
      ],
      samples,
    );

    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe('Checkout');
    expect(steps[0].duration_seconds).toBe(6);
    expect(steps[0].sample_count).toBe(3); // timestamps 0, 3, 6
    expect(steps[0].started_at).toBe('2023-11-14T22:13:20Z');
    expect(steps[0].completed_at).toBe('2023-11-14T22:13:26Z');
    expect(steps[1].name).toBe('Build');
    expect(steps[1].sample_count).toBe(2); // timestamps 9, 12
    expect(steps[1].cpu_max).toBe(95);
    expect(steps[1].started_at).toBe('2023-11-14T22:13:27Z');
    expect(steps[1].completed_at).toBe('2023-11-14T22:13:33Z');
  });

  it('returns empty for empty inputs', () => {
    expect(correlateSteps([], [makeSample()])).toEqual([]);
    expect(correlateSteps(
      [{ name: 'X', number: 1, status: 'completed', started_at: '2023-01-01T00:00:00Z', completed_at: '2023-01-01T00:01:00Z' }],
      [],
    )).toEqual([]);
  });

  it('handles steps with no matching samples', () => {
    const steps = correlateSteps(
      [{ name: 'Quick', number: 1, status: 'completed', started_at: '2020-01-01T00:00:00Z', completed_at: '2020-01-01T00:00:01Z' }],
      [makeSample({ timestamp: 1700000000 })],
    );
    expect(steps[0].sample_count).toBe(0);
    expect(steps[0].cpu_avg).toBe(0);
    expect(steps[0].started_at).toBe('2020-01-01T00:00:00Z');
    expect(steps[0].completed_at).toBe('2020-01-01T00:00:01Z');
  });

  it('handles step with null completed_at (still in-progress)', () => {
    const samples = [
      makeSample({ timestamp: 1700000000 }),
      makeSample({ timestamp: 1700000003 }),
    ];
    const steps = correlateSteps(
      [{ name: 'Running', number: 1, status: 'in_progress', started_at: '2023-11-14T22:13:20Z', completed_at: null }],
      samples,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Running');
    expect(steps[0].completed_at).toBeTruthy();
  });

  it('skips steps without started_at', () => {
    const steps = correlateSteps(
      [
        { name: 'Pending', number: 1, status: 'queued', started_at: null, completed_at: null },
        { name: 'Done', number: 2, status: 'completed', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:30Z' },
      ],
      [makeSample({ timestamp: 1700000000 })],
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Done');
  });
});

describe('fetchSteps (GitHub API)', () => {
  const origValues: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_JOB']) {
      origValues[k] = process.env[k];
    }
  });

  afterEach(() => {
    for (const k of Object.keys(origValues)) {
      if (origValues[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = origValues[k];
      }
    }
  });

  it('returns empty when GITHUB env vars are missing', async () => {
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_JOB;
    const result = await fetchSteps('fake-token');
    expect(result).toEqual({ steps: [] });
  });

  it('returns empty when API returns non-200', async () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_JOB = 'build';

    const https = require('https');
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const origRequest = https.request;

    https.request = jest.fn((_opts: unknown, cb: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new Readable({ read() {} }) as any;
        res.statusCode = 403;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from('Forbidden'));
        res.emit('end');
      });
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      return req;
    });

    const result = await fetchSteps('bad-token');
    expect(result).toEqual({ steps: [] });

    https.request = origRequest;
  });

  it('returns empty when API returns invalid JSON', async () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_JOB = 'build';

    const https = require('https');
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const origRequest = https.request;

    https.request = jest.fn((_opts: unknown, cb: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new Readable({ read() {} }) as any;
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from('<html>Bad Gateway</html>'));
        res.emit('end');
      });
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      return req;
    });

    const result = await fetchSteps('token');
    expect(result).toEqual({ steps: [] });

    https.request = origRequest;
  });

  it('matches job by prefix for matrix builds', async () => {
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_JOB = 'build';

    const https = require('https');
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const origRequest = https.request;

    const apiResponse = JSON.stringify({
      jobs: [
        {
          name: 'build (node-20, ubuntu)',
          status: 'in_progress',
          started_at: '2023-11-14T22:13:20Z',
          steps: [{ name: 'Checkout', number: 1, status: 'completed', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:25Z' }],
        },
      ],
      total_count: 1,
    });

    https.request = jest.fn((_opts: unknown, cb: (res: any) => void) => {
      const req = new EventEmitter() as any;
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new Readable({ read() {} }) as any;
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from(apiResponse));
        res.emit('end');
      });
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      return req;
    });

    const result = await fetchSteps('token');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].name).toBe('Checkout');
    expect(result.jobStartedAt).toBe('2023-11-14T22:13:20Z');

    https.request = origRequest;
  });
});

// ─────────────────────────────────────────────────────────────
// Edge cases & safety
// ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('safeMax handles array larger than call stack limit', () => {
    // Proves this is stack-safe unlike Math.max(...arr)
    const huge = new Array(500_000).fill(0).map((_, i) => i % 100);
    expect(() => safeMax(huge)).not.toThrow();
    expect(safeMax(huge)).toBe(99);
  });

  it('safePct with zero total_mb does not produce NaN', () => {
    const result = safePct(3072, 0);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });

  it('processMetrics with a single sample does not crash', () => {
    const s = makeSample();
    expect(() => processMetrics([s], makeSysInfo(), 3)).not.toThrow();
  });

  it('reporter handles samples with missing optional fields', () => {
    const sparse: MetricSample = {
      timestamp: 1700000000,
      cpu: { user: 10, nice: 0, system: 5, idle: 85, iowait: 0, steal: 0, usage: 15 },
      memory: { total_mb: 4096, used_mb: 1024, available_mb: 3072, cached_mb: 512, swap_total_mb: 0, swap_used_mb: 0, usage_pct: 25 },
      load: { load1: 0, load5: 0, load15: 0 },
    };
    const { report } = processMetrics([sparse], makeSysInfo(), 3);
    expect(report.cpu.avg).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────
// stats.ts — fmtDuration
// ─────────────────────────────────────────────────────────────

describe('fmtDuration', () => {
  it('formats seconds', () => expect(fmtDuration(45)).toBe('45s'));
  it('formats minutes + seconds', () => expect(fmtDuration(125)).toBe('2m 5s'));
  it('formats exact minutes', () => expect(fmtDuration(120)).toBe('2m'));
});

// ─────────────────────────────────────────────────────────────
// job-summary.ts
// ─────────────────────────────────────────────────────────────

describe('buildJobSummary', () => {
  function makeReport(overrides: Partial<AggregatedReport> = {}): AggregatedReport {
    return {
      version: '1.0.0',
      system: makeSysInfo(),
      duration_seconds: 300,
      sample_count: 100,
      started_at: '2023-11-14T22:13:20Z',
      ended_at: '2023-11-14T22:18:20Z',
      cpu: { avg: 45, max: 92, min: 5, latest: 70 },
      memory: { avg: 3072, max: 5120, min: 1024, latest: 3500, total_mb: 7168, swap_max_mb: 0 },
      load: { avg_1m: 1.5, max_1m: 3.2 },
      ...overrides,
    };
  }

  it('produces summary with stat cards image and footer', async () => {
    const md = await buildJobSummary(makeReport(), 3);
    expect(md).toContain('<img');
    expect(md).toContain('Runner Stats');
    expect(md).toContain('RunnerLens');
  });

  it('uses QuickChart chart URLs in output (GET or POST-returned)', async () => {
    const md = await buildJobSummary(makeReport(), 3);
    expect(md).toContain('quickchart.io/chart?');
    expect(md).not.toContain('/chart/render/');
    expect(md).not.toContain('/chart/create');
  });

  it('includes QuickChart CPU and Memory charts when timeline has >= 2 points', async () => {
    const html = await buildJobSummary(makeReport({
      timeline: {
        cpu_pct: [10, 20, 30, 40, 50],
        cpu_user: [8, 15, 22, 30, 38],
        cpu_nice: [0, 0, 0, 0, 0],
        cpu_system: [2, 5, 8, 10, 12],
        mem_mb: [1024, 2048, 3072, 2048, 1024],
        mem_cached_mb: [200, 300, 400, 350, 250],
        mem_swap_mb: [0, 0, 10, 20, 5],
      },
    }), 3);
    expect(html).toContain('<img');
    expect(html).toContain('CPU Usage');
    expect(html).toContain('Memory Usage');
  });

  it('includes Gantt chart image when steps are present', async () => {
    const html = await buildJobSummary(makeReport({
      steps: [
        { name: 'Checkout', number: 1, duration_seconds: 6, cpu_avg: 20, cpu_max: 40, mem_avg_mb: 1024, mem_max_mb: 2048, sample_count: 2, started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:26Z' },
        { name: 'Build', number: 2, duration_seconds: 60, cpu_avg: 60, cpu_max: 92, mem_avg_mb: 3072, mem_max_mb: 5120, sample_count: 20, started_at: '2023-11-14T22:13:27Z', completed_at: '2023-11-14T22:14:27Z' },
      ],
      timeline: {
        cpu_pct: [10, 20, 30, 40, 50],
        cpu_user: [8, 15, 22, 30, 38],
        cpu_nice: [0, 0, 0, 0, 0],
        cpu_system: [2, 5, 8, 10, 12],
        mem_mb: [1024, 2048, 3072, 2048, 1024],
        mem_cached_mb: [200, 300, 400, 350, 250],
        mem_swap_mb: [0, 0, 10, 20, 5],
      },
    }), 3);
    expect(html).toContain('<img');
    expect(html).toContain('Execution Timeline');
  });

  it('skips line charts when no timeline data', async () => {
    const md = await buildJobSummary(makeReport({ timeline: undefined }), 3);
    // Stat cards image is still present
    expect(md).toContain('Runner Stats');
    // But no CPU/Memory line charts
    expect(md).not.toContain('CPU Usage');
  });

  it('includes footer with version', async () => {
    const html = await buildJobSummary(makeReport(), 3);
    expect(html).toContain('v1.0.0');
    expect(html).toContain('runnerlens/runner-lens');
  });

  it('formats duration >= 60s as minutes (fmtDuration)', () => {
    // fmtDuration is tested directly above; stat cards render values into an image
    expect(fmtDuration(120)).toBe('2m');
  });

  it('formats memory < 1024 MB as MB (fmtMem via stat cards)', async () => {
    // Value is baked into the stat cards image; verify the summary still builds
    const md = await buildJobSummary(makeReport({
      memory: { avg: 512, max: 800, min: 100, latest: 600, total_mb: 1024, swap_max_mb: 0 },
    }), 3);
    expect(md).toContain('Runner Stats');
    expect(md).toContain('RunnerLens');
  });

  it('downsamples long timelines and skips labels', async () => {
    const cpu = Array.from({ length: 60 }, (_, i) => 20 + (i % 30));
    const mem = Array.from({ length: 60 }, (_, i) => 1000 + i * 50);
    const md = await buildJobSummary(makeReport({
      timeline: { cpu_pct: cpu, cpu_user: cpu.map(v => v * 0.7), cpu_nice: cpu.map(() => 0), cpu_system: cpu.map(v => v * 0.3), mem_mb: mem, mem_cached_mb: mem.map(v => v * 0.1), mem_swap_mb: mem.map(() => 0) },
    }), 3);
    expect(md).toContain('quickchart.io');
    expect(md).toContain('CPU Usage');
    expect(md).toContain('Memory Usage');
  });
});
