# 📊 RunnerLens

**Zero-config observability for GitHub Actions runners.**

Drop RunnerLens into any workflow and get CPU and memory metrics with charts directly in your Job Summary — no infrastructure required.

## Quick Start

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: runnerlens/runner-lens@v1   # ← add this line
      - uses: actions/checkout@v4
      - run: npm ci && npm test
```

That's it. When the job finishes, you'll see a resource report in the **Job Summary** tab.

## What You Get

- **Stat cards** — runner specs, job duration, CPU and memory averages/peaks
- **CPU chart** — total usage with user/nice/system breakdown over time
- **Memory chart** — usage with cache and swap breakdown over time
- **Per-Step Breakdown** — step bands overlaid on the charts plus a Gantt execution timeline (requires `actions: read` permission)
- **Report artifact** — the full aggregated report as `report.json`, including complete metric timelines (CPU idle/iowait/steal, memory available/usage %, 1/5/15-minute load averages)

Charts are rendered as PNG images via [QuickChart.io](https://quickchart.io). Chart configurations (metric values, step names, and timings) are sent to QuickChart and the resulting images are hosted there.

## Inputs

| Input | Default | Description |
|---|---|---|
| `sample-interval` | `5` | Seconds between samples (1–60) |
| `github-token` | `${{ github.token }}` | GitHub token for per-step metrics |
| `max-file-size` | `100` | Max metrics file size in MB before rotation (0 = unlimited) |
| `upload-artifact` | `true` | Upload the aggregated report as a workflow artifact |

## Outputs

| Output | Example | Description |
|---|---|---|
| `cpu-avg` | `34.2` | Average CPU usage % |
| `cpu-max` | `87.1` | Peak CPU usage % |
| `mem-avg-mb` | `2048` | Average memory usage (MB) |
| `mem-max-mb` | `3584` | Peak memory usage (MB) |
| `mem-avg-pct` | `56.3` | Average memory usage % |
| `samples` | `120` | Number of samples collected |
| `duration-seconds` | `360` | Monitoring wall-clock duration |
| `report-json` | `{...}` | Aggregated report as JSON (timelines omitted to stay under GitHub's 1 MB output limit — the full report is in the artifact) |

### Using Outputs

```yaml
- uses: runnerlens/runner-lens@v1
  id: lens

- run: npm ci && npm test

- name: Fail if peak CPU was critically high
  if: always()
  run: |
    cpu_max="${{ steps.lens.outputs.cpu-max }}"
    if (( $(echo "$cpu_max > 95" | bc -l) )); then
      echo "::error::Peak CPU was ${cpu_max}%"
      exit 1
    fi
```

## Architecture

RunnerLens uses a two-phase design:

1. **Main step** — spawns a lightweight bash collector as a detached background process
2. **Post step** (`post-if: always()`) — stops the collector, aggregates data, writes the Job Summary, and uploads the report artifact

The bash collector reads from cgroup v2 when available (containers) and falls back to `/proc` (VMs), with <0.5% CPU overhead. It outputs one JSON line per sample to a temp file, and also records its own CPU/memory footprint with every sample.

Monitoring is best-effort by design: any failure is logged as a warning and never fails your workflow.

### File Rotation

For long-running jobs (multi-hour builds on self-hosted runners), the collector automatically rotates the metrics file when it exceeds `max-file-size` MB. The TypeScript post-processor reads both the rotated and current files, sorts samples chronologically, and produces a single unified report.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  main step  │────▶│  collect.sh  │────▶│  metrics.jsonl │
│  (spawn)    │     │  (detached)  │     │ (JSONL samples)│
└─────────────┘     └──────────────┘     └────────────────┘
                                                │
┌─────────────┐     ┌──────────────┐            │
│  post step  │────▶│  reporter.ts │◀───────────┘
│  (always)   │     │  (aggregate) │
└─────────────┘     └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        Job Summary    Outputs    report.json artifact
```

## The Report Artifact

With `upload-artifact: true` (the default), each job uploads a `runner-lens-<job>` artifact containing `report.json`: system info, aggregate CPU/memory/load statistics, per-step metrics, and full per-sample timelines (`cpu_pct`, `cpu_user`, `cpu_nice`, `cpu_system`, `cpu_idle`, `cpu_iowait`, `cpu_steal`, `mem_mb`, `mem_available_mb`, `mem_cached_mb`, `mem_swap_mb`, `mem_usage_pct`, `load_1m`, `load_5m`, `load_15m`). This is the data contract for downstream tooling such as the upcoming RunnerLens SaaS dashboard (historical trends, right-sizing recommendations, and cost analytics).

## Development

```bash
npm ci
npm run typecheck    # TypeScript strict mode
npm test             # Jest with coverage
npm run build        # esbuild → dist/ (checked in — rebuild after src changes)
```

### Project Structure

```
├── action.yml                 # GitHub Action definition
├── scripts/collect.sh         # Bash collector (cgroup v2 + /proc)
├── src/
│   ├── main.ts                # Entry: spawn collector
│   ├── post.ts                # Post: stop, aggregate, report
│   ├── config.ts              # Input parsing & validation
│   ├── constants.ts           # Shared paths & state keys
│   ├── types.ts               # All TypeScript interfaces
│   ├── stats.ts               # Stack-safe stats & formatting helpers
│   ├── steps.ts               # GitHub API step fetch & correlation
│   ├── reporter.ts            # Sample aggregation
│   └── job-summary.ts         # QuickChart-based Job Summary rendering
├── dist/                      # Bundled JS (checked in)
└── __tests__/                 # Jest test suite
```

## License

MIT
