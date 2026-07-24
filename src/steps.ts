import * as core from '@actions/core';
import * as https from 'https';
import type { IncomingMessage } from 'http';
import type { MetricSample, StepMetrics } from './types';
import { safeMax } from './stats';

// ─────────────────────────────────────────────────────────────
// Types for GitHub API response
// ─────────────────────────────────────────────────────────────

interface GitHubStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface GitHubJob {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  steps: GitHubStep[];
}

export interface FetchStepsResult {
  steps: GitHubStep[];
  jobStartedAt?: string;
  /** success | failure | cancelled | timed_out — omitted if it can't be determined. */
  jobConclusion?: string;
}

/**
 * Infer the job's outcome. At post-time the job's own `conclusion` is still
 * null (the job — including this always()-post step — is in_progress), so we
 * fall back to reducing the completed steps the way GitHub does: any failure
 * wins, then timed-out, then cancelled, else success. Steps still running
 * (this collector) or skipped don't decide the outcome.
 */
function deriveConclusion(job: GitHubJob): string | undefined {
  if (job.conclusion) return job.conclusion;
  const done = job.steps.filter((s) => s.status === 'completed' && s.conclusion);
  if (done.length === 0) return undefined;
  const has = (c: string): boolean => done.some((s) => s.conclusion === c);
  if (has('failure')) return 'failure';
  if (has('timed_out')) return 'timed_out';
  if (has('cancelled')) return 'cancelled';
  return 'success';
}

// ─────────────────────────────────────────────────────────────
// Fetch steps from GitHub API
// ─────────────────────────────────────────────────────────────

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 15_000;

function httpGet(
  url: string,
  headers: Record<string, string>,
  redirectsLeft = MAX_REDIRECTS,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    // Hard cap on total request time (connection + body transfer)
    const totalTimer = setTimeout(() => {
      req.destroy();
      reject(new Error(`total timeout after ${TOTAL_TIMEOUT_MS}ms`));
    }, TOTAL_TIMEOUT_MS);

    const cleanup = (): void => { clearTimeout(totalTimer); };

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...headers, 'User-Agent': 'RunnerLens' },
        timeout: 10_000,
      },
      (res: IncomingMessage) => {
        // Follow redirects (301, 302, 307, 308)
        const status = res.statusCode ?? 0;
        if ([301, 302, 307, 308].includes(status) && res.headers.location) {
          cleanup();
          res.resume(); // drain the response
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          httpGet(res.headers.location, headers, redirectsLeft - 1)
            .then(resolve, reject);
          return;
        }

        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => { cleanup(); resolve({ status, body: data }); });
      },
    );
    req.on('error', (e) => { cleanup(); reject(e); });
    req.on('timeout', () => { cleanup(); req.destroy(); reject(new Error('socket timeout')); });
    req.end();
  });
}

export async function fetchSteps(token: string): Promise<FetchStepsResult> {
  const repo  = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const job   = process.env.GITHUB_JOB;
  const apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com';

  if (!repo || !runId || !job) {
    core.info('RunnerLens: missing GITHUB env vars for step detection');
    return { steps: [] };
  }

  const authHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Paginate through all jobs (matrix builds can exceed 100)
  let jobs: GitHubJob[] = [];
  let page = 1;
  const maxPages = 5;
  while (page <= maxPages) {
    const url = `${apiUrl}/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`;
    const res = await httpGet(url, authHeaders);

    if (res.status !== 200) {
      core.info(`RunnerLens: GitHub API returned ${res.status} — add "permissions: actions: read" to your job for per-step breakdown`);
      return { steps: [] };
    }

    let data: { jobs?: GitHubJob[]; total_count?: number };
    try {
      data = JSON.parse(res.body);
    } catch {
      core.info('RunnerLens: GitHub API returned non-JSON response');
      return { steps: [] };
    }

    const pageJobs: GitHubJob[] = data.jobs ?? [];
    jobs = jobs.concat(pageJobs);

    // Stop if we've fetched all jobs or got a short page
    if (pageJobs.length < 100 || (data.total_count && jobs.length >= data.total_count)) {
      break;
    }
    page++;
  }

  // Find current job. GITHUB_JOB is the workflow key (e.g. "build"), but
  // j.name is the display name which includes matrix params (e.g.
  // "Build (node-20, ubuntu)"). Try: exact match → prefix match → in-progress.
  const current =
    jobs.find((j) => j.name === job) ??
    jobs.find((j) => j.name.startsWith(job + ' ') || j.name.startsWith(job + ' (')) ??
    jobs.find((j) => j.status === 'in_progress');
  if (!current) {
    core.info(`RunnerLens: could not match job "${job}" — found: ${jobs.map((j) => j.name).join(', ')}`);
    return { steps: [] };
  }

  return {
    steps: current.steps ?? [],
    jobStartedAt: current.started_at ?? undefined,
    jobConclusion: deriveConclusion(current),
  };
}

// ─────────────────────────────────────────────────────────────
// Correlate steps with samples
// ─────────────────────────────────────────────────────────────

export function correlateSteps(
  steps: GitHubStep[],
  samples: MetricSample[],
): StepMetrics[] {
  if (steps.length === 0 || samples.length === 0) return [];

  const nowSec = Math.floor(Date.now() / 1000);

  return steps
    .filter((s) => s.started_at)
    .map((step) => {
      const startSec = Math.floor(new Date(step.started_at!).getTime() / 1000);
      const endSec = step.completed_at
        ? Math.floor(new Date(step.completed_at).getTime() / 1000)
        : nowSec;

      const window = samples.filter(
        (s) => s.timestamp >= startSec && s.timestamp <= endSec,
      );

      const duration = Math.max(0, endSec - startSec);

      const startedAt = step.started_at!;
      const completedAt = step.completed_at ?? new Date(nowSec * 1000).toISOString();

      if (window.length === 0) {
        return {
          name: step.name,
          number: step.number,
          duration_seconds: duration,
          cpu_avg: 0,
          cpu_max: 0,
          mem_avg_mb: 0,
          mem_max_mb: 0,
          sample_count: 0,
          started_at: startedAt,
          completed_at: completedAt,
        };
      }

      const cpuVals = window.map((s) => s.cpu.usage);
      const memVals = window.map((s) => s.memory.used_mb);

      return {
        name: step.name,
        number: step.number,
        duration_seconds: duration,
        cpu_avg: cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length,
        cpu_max: safeMax(cpuVals),
        mem_avg_mb: memVals.reduce((a, b) => a + b, 0) / memVals.length,
        mem_max_mb: safeMax(memVals),
        sample_count: window.length,
        started_at: startedAt,
        completed_at: completedAt,
      };
    });
}
