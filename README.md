# 📊 RunnerLens

**Zero-config observability for GitHub Actions runners.**

Drop RunnerLens into any workflow and get CPU and memory metrics with charts in your Job Summary — no infrastructure required.

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

That's it. When the job finishes, you'll see a resource report in the **Job Summary** tab. The post step runs with `post-if: always()`, so the report still runs if earlier steps fail. For per-step breakdown in the summary, add `permissions: actions: read` on the job (and keep the default `github-token`).

## What You Get

- **CPU and memory** — averages, min/max, and timeline charts in the Summary (via [QuickChart.io](https://quickchart.io))
- **Load averages** in the aggregated report
- **Per-step correlation** — when the token can read workflow steps (`actions: read`)
- **Collector overhead** — RunnerLens’ own CPU/memory footprint in samples
- **Optional artifact** — full `report.json` when `upload-artifact` is `true` (default)

## Inputs

| Input | Default | Description |
|---|---|---|
| `sample-interval` | `5` | Seconds between samples (1–60) |
| `github-token` | `${{ github.token }}` | Token for per-step metrics |
| `max-file-size` | `100` | Max metrics file size in MB before rotation (0 = unlimited) |
| `upload-artifact` | `true` | Upload report as a workflow artifact |

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
| `report-json` | `{...}` | Report JSON (timeline arrays omitted for size; full report is in the artifact when upload is on) |

### Using Outputs

RunnerLens sets outputs in its **post** step (after your other steps finish), so you cannot read `steps.<id>.outputs.*` from another step in the **same** job. Expose them as **job outputs**, then consume them from a **downstream job** with `needs`:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      cpu_avg: ${{ steps.lens.outputs['cpu-avg'] }}
      samples: ${{ steps.lens.outputs.samples }}
    steps:
      - uses: runnerlens/runner-lens@v1
        id: lens
      - run: npm ci && npm test

  after:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "CPU avg: ${{ needs.build.outputs.cpu_avg }}"
          echo "Samples: ${{ needs.build.outputs.samples }}"
```

Use bracket form for hyphenated step output names, e.g. `steps.lens.outputs['cpu-avg']`.

## Architecture

RunnerLens uses a two-phase design:

1. **Main step** — spawns a lightweight bash collector as a detached background process
2. **Post step** (`post-if: always()`) — stops the collector, aggregates data, writes the Job Summary, sets outputs, optional artifact

The bash collector reads from `/proc` or cgroup metrics on Linux. It outputs one JSON line per sample to a temp file.

### File Rotation

For long-running jobs, the collector rotates the metrics file when it exceeds `max-file-size` MB. The post step reads rotated and current files, sorts samples chronologically, and produces a single report.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  main step  │────▶│  collect.sh  │────▶│  metrics.jsonl │
│  (spawn)    │     │  (detached)  │     │  (JSONL /proc) │
└─────────────┘     └──────────────┘     └────────────────┘
                                                │
┌─────────────┐     ┌──────────────┐            │
│  post step  │────▶│  reporter.ts │◀───────────┘
│  (always)   │     │  (aggregate) │
└─────────────┘     └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        Job Summary    Outputs    Artifact (optional)
```

## Development

```bash
npm ci
npm run typecheck    # TypeScript strict mode
npm test             # Jest with coverage
npm run build        # node scripts/bundle.js → dist/ (esbuild JS API; PATH-safe)
```

### Project Structure

```
├── action.yml
├── scripts/
│   ├── collect.sh           # Bash metrics collector
│   └── bundle.js            # esbuild → dist/main + dist/post
├── src/
│   ├── main.ts                # Entry: spawn collect.sh, write state
│   ├── post.ts                # Post: stop collector, outputs, artifact, summary
│   ├── collector.ts           # SIGTERM collector and wait for flush
│   ├── config.ts              # Parse and validate action inputs
│   ├── constants.ts           # Data paths and state keys
│   ├── job-summary.ts         # Job Summary markdown and charts
│   ├── metrics-jsonl.ts       # Stream / merge rotated JSONL samples
│   ├── quickchart-client.ts   # QuickChart.io chart URLs
│   ├── reporter.ts            # Aggregate samples into report object
│   ├── stats.ts               # Averages, min/max, safe percentages
│   ├── steps.ts               # GitHub API: fetch and correlate steps
│   └── types.ts               # Shared TypeScript types
├── dist/                    # Bundled JS (checked in)
├── __tests__/
└── .github/workflows/ci.yml
```

## License

MIT
