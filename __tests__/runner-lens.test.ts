// ─────────────────────────────────────────────────────────────
// RunnerLens — Test Suite
// ─────────────────────────────────────────────────────────────

jest.mock('@actions/artifact', () => ({
  DefaultArtifactClient: jest.fn(),
}));

// Mock outbound HTTPS requests (steps.ts / GitHub API) so tests never
// hit the network.
jest.mock('https', () => {
  const { EventEmitter } = require('events');
  const { Readable } = require('stream');

  const GITHUB_BODY = JSON.stringify({ jobs: [], total_count: 0 });

  return {
    request: (_urlOrOpts: unknown, optsOrCb: unknown, maybeCb?: unknown) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
      const req = new EventEmitter() as any;
      req.write = jest.fn();
      req.end = jest.fn(() => {
        const res = new Readable({ read() {} }) as any;
        res.statusCode = 200;
        res.headers = {};
        if (typeof cb === 'function') cb(res);
        res.emit('data', Buffer.from(GITHUB_BODY));
        res.emit('end');
      });
      req.destroy = jest.fn();
      req.setTimeout = jest.fn();
      return req;
    },
  };
});

// Mock global fetch (job-summary.ts → LeanCI chart service).
const CHART_IMAGE_URL =
  'https://storage.googleapis.com/leanci-charts-paid-dev/charts/adhoc/0123456789abcdef.png';
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 201,
  json: async () => ({ url: CHART_IMAGE_URL, tier: 'paid' }),
}));
(globalThis as { fetch: unknown }).fetch = fetchMock;
beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ url: CHART_IMAGE_URL, tier: 'paid' }),
  }));
});

const CHART_SVC = { url: 'https://chart.example.dev', apiKey: 'test-key' };

import { stats, safeMax, safeMin, safePct, fmtDuration } from '../src/stats';
import { processMetrics } from '../src/reporter';
import { correlateSteps, fetchSteps } from '../src/steps';
import { buildJobSummary } from '../src/job-summary';
import { errMsg } from '../src/errors';
import { parseConfig } from '../src/config';
import { ingestReport } from '../src/ingest';
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
    const report = processMetrics(
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
    const report = processMetrics([s], makeSysInfo(), 0);
    expect(Number.isFinite(report.cpu.avg)).toBe(true);
    expect(Number.isFinite(report.memory.avg)).toBe(true);
  });

  it('includes swap_max_mb in memory stats', () => {
    const s = makeSample({
      memory: { total_mb: 7168, used_mb: 6000, available_mb: 1168, cached_mb: 512, swap_total_mb: 2048, swap_used_mb: 768, usage_pct: 83.7 },
    });
    const report = processMetrics([s], makeSysInfo(), 3);
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
    const report = processMetrics(samples, makeSysInfo(), 300);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(100);
    expect(report.timeline!.mem_mb).toHaveLength(100);
  });

  it('exports every collected metric in the timeline', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const report = processMetrics([s1, s2], makeSysInfo(), 6);
    const timeline = report.timeline!;
    expect(timeline.cpu_idle).toEqual([55, 55]);
    expect(timeline.cpu_iowait).toEqual([3, 3]);
    expect(timeline.cpu_steal).toEqual([2, 2]);
    expect(timeline.mem_available_mb).toEqual([4096, 4096]);
    expect(timeline.mem_usage_pct).toEqual([42.9, 42.9]);
    expect(timeline.load_1m).toEqual([1.5, 1.5]);
    expect(timeline.load_5m).toEqual([1.2, 1.2]);
    expect(timeline.load_15m).toEqual([0.9, 0.9]);
  });

  it('omits timeline for single sample', () => {
    const report = processMetrics([makeSample()], makeSysInfo(), 3);
    expect(report.timeline).toBeUndefined();
  });

  it('includes steps when passed to processMetrics', () => {
    const s1 = makeSample({ timestamp: 1700000000 });
    const s2 = makeSample({ timestamp: 1700000003 });
    const steps = [
      { name: 'Checkout', number: 1, duration_seconds: 3, cpu_avg: 30, cpu_max: 45, mem_avg_mb: 2048, mem_max_mb: 3072, sample_count: 1, started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:23Z' },
      { name: 'Build', number: 2, duration_seconds: 3, cpu_avg: 60, cpu_max: 90, mem_avg_mb: 3072, mem_max_mb: 5120, sample_count: 1, started_at: '2023-11-14T22:13:23Z', completed_at: '2023-11-14T22:13:26Z' },
    ];
    const report = processMetrics([s1, s2], makeSysInfo(), 6, steps);
    expect(report.steps).toHaveLength(2);
    expect(report.steps![0].name).toBe('Checkout');
  });

  it('omits steps when empty array is passed', () => {
    const s = makeSample();
    const report = processMetrics([s, s], makeSysInfo(), 6, []);
    expect(report.steps).toBeUndefined();
  });

  it('includes timeline with original length when fewer than 80 samples', () => {
    const samples = Array(10).fill(null).map((_, i) =>
      makeSample({ timestamp: 1700000000 + i * 3 }),
    );
    const report = processMetrics(samples, makeSysInfo(), 30);
    expect(report.timeline).toBeDefined();
    expect(report.timeline!.cpu_pct).toHaveLength(10);
    expect(report.timeline!.mem_mb).toHaveLength(10);
  });

  it('returns safe defaults for empty samples array', () => {
    const report = processMetrics([], makeSysInfo(), 0);
    expect(report.sample_count).toBe(0);
    expect(report.cpu.avg).toBe(0);
    expect(report.memory.total_mb).toBe(0);
    expect(report.timeline).toBeUndefined();
    expect(report.steps).toBeUndefined();
  });

  it('preserves metric_source in system info', () => {
    const s = makeSample();
    const report = processMetrics([s, s], makeSysInfo({ metric_source: 'cgroup' }), 6);
    expect(report.system.metric_source).toBe('cgroup');
  });

  it('aggregates the collector\'s own footprint', () => {
    const report = processMetrics(
      [
        makeSample({ timestamp: 1700000000, collector: { cpu_pct: 0.2, mem_mb: 3 } }),
        makeSample({ timestamp: 1700000003, collector: { cpu_pct: 0.6, mem_mb: 5 } }),
      ],
      makeSysInfo(), 6,
    );
    expect(report.collector_overhead).toEqual({
      cpu_avg: 0.4, cpu_max: 0.6, mem_avg_mb: 4, mem_max_mb: 5,
    });
  });

  it('omits collector_overhead when no sample carries one', () => {
    const bare = makeSample();
    delete bare.collector;
    const report = processMetrics([bare, bare], makeSysInfo(), 6);
    expect(report.collector_overhead).toBeUndefined();
  });

  it('computes load stats from the 1-minute average', () => {
    const report = processMetrics(
      [
        makeSample({ timestamp: 1700000000, load: { load1: 1, load5: 1, load15: 1 } }),
        makeSample({ timestamp: 1700000003, load: { load1: 3, load5: 1, load15: 1 } }),
      ],
      makeSysInfo(), 6,
    );
    expect(report.load.avg_1m).toBe(2);
    expect(report.load.max_1m).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────
// errors.ts
// ─────────────────────────────────────────────────────────────

describe('errMsg', () => {
  it('unwraps an Error to its message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error throwables', () => {
    expect(errMsg('plain string')).toBe('plain string');
    expect(errMsg(42)).toBe('42');
    expect(errMsg(undefined)).toBe('undefined');
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
        { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:26Z' },
        { name: 'Build', number: 2, status: 'completed', conclusion: 'success', started_at: '2023-11-14T22:13:27Z', completed_at: '2023-11-14T22:13:33Z' },
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
      [{ name: 'X', number: 1, status: 'completed', conclusion: 'success', started_at: '2023-01-01T00:00:00Z', completed_at: '2023-01-01T00:01:00Z' }],
      [],
    )).toEqual([]);
  });

  it('handles steps with no matching samples', () => {
    const steps = correlateSteps(
      [{ name: 'Quick', number: 1, status: 'completed', conclusion: 'success', started_at: '2020-01-01T00:00:00Z', completed_at: '2020-01-01T00:00:01Z' }],
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
      [{ name: 'Running', number: 1, status: 'in_progress', conclusion: null, started_at: '2023-11-14T22:13:20Z', completed_at: null }],
      samples,
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('Running');
    expect(steps[0].completed_at).toBeTruthy();
  });

  it('skips steps without started_at', () => {
    const steps = correlateSteps(
      [
        { name: 'Pending', number: 1, status: 'queued', conclusion: null, started_at: null, completed_at: null },
        { name: 'Done', number: 2, status: 'completed', conclusion: 'success', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:30Z' },
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
          steps: [{ name: 'Checkout', number: 1, status: 'completed', conclusion: 'success', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:25Z' }],
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

  it('derives job conclusion "failure" from a failed step while the job is in_progress', async () => {
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
          name: 'build',
          status: 'in_progress', // job (incl. this post step) not done yet
          conclusion: null,
          started_at: '2023-11-14T22:13:20Z',
          steps: [
            { name: 'Checkout', number: 1, status: 'completed', conclusion: 'success', started_at: '2023-11-14T22:13:20Z', completed_at: '2023-11-14T22:13:25Z' },
            { name: 'Test', number: 2, status: 'completed', conclusion: 'failure', started_at: '2023-11-14T22:13:25Z', completed_at: '2023-11-14T22:14:00Z' },
            { name: 'RunnerLens', number: 3, status: 'in_progress', conclusion: null, started_at: '2023-11-14T22:14:00Z', completed_at: null },
          ],
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
    expect(result.jobConclusion).toBe('failure');

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
    const report = processMetrics([sparse], makeSysInfo(), 3);
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

  function makeTimeline(
    cpu: number[],
    mem: number[],
  ): NonNullable<AggregatedReport['timeline']> {
    return {
      cpu_pct: cpu,
      cpu_user: cpu.map((v) => v * 0.7),
      cpu_nice: cpu.map(() => 0),
      cpu_system: cpu.map((v) => v * 0.3),
      cpu_idle: cpu.map((v) => 100 - v),
      cpu_iowait: cpu.map(() => 1),
      cpu_steal: cpu.map(() => 0),
      mem_mb: mem,
      mem_available_mb: mem.map((v) => 7168 - v),
      mem_cached_mb: mem.map((v) => v * 0.1),
      mem_swap_mb: mem.map(() => 0),
      mem_usage_pct: mem.map((v) => (v / 7168) * 100),
      load_1m: cpu.map((v) => v / 50),
      load_5m: cpu.map((v) => v / 60),
      load_15m: cpu.map((v) => v / 70),
    };
  }

  it('produces summary with stat cards image and no footer clutter', async () => {
    const md = await buildJobSummary(makeReport(), 3, CHART_SVC);
    expect(md).toContain('<img');
    expect(md).toContain('Runner Stats');
    expect(md).not.toContain('Generated by');
    expect(md).not.toContain('expire after');
  });

  it('embeds bucket image URLs, never the service endpoint or key', async () => {
    const md = await buildJobSummary(makeReport({
      timeline: makeTimeline([10, 20, 30, 40, 50], [1024, 2048, 3072, 2048, 1024]),
    }), 3, CHART_SVC);
    expect(md).toContain('storage.googleapis.com/leanci-charts-paid-dev');
    expect(md).not.toContain(CHART_SVC.url);
    expect(md).not.toContain(CHART_SVC.apiKey);
  });

  it('omits the x-api-key header when no key is configured', async () => {
    await buildJobSummary(makeReport(), 3, { url: CHART_SVC.url, apiKey: '' });
    const firstCall = fetchMock.mock.calls[0] as unknown as
      [string, { headers: Record<string, string> }];
    expect(firstCall[1].headers).not.toHaveProperty('x-api-key');
  });


  it('sends JSON configs to the chart service with auth and run context', async () => {
    process.env.GITHUB_REPOSITORY = 'leanci/web';
    process.env.GITHUB_RUN_ID = '42';
    try {
      await buildJobSummary(makeReport({
        timeline: makeTimeline([10, 20], [1024, 2048]),
      }), 3, CHART_SVC);
    } finally {
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_RUN_ID;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      'https://chart.example.dev/v1/charts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
      }),
    );
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(firstCall[1].body);
    expect(body.run).toEqual({ owner: 'leanci', repo: 'web', runId: '42' });
    expect(body.devicePixelRatio).toBe(2);
    expect(body.chart).toBeDefined();
    // Configs must be pure JSON — the QuickChart-era function callbacks are gone
    expect(firstCall[1].body).not.toContain('function');
  });

  it('includes CPU and Memory charts when timeline has >= 2 points', async () => {
    const html = await buildJobSummary(makeReport({
      timeline: makeTimeline([10, 20, 30, 40, 50], [1024, 2048, 3072, 2048, 1024]),
    }), 3, CHART_SVC);
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
      timeline: makeTimeline([10, 20, 30, 40, 50], [1024, 2048, 3072, 2048, 1024]),
    }), 3, CHART_SVC);
    expect(html).toContain('<img');
    expect(html).toContain('Execution Timeline');
  });

  it('skips line charts when no timeline data', async () => {
    const md = await buildJobSummary(makeReport({ timeline: undefined }), 3, CHART_SVC);
    // Stat cards image is still present
    expect(md).toContain('Runner Stats');
    // But no CPU/Memory line charts
    expect(md).not.toContain('CPU Usage');
  });


  it('formats duration >= 60s as minutes (fmtDuration)', () => {
    // fmtDuration is tested directly above; stat cards render values into an image
    expect(fmtDuration(120)).toBe('2m');
  });

  it('formats memory < 1024 MB as MB (fmtMem via stat cards)', async () => {
    // Value is baked into the stat cards image; verify the summary still builds
    const md = await buildJobSummary(makeReport({
      memory: { avg: 512, max: 800, min: 100, latest: 600, total_mb: 1024, swap_max_mb: 0 },
    }), 3, CHART_SVC);
    expect(md).toContain('Runner Stats');
  });

  it('downsamples long timelines and skips labels', async () => {
    const cpu = Array.from({ length: 60 }, (_, i) => 20 + (i % 30));
    const mem = Array.from({ length: 60 }, (_, i) => 1000 + i * 50);
    const md = await buildJobSummary(makeReport({
      timeline: makeTimeline(cpu, mem),
    }), 3, CHART_SVC);
    expect(md).toContain('storage.googleapis.com');
    expect(md).toContain('CPU Usage');
    expect(md).toContain('Memory Usage');
  });
});

// ─────────────────────────────────────────────────────────────
// config.ts
// ─────────────────────────────────────────────────────────────

describe('parseConfig', () => {
  // @actions/core reads inputs from INPUT_<NAME> env vars.
  const inputKeys = [
    'INPUT_SAMPLE-INTERVAL', 'INPUT_MAX-FILE-SIZE', 'INPUT_UPLOAD-ARTIFACT',
    'INPUT_GITHUB-TOKEN', 'INPUT_CHART-URL', 'INPUT_API-URL', 'INPUT_LEANCI-API-KEY',
  ];

  beforeEach(() => {
    for (const k of inputKeys) delete process.env[k];
    delete process.env.GITHUB_TOKEN;
  });

  it('falls back to documented defaults when nothing is set', () => {
    const cfg = parseConfig();
    expect(cfg.sampleInterval).toBe(5);
    expect(cfg.maxSizeMb).toBe(100);
    expect(cfg.uploadArtifact).toBe(true);
    expect(cfg.chartUrl).toBe('https://chart.dev.leanci.dev');
    expect(cfg.apiUrl).toBe('https://api.dev.leanci.dev');
    expect(cfg.apiKey).toBe('');
  });

  it('clamps sample-interval into the documented 1-60 range', () => {
    process.env['INPUT_SAMPLE-INTERVAL'] = '9999';
    expect(parseConfig().sampleInterval).toBe(60);
    process.env['INPUT_SAMPLE-INTERVAL'] = '0';
    expect(parseConfig().sampleInterval).toBe(1);
    process.env['INPUT_SAMPLE-INTERVAL'] = '-7';
    expect(parseConfig().sampleInterval).toBe(1);
  });

  it('falls back to the default when an integer input is not a number', () => {
    process.env['INPUT_SAMPLE-INTERVAL'] = 'abc';
    process.env['INPUT_MAX-FILE-SIZE'] = 'not-a-number';
    const cfg = parseConfig();
    expect(cfg.sampleInterval).toBe(5);
    expect(cfg.maxSizeMb).toBe(100);
  });

  it('never lets max-file-size go negative (0 = unlimited)', () => {
    process.env['INPUT_MAX-FILE-SIZE'] = '-5';
    expect(parseConfig().maxSizeMb).toBe(0);
  });

  it('treats upload-artifact case-insensitively and defaults non-"true" to false', () => {
    process.env['INPUT_UPLOAD-ARTIFACT'] = 'TRUE';
    expect(parseConfig().uploadArtifact).toBe(true);
    process.env['INPUT_UPLOAD-ARTIFACT'] = 'false';
    expect(parseConfig().uploadArtifact).toBe(false);
    process.env['INPUT_UPLOAD-ARTIFACT'] = 'yes';
    expect(parseConfig().uploadArtifact).toBe(false);
  });

  it('prefers the explicit github-token input over the env var', () => {
    process.env.GITHUB_TOKEN = 'from-env';
    expect(parseConfig().githubToken).toBe('from-env');
    process.env['INPUT_GITHUB-TOKEN'] = 'from-input';
    expect(parseConfig().githubToken).toBe('from-input');
  });
});

// ─────────────────────────────────────────────────────────────
// ingest.ts
// ─────────────────────────────────────────────────────────────

describe('ingestReport', () => {
  const report = { version: '1.0.0' } as unknown as AggregatedReport;

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = 'leanci/web';
    process.env.GITHUB_RUN_ID = '42';
    process.env.GITHUB_JOB = 'build';
    process.env.GITHUB_WORKFLOW = 'CI';
  });

  afterEach(() => {
    for (const k of ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_JOB', 'GITHUB_WORKFLOW']) {
      delete process.env[k];
    }
  });

  function mockIngest(status: number, body: unknown = { stored: true, path: 'raw/x.json' }) {
    fetchMock.mockImplementation(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as never);
  }

  it('posts run context and report to /v1/ingest with the api key', async () => {
    mockIngest(200);
    const result = await ingestReport(report, 'https://api.example.dev', 'k-123', 'success');

    expect(result).toEqual({ stored: true, path: 'raw/x.json' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as
      [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://api.example.dev/v1/ingest');
    expect(init.headers['x-api-key']).toBe('k-123');
    expect(JSON.parse(init.body).run).toEqual({
      owner: 'leanci', repo: 'web', runId: '42', job: 'build',
      workflow: 'CI', conclusion: 'success',
    });
  });

  it('strips trailing slashes from the api url', async () => {
    mockIngest(200);
    await ingestReport(report, 'https://api.example.dev///', 'k-123');
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.example.dev/v1/ingest');
  });

  it('caps an over-long workflow name at core\'s 200-char limit', async () => {
    process.env.GITHUB_WORKFLOW = 'w'.repeat(500);
    mockIngest(200);
    await ingestReport(report, 'https://api.example.dev', 'k-123');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).run.workflow).toHaveLength(200);
  });

  it('omits workflow and conclusion when they are unavailable', async () => {
    delete process.env.GITHUB_WORKFLOW;
    mockIngest(200);
    await ingestReport(report, 'https://api.example.dev', 'k-123');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const run = JSON.parse(init.body).run;
    expect(run).not.toHaveProperty('workflow');
    expect(run).not.toHaveProperty('conclusion');
  });

  it('throws before any network call when run context is missing', async () => {
    delete process.env.GITHUB_RUN_ID;
    await expect(ingestReport(report, 'https://api.example.dev', 'k'))
      .rejects.toThrow(/missing GITHUB_REPOSITORY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an invalid key distinctly from other failures', async () => {
    mockIngest(401);
    await expect(ingestReport(report, 'https://api.example.dev', 'bad'))
      .rejects.toThrow(/invalid or missing leanci-api-key/);
  });

  it('reports rate limiting distinctly', async () => {
    mockIngest(429);
    await expect(ingestReport(report, 'https://api.example.dev', 'k'))
      .rejects.toThrow(/rate-limited/);
  });

  it('throws on any other non-2xx status', async () => {
    mockIngest(503);
    await expect(ingestReport(report, 'https://api.example.dev', 'k'))
      .rejects.toThrow(/ingest API returned 503/);
  });
});
