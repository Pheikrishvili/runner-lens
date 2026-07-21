import * as core from '@actions/core';
import type { MonitorConfig } from './types';

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function intInput(name: string, fallback: number): number {
  const raw = core.getInput(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function parseConfig(): MonitorConfig {
  // Auto-detect: explicit input → GITHUB_TOKEN env.
  // ACTIONS_RUNTIME_TOKEN is intentionally excluded — it typically lacks
  // actions:read permission, producing confusing 403 errors.
  const githubToken = core.getInput('github-token')
    || process.env.GITHUB_TOKEN
    || '';

  return {
    sampleInterval: clamp(intInput('sample-interval', 5), 1, 60),
    maxSizeMb: Math.max(0, intInput('max-file-size', 100)),
    githubToken,
    chartUrl: core.getInput('chart-url') || 'https://chart.leanci.dev',
    apiKey: core.getInput('leanci-api-key'),
  };
}
