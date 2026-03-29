import * as fs from 'fs';
import * as readline from 'readline';
import type { MetricSample } from './types';
import { METRICS_FILE } from './constants';

function tryPushMetricLine(line: string, samples: MetricSample[]): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null &&
      typeof (parsed as MetricSample).timestamp === 'number' &&
      (parsed as MetricSample).cpu && typeof (parsed as MetricSample).cpu.usage === 'number' &&
      (parsed as MetricSample).memory && typeof (parsed as MetricSample).memory.used_mb === 'number'
    ) {
      samples.push(parsed as MetricSample);
    }
  } catch {
    /* skip malformed lines */
  }
}

/**
 * Stream one JSONL file line-by-line (avoids holding the entire file in memory).
 */
async function appendSamplesFromFile(filePath: string, samples: MetricSample[]): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      tryPushMetricLine(line, samples);
    }
  } finally {
    rl.close();
  }
}

/**
 * Load JSONL samples from the metrics file AND the rotated .1 file.
 *
 * The v2 collector rotates metrics.jsonl → metrics.jsonl.1 when it
 * exceeds --max-size. We read .1 first (older data) then the main
 * file (newer data) so samples are in chronological order.
 */
export async function loadSamples(): Promise<MetricSample[]> {
  const files = [`${METRICS_FILE}.1`, METRICS_FILE].filter((f) =>
    fs.existsSync(f),
  );

  const samples: MetricSample[] = [];
  for (const file of files) {
    await appendSamplesFromFile(file, samples);
  }

  samples.sort((a, b) => a.timestamp - b.timestamp);
  return samples;
}
