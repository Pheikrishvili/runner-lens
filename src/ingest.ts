// ─────────────────────────────────────────────────────────────
// RunnerLens — LeanCI report ingestion
//
// Sends the aggregated report to the LeanCI ingest API so it can
// power historical trends and dashboards. Best-effort: callers
// should treat a thrown error as non-fatal.
// ─────────────────────────────────────────────────────────────

import type { AggregatedReport } from './types';

interface RunContext {
  owner: string;
  repo: string;
  runId: string;
  job: string;
}

function runContext(): RunContext | undefined {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const job = process.env.GITHUB_JOB ?? '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || !runId || !job) return undefined;
  return { owner, repo, runId, job };
}

export interface IngestResult {
  stored: boolean;
  path?: string;
}

/**
 * POST the aggregated report to `${apiUrl}/v1/ingest`.
 * Throws on any failure (missing run context, network error, non-2xx
 * response) — callers should catch and log rather than fail the job.
 */
export async function ingestReport(
  report: AggregatedReport,
  apiUrl: string,
  apiKey: string,
): Promise<IngestResult> {
  const run = runContext();
  if (!run) throw new Error('missing GITHUB_REPOSITORY/RUN_ID/JOB env vars');

  const endpoint = `${apiUrl.replace(/\/+$/, '')}/v1/ingest`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ run, report }),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    throw new Error('ingest rejected — invalid or missing leanci-api-key');
  }
  if (res.status === 429) {
    throw new Error('ingest rate-limited (429) — report was not stored');
  }
  if (!res.ok) {
    throw new Error(`ingest API returned ${res.status}`);
  }

  return (await res.json()) as IngestResult;
}
