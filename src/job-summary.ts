// ─────────────────────────────────────────────────────────────
// RunnerLens — Job Summary Builder
//
// All visuals (stat cards, CPU/Memory line charts, Gantt
// execution timeline) are rendered by the LeanCI chart service
// (leanci/chart) — Chart.js v4 configs sent as pure JSON.
// ─────────────────────────────────────────────────────────────

import type { AggregatedReport } from './types';
import { fmtDuration, safeMax, safeMin } from './stats';

// ── Chart service client ─────────────────────────────────────

export interface ChartServiceOptions {
  /** Base URL of the chart service, e.g. https://chart.leanci.dev */
  url: string;
  apiKey: string;
}

interface RunContext {
  owner: string;
  repo: string;
  runId: string;
}

function runContext(): RunContext | undefined {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const [owner, repo] = repository.split('/');
  if (!owner || !repo || !runId) return undefined;
  return { owner, repo, runId };
}

/**
 * Client for the chart service. A missing/invalid LeanCI API key is not
 * an error — the service falls back to the free tier (14-day image
 * retention); a valid key selects the paid tier (90 days).
 */
class ChartClient {
  constructor(private readonly svc: ChartServiceOptions) {}

  async create(
    chart: Record<string, unknown>,
    width: number,
    height: number,
  ): Promise<string> {
    const run = runContext();
    const body = JSON.stringify({
      chart,
      width,
      height,
      devicePixelRatio: 2,
      backgroundColor: CHART_BG,
      ...(run ? { run } : {}),
    });

    const endpoint = `${this.svc.url.replace(/\/+$/, '')}/v1/charts`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.svc.apiKey ? { 'x-api-key': this.svc.apiKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`chart service returned ${res.status}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) {
      throw new Error('chart service response missing url');
    }
    return data.url;
  }
}

// ── Palette ──────────────────────────────────────────────────

const CHART_BG = '#ffffff';
const TICK = '#656d76';
const TITLE_COLOR = '#1f2328';
const CPU_COLOR = '#2f81f7';
const CPU_FILL = 'rgba(47,129,247,0.10)';
const CPU_USER_COLOR = '#3fb950';
const CPU_SYS_COLOR = '#f0883e';
const MEM_COLOR = '#8250df';
const MEM_FILL = 'rgba(130,80,223,0.10)';
const MEM_CACHED_COLOR = '#58a6ff';
const MEM_SWAP_COLOR = '#da3633';

function fmtMem(mb: number): string {
  return `${(mb / 1024).toFixed(2)} GB`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortOsName(release: string): string {
  // "Ubuntu 22.04.3 LTS" → "Ubuntu 22.04"
  const m = release.match(/^(\S+)\s+([\d]+\.[\d]+)/);
  if (m) return `${m[1]} ${m[2]}`;
  return release.length > 18 ? release.slice(0, 15) + '...' : release;
}

function shortCpuModel(model: string): string {
  // "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz" → "Xeon Platinum 8370C"
  // "AMD EPYC 7763 64-Core Processor" → "EPYC 7763"
  let s = model
    .replace(/\(R\)/gi, '')
    .replace(/\(TM\)/gi, '')
    .replace(/\s*\d+-Core Processor$/i, '')
    .replace(/\s*with\s+.*$/i, '')
    .replace(/\s+@\s+[\d.]+GHz$/i, '')
    .replace(/\s+CPU$/i, '')
    .replace(/^Intel\s+/i, '')
    .replace(/^AMD\s+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > 24) s = s.slice(0, 21) + '...';
  return s;
}

// ── Stat Cards (rendered as image via chartjs-plugin-annotation) ──

function buildStatCardsConfig(report: AggregatedReport): Record<string, unknown> {
  const runnerValue = report.system.os_release !== 'unknown'
    ? shortOsName(report.system.os_release)
    : `${report.system.runner_os} (${report.system.runner_arch})`;
  const cpuModel = shortCpuModel(report.system.cpu_model);
  const runnerSub = `${cpuModel} · ${report.system.cpu_count} vCPU · ${fmtMem(report.system.total_memory_mb)}`;

  const cards = [
    { accent: '#3fb950', label: 'RUNNER', value: runnerValue, sub: runnerSub },
    { accent: '#58a6ff', label: 'DURATION', value: fmtDuration(report.duration_seconds), sub: `${report.started_at.slice(11, 19)} — ${report.ended_at.slice(11, 19)} UTC` },
    { accent: '#f0883e', label: 'CPU', value: `avg ${report.cpu.avg.toFixed(1)}%`, sub: `peak ${report.cpu.max.toFixed(1)}%` },
    { accent: '#bc8cff', label: 'MEMORY', value: `avg ${fmtMem(report.memory.avg)}`, sub: `peak ${fmtMem(report.memory.max)} / ${fmtMem(report.memory.total_mb)}` },
  ];

  const annotations: Record<string, unknown> = {};

  cards.forEach((c, i) => {
    const xMin = i + 0.03;
    const xMax = i + 0.97;
    const xMid = i + 0.5;

    // Card background
    annotations[`bg${i}`] = {
      type: 'box', xMin, xMax, yMin: 0, yMax: 1,
      backgroundColor: '#f6f8fa', borderColor: '#d0d7de', borderWidth: 1, borderRadius: 6,
    };
    // Colored accent bar at top
    annotations[`ac${i}`] = {
      type: 'box', xMin, xMax, yMin: 0.94, yMax: 1.0,
      backgroundColor: c.accent, borderWidth: 0, borderRadius: { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 },
    };
    // Label
    annotations[`lb${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.74,
      content: [c.label], color: '#656d76', font: { size: 11 },
    };
    // Value
    annotations[`vl${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.47,
      content: [c.value], color: '#1f2328', font: { size: 17, weight: 'bold' },
    };
    // Sub-text
    annotations[`sb${i}`] = {
      type: 'label', xValue: xMid, yValue: 0.18,
      content: [c.sub], color: '#8b949e', font: { size: 10 },
    };
  });

  return {
    type: 'scatter',
    data: { datasets: [{ data: [] }] },
    options: {
      layout: { padding: 0 },
      scales: {
        x: { display: false, min: -0.05, max: 4.05 },
        y: { display: false, min: -0.12, max: 1.12 },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        annotation: { annotations },
      },
    },
  };
}

async function buildStatCardsImage(
  report: AggregatedReport,
  client: ChartClient,
): Promise<string> {
  const url = await client.create(buildStatCardsConfig(report), 1024, 100);
  return `<img src="${url}" alt="Runner Stats" width="100%">`;
}

// ── CPU/Memory Charts ────────────────────────────────────────

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const result: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const lo = Math.floor(i * step);
    const hi = Math.min(Math.floor((i + 1) * step), values.length);
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += values[j];
    result.push(Math.round((sum / (hi - lo)) * 10) / 10);
  }
  return result;
}

function timeLabels(startedAt: string, endedAt: string, count: number): string[] {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const labels: string[] = [];
  const labelInterval = Math.max(1, Math.ceil(count / 8));
  for (let i = 0; i < count; i++) {
    const t = new Date(start + ((end - start) * i) / Math.max(count - 1, 1));
    const hh = t.getUTCHours().toString().padStart(2, '0');
    const mm = t.getUTCMinutes().toString().padStart(2, '0');
    const ss = t.getUTCSeconds().toString().padStart(2, '0');
    if (i % labelInterval === 0 || i === count - 1) {
      labels.push(`${hh}:${mm}:${ss}`);
    } else {
      labels.push('');
    }
  }
  return labels;
}

const STEP_LINE_COLOR = '#d0d7de';
const STEP_BAND_COLORS = [
  'rgba(47,129,247,0.10)',   // blue
  'rgba(63,185,80,0.10)',    // green
  'rgba(240,136,62,0.10)',   // orange
  'rgba(130,80,223,0.10)',   // purple
  'rgba(219,55,100,0.10)',   // pink
  'rgba(31,111,139,0.10)',   // teal
];

interface ExtraLineDataset {
  label: string;
  data: unknown[];
  color: string;
}

function extraLineDataset(e: ExtraLineDataset): Record<string, unknown> {
  return {
    label: e.label,
    data: e.data,
    borderColor: e.color,
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.4,
    pointRadius: 0,
    borderWidth: 1.5,
    borderDash: [4, 3],
  };
}

function buildChartConfig(
  title: string,
  values: number[],
  labels: string[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
  extraLines?: ExtraLineDataset[],
): Record<string, unknown> {
  const extraDS = (extraLines ?? []).map(extraLineDataset);
  const hasExtra = extraDS.length > 0;
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: hasExtra ? 'total' : title,
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2,
      }, ...extraDS],
    },
    options: {
      plugins: {
        legend: hasExtra
          ? { display: true, labels: { boxHeight: 0, boxWidth: 14, font: { size: 10 } } }
          : { display: false },
        title: {
          display: true,
          text: title,
          color: TITLE_COLOR,
          font: { size: 14, weight: 'bold' },
          padding: { bottom: 12 },
        },
      },
      scales: {
        x: {
          ticks: { color: TICK, font: { size: 11 }, maxRotation: 0, autoSkipPadding: 20 },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { color: TICK, font: { size: 11 } },
          grid: { color: '#eff2f5' },
          border: { display: false },
          title: { display: true, text: yAxisLabel, color: TICK, font: { size: 12 } },
        },
      },
      layout: { padding: { top: 4, right: 16, bottom: 4, left: 4 } },
    },
  };
}

/**
 * Time-axis line chart with step band annotations. Tick formatting uses
 * the chart service's declarative $format option (no code in configs).
 */
function buildSteppedChartConfig(
  title: string,
  dataPoints: { x: number; y: number }[],
  lineColor: string,
  fillColor: string,
  yAxisLabel: string,
  xMin: number,
  xMax: number,
  steps: { name: string; startMs: number; endMs: number }[],
  yMax?: number,
  extraLines?: ExtraLineDataset[],
): Record<string, unknown> {
  const yValues = dataPoints.map((p) => p.y);
  const dataMax = yValues.length > 0 ? Math.max(...yValues) : 100;
  const chartYMax = yMax ?? dataMax * 1.15;
  const xRange = xMax - xMin;

  const annotations: Record<string, unknown> = {};
  steps.forEach((step, i) => {
    const name = step.name.length > 20 ? step.name.slice(0, 17) + '...' : step.name;

    // Colored background band per step
    annotations[`sb${i}`] = {
      type: 'box', xMin: step.startMs, xMax: step.endMs,
      backgroundColor: STEP_BAND_COLORS[i % STEP_BAND_COLORS.length],
      borderWidth: 0, drawTime: 'beforeDatasetsDraw',
    };
    // Vertical dashed line at step start
    annotations[`sl${i}`] = {
      type: 'line', xMin: step.startMs, xMax: step.startMs,
      borderColor: STEP_LINE_COLOR, borderWidth: 1, borderDash: [4, 4],
    };
    // Step name label — vertical, positioned in upper portion of band
    annotations[`sn${i}`] = {
      type: 'label', xValue: (step.startMs + step.endMs) / 2, yValue: chartYMax * 0.62,
      content: [name], color: '#1f2328', font: { size: 9, weight: 'bold' },
      rotation: -90, padding: { top: 2, bottom: 2, left: 3, right: 3 },
      backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 3,
    };
  });

  const extraDS = (extraLines ?? []).map((e) => ({ ...extraLineDataset(e), clip: false }));

  return {
    type: 'line',
    data: {
      datasets: [{
        label: extraDS.length > 0 ? 'total' : title,
        data: dataPoints,
        borderColor: lineColor,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        borderWidth: 2,
        clip: false,
      }, ...extraDS],
    },
    options: {
      plugins: {
        legend: extraDS.length > 0
          ? { display: true, labels: { boxHeight: 0, boxWidth: 14, font: { size: 10 } } }
          : { display: false },
        title: {
          display: true, text: title, color: TITLE_COLOR,
          font: { size: 14, weight: 'bold' }, padding: { bottom: 12 },
        },
        annotation: { annotations },
      },
      scales: {
        x: {
          type: 'linear',
          min: xMin - xRange * 0.01,
          max: xMax + xRange * 0.01,
          ticks: {
            color: TICK, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 20,
            $format: 'utc-hms',
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          max: chartYMax,
          ticks: { color: TICK, font: { size: 11 } },
          grid: { color: '#eff2f5' },
          border: { display: false },
          title: { display: true, text: yAxisLabel, color: TICK, font: { size: 12 } },
        },
      },
      layout: { padding: { top: 12, right: 16, bottom: 4, left: 4 } },
    },
  };
}

interface ExtraLine {
  label: string;
  values: number[];
  color: string;
}

async function buildLineChart(
  client: ChartClient,
  title: string,
  values: number[],
  yLabel: string,
  lineColor: string,
  fillColor: string,
  startedAt: string,
  endedAt: string,
  steps?: { name: string; started_at: string; completed_at: string }[],
  yMax?: number,
  extraLines?: ExtraLine[],
): Promise<string> {
  const maxPts = 30;
  const data = downsample(values, maxPts);
  const chartStartMs = new Date(startedAt).getTime();
  const chartEndMs = new Date(endedAt).getTime();

  const extras = (extraLines ?? []).map((l) => ({
    label: l.label,
    data: downsample(l.values, maxPts),
    color: l.color,
  }));

  let config: Record<string, unknown>;
  let height: number;

  if (steps && steps.length > 0) {
    // ── Steps present: linear time axis so ALL steps are visible ──
    const toXY = (d: number[]): { x: number; y: number }[] => d.map((v, i) => ({
      x: chartStartMs + (chartEndMs - chartStartMs) * i / Math.max(d.length - 1, 1),
      y: v,
    }));

    const totalRange = chartEndMs - chartStartMs;
    const minStepMs = totalRange * 0.015;

    // Axis range is locked to the data range — step bands that extend
    // beyond the first/last sample are clipped by Chart.js, avoiding
    // empty space on either side of the chart.
    const stepRegions = steps
      .filter((s) => s.started_at && s.completed_at)
      .map((s) => {
        const sMs = new Date(s.started_at).getTime();
        const eMs = new Date(s.completed_at).getTime();
        return {
          name: s.name,
          startMs: sMs,
          endMs: eMs <= sMs ? sMs + minStepMs : eMs,
        };
      });

    const extraXY = extras.map((e) => ({ label: e.label, data: toXY(e.data), color: e.color }));

    config = buildSteppedChartConfig(
      title, toXY(data), lineColor, fillColor, yLabel,
      chartStartMs, chartEndMs, stepRegions, yMax, extraXY,
    );
    height = 300;
  } else {
    // ── No steps: category axis with pre-formatted labels ──
    const labels = timeLabels(startedAt, endedAt, data.length);
    config = buildChartConfig(title, data, labels, lineColor, fillColor, yLabel, extras);
    height = 250;
  }

  const url = await client.create(config, 1024, height);
  return `<img src="${url}" alt="${esc(title)}" width="100%">`;
}

// ── Gantt Timeline (horizontal bar chart) ────────────────────

interface GanttJob {
  jobName: string;
  steps: { name: string; started_at: string; completed_at: string }[];
}

const GANTT_COLOR = '#2f81f7';

function collectGanttSteps(report: AggregatedReport): GanttJob | null {
  if (report.steps && report.steps.length > 0) {
    return { jobName: process.env.GITHUB_JOB || 'Job', steps: report.steps };
  }
  return null;
}

function buildGanttChartConfig(ganttJob: GanttJob): Record<string, unknown> {
  interface Row { label: string; startMs: number; endMs: number; durStr: string }
  const rows: Row[] = ganttJob.steps.map((step) => {
    const label = step.name.length > 28 ? step.name.slice(0, 25) + '...' : step.name;
    const startMs = new Date(step.started_at).getTime();
    const endMs = new Date(step.completed_at).getTime();
    return { label, startMs, endMs, durStr: fmtDuration(Math.round((endMs - startMs) / 1000)) };
  });

  const globalMin = safeMin(rows.map((r) => r.startMs));
  const globalMax = safeMax(rows.map((r) => r.endMs));
  const range = globalMax - globalMin || 1;
  // Just enough to render a visible sliver for 0-duration steps
  const minBarWidth = range * 0.003;
  const durLabelPad = range * 0.10;

  const annotations: Record<string, unknown> = {};

  rows.forEach((row, i) => {
    // Alternating row backgrounds
    annotations[`tr${i}`] = {
      type: 'box', drawTime: 'beforeDatasetsDraw',
      xMin: globalMin, xMax: globalMax, yMin: i - 0.5, yMax: i + 0.5,
      backgroundColor: i % 2 === 0 ? '#f6f8fa' : '#eff2f5', borderWidth: 0,
    };
    // Duration labels on right
    annotations[`du${i}`] = {
      type: 'label', drawTime: 'afterDatasetsDraw',
      xValue: globalMax + durLabelPad * 0.5, yValue: i,
      content: [row.durStr], color: TICK, font: { size: 10 },
    };
  });

  return {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        data: rows.map((r) => {
          const width = r.endMs - r.startMs;
          const end = width < minBarWidth ? r.startMs + minBarWidth : r.endMs;
          return [r.startMs, end];
        }),
        backgroundColor: rows.map(() => GANTT_COLOR),
        borderWidth: 0,
        borderRadius: 4,
        borderSkipped: false,
        barPercentage: 0.7,
        categoryPercentage: 1.0,
      }],
    },
    options: {
      indexAxis: 'y',
      plugins: {
        legend: { display: false },
        title: {
          display: true, text: 'Execution Timeline', color: TITLE_COLOR,
          font: { size: 14, weight: 'bold' }, padding: { bottom: 8 },
        },
        annotation: { annotations },
      },
      scales: {
        x: {
          type: 'linear',
          min: globalMin - range * 0.01,
          max: globalMax + durLabelPad,
          ticks: {
            color: TICK, font: { size: 10 }, maxRotation: 0,
            // Hide ticks in the duration-label gutter beyond the last bar
            $format: 'utc-hms',
            $hideAbove: globalMax,
          },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          ticks: { color: TICK, font: { size: 11 }, padding: 6 },
          grid: { display: false },
          border: { display: false },
        },
      },
      layout: { padding: { right: 8, left: 4, top: 4, bottom: 4 } },
    },
  };
}

async function buildGanttChart(
  ganttJob: GanttJob,
  client: ChartClient,
): Promise<string> {
  const height = Math.max(160, Math.min(700, 56 + ganttJob.steps.length * 26));
  const url = await client.create(buildGanttChartConfig(ganttJob), 1024, height);
  return `<img src="${url}" alt="Execution Timeline" width="100%">`;
}

// ── Helpers: per-job section ─────────────────────────────────

async function buildJobSection(
  report: AggregatedReport,
  sampleInterval: number,
  client: ChartClient,
): Promise<string> {
  const parts: string[] = [];

  // Stat cards
  try {
    parts.push(await buildStatCardsImage(report, client));
  } catch {
    // Best-effort: skip the stat cards if the chart service is unavailable
  }

  // CPU + Memory charts
  // Filter out steps whose duration is <= the scrape interval
  // (they are too short to meaningfully display on the chart)
  const chartSteps = report.steps?.filter((s) => {
    const durSec = (new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()) / 1000;
    return durSec > sampleInterval;
  });
  const timeline = report.timeline;
  if (timeline && timeline.cpu_pct.length >= 2) {
    try {
      parts.push(await buildLineChart(
        client,
        'CPU Usage (%)', timeline.cpu_pct, 'CPU %',
        CPU_COLOR, CPU_FILL,
        report.started_at, report.ended_at,
        chartSteps, 100,
        [
          { label: 'user', values: timeline.cpu_user, color: CPU_USER_COLOR },
          { label: 'nice', values: timeline.cpu_nice, color: '#d2a8ff' },
          { label: 'system', values: timeline.cpu_system, color: CPU_SYS_COLOR },
        ],
      ));
      const toGb = (v: number): number => Math.round((v / 1024) * 100) / 100;
      const memGb = timeline.mem_mb.map(toGb);
      parts.push(await buildLineChart(
        client,
        'Memory Usage (GB)', memGb, 'GB',
        MEM_COLOR, MEM_FILL,
        report.started_at, report.ended_at,
        chartSteps, toGb(report.memory.total_mb),
        [
          { label: 'cached', values: timeline.mem_cached_mb.map(toGb), color: MEM_CACHED_COLOR },
          { label: 'swap', values: timeline.mem_swap_mb.map(toGb), color: MEM_SWAP_COLOR },
        ],
      ));
    } catch {
      // Best-effort: skip charts on failure
    }
  }

  return parts.join('\n\n');
}

// ── Public API ───────────────────────────────────────────────

export async function buildJobSummary(
  report: AggregatedReport,
  sampleInterval: number,
  svc: ChartServiceOptions,
): Promise<string> {
  const parts: string[] = [];
  const client = new ChartClient(svc);

  parts.push(await buildJobSection(report, sampleInterval, client));

  // Gantt timeline
  const ganttJob = collectGanttSteps(report);
  if (ganttJob) {
    try {
      parts.push(await buildGanttChart(ganttJob, client));
    } catch {
      // Best-effort: skip the timeline if the chart service is unavailable
    }
  }

  return parts.join('\n\n');
}
