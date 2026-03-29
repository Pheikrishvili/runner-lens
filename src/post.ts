import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import type { SystemInfo, StepMetrics } from './types';
import { stopCollectorAndFlush } from './collector';
import { parseConfig } from './config';
import { loadSamples } from './metrics-jsonl';
import { processMetrics } from './reporter';
import { safePct } from './stats';
import { fetchSteps, correlateSteps, type FetchStepsResult } from './steps';

import { buildJobSummary } from './job-summary';
import {
  DATA_DIR, SYSINFO_FILE, START_TS_FILE, STATE,
} from './constants';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function loadSystemInfo(): SystemInfo {
  try {
    if (fs.existsSync(SYSINFO_FILE))
      return JSON.parse(fs.readFileSync(SYSINFO_FILE, 'utf-8'));
  } catch { /* fallback */ }
  const cpus = os.cpus();
  return {
    cpu_count: cpus.length,
    cpu_model: cpus[0]?.model ?? 'unknown',
    total_memory_mb: Math.round(os.totalmem() / (1024 * 1024)),
    os_release: 'unknown', kernel: 'unknown',
    runner_name: process.env.RUNNER_NAME ?? 'unknown',
    runner_os: process.env.RUNNER_OS ?? 'unknown',
    runner_arch: process.env.RUNNER_ARCH ?? 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    if (core.getState(STATE.ACTIVE) !== 'true') {
      core.info('RunnerLens: monitoring was not active — nothing to report');
      return;
    }

    const config  = parseConfig();

    // ── Stop collector & flush ────────────────────────────
    await stopCollectorAndFlush();

    // ── Load data ─────────────────────────────────────────
    const samples = await loadSamples();
    const sysInfo = loadSystemInfo();

    if (samples.length === 0) {
      core.warning('RunnerLens: no samples collected');
      return;
    }

    // ── Fetch per-step data (needs actions:read permission) ──
    let steps: StepMetrics[] | undefined;
    let fetchResult: FetchStepsResult = { steps: [] };
    if (config.githubToken) {
      try {
        fetchResult = await fetchSteps(config.githubToken);
        if (fetchResult.steps.length > 0) {
          steps = correlateSteps(fetchResult.steps, samples);
          core.info(`RunnerLens: correlated ${steps.length} steps`);
        }
      } catch (e) {
        core.debug(`RunnerLens: step fetch failed — ${e}`);
      }
    }

    // ── Duration (prefer GitHub API job start time for accuracy) ──
    let dur: number;
    if (fetchResult.jobStartedAt) {
      const jobStartMs = new Date(fetchResult.jobStartedAt).getTime();
      dur = Math.round((Date.now() - jobStartMs) / 1000);
    } else {
      let startTs = Date.now();
      try {
        if (fs.existsSync(START_TS_FILE))
          startTs = parseInt(fs.readFileSync(START_TS_FILE, 'utf-8').trim(), 10);
      } catch { /* ok */ }
      dur = Math.round((Date.now() - startTs) / 1000);
    }

    core.info(`RunnerLens: ${samples.length} samples over ${dur}s`);

    // ── Process ───────────────────────────────────────────
    const { report } = processMetrics(samples, sysInfo, dur, steps);

    // ── Outputs ───────────────────────────────────────────
    core.setOutput('cpu-avg', report.cpu.avg.toFixed(1));
    core.setOutput('cpu-max', report.cpu.max.toFixed(1));
    core.setOutput('mem-avg-mb', report.memory.avg.toFixed(0));
    core.setOutput('mem-max-mb', report.memory.max.toFixed(0));
    core.setOutput('mem-avg-pct',
      safePct(report.memory.avg, report.memory.total_mb).toFixed(1));
    core.setOutput('samples', report.sample_count.toString());
    core.setOutput('duration-seconds', dur.toString());
    // Omit timeline arrays from the output to stay under GitHub's 1MB
    // per-output limit. The full report (with timeline) is in the artifact.
    const { timeline: _tl, ...outputReport } = report;
    core.setOutput('report-json', JSON.stringify(outputReport));

    // ── Upload report artifact (opt-in) ────────────────
    if (core.getInput('upload-artifact').toLowerCase() === 'true') {
      try {
        const jobName = process.env.GITHUB_JOB || 'job';
        const artifactName = `runner-lens-${jobName}`;
        const reportFile = path.join(DATA_DIR, 'report.json');
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        const artClient = new DefaultArtifactClient();
        await artClient.uploadArtifact(artifactName, [reportFile], DATA_DIR);
        core.info(`RunnerLens: uploaded artifact "${artifactName}"`);
      } catch (e) {
        core.warning(`RunnerLens: artifact upload failed — ${e}`);
      }
    }

    // ── Job Summary ─────────────────────────────────────
    try {
      const summaryHtml = await buildJobSummary(report, config.sampleInterval);
      await core.summary.addRaw(summaryHtml).write();
    } catch (e) {
      core.debug(`RunnerLens: job summary failed — ${e}`);
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`RunnerLens: report failed — ${msg}`);
  } finally {
    // ── Cleanup temp files (including rotated .1) ─────────
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

run();
