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
        with:
          leanci-api-key: ${{ secrets.LEANCI_API_KEY }}
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

Charts are rendered as PNG images by the **LeanCI chart service** — Chart.js v4 configs sent as pure JSON, images stored in LeanCI GCS buckets. Nothing is sent to third-party chart services — rendering runs on LeanCI's own infrastructure. Retention is tiered: without a `leanci-api-key` images live **14 days** (free tier); with a valid LeanCI API key, **90 days** (paid tier — matching GitHub's own log retention). The same key will unlock metric ingestion into the LeanCI dashboard.

## Data collection & privacy

Using RunnerLens sends some telemetry to LeanCI so it can render your charts and, for account holders, power your dashboards. In plain terms:

**What is collected**
- **Resource metrics** — CPU, memory, swap, load, and I/O timings sampled from the runner's kernel interfaces: **cgroup v2** on container-based runners, **`/proc`** on VM-based runners.
- **Job & step metadata** — your workflow's **job name and step names**, their durations, and pass/fail status.
- **Repository context** — the GitHub **owner/organization, repository name, and run ID** (used to organize your images and dashboards).
- **Runner specs** — OS, CPU model, core count, and memory size.

**What is never collected**
- Your **source code**, **secrets**, **environment variables**, **build logs**, file contents, or command output. RunnerLens reads kernel resource counters (cgroup/`/proc`) and the GitHub jobs API — never your code.

**Where it goes & how long it stays**
- Chart images (which visually contain the above) are stored in LeanCI's GCS buckets under random, hashed object names and **auto-deleted after 14 days** (free) or **90 days** (with an API key).
- With a `leanci-api-key`, the aggregated `report.json` is also ingested.

## Inputs

| Input | Default | Description |
|---|---|---|
| `sample-interval` | `5` | Seconds between samples (1–60) |
| `github-token` | `${{ github.token }}` | GitHub token for per-step metrics |
| `max-file-size` | `100` | Max metrics file size in MB before rotation (0 = unlimited) |
| `upload-artifact` | `true` | Upload the aggregated report as a workflow artifact |
| `chart-url` | `https://chart.leanci.dev` | Base URL of the LeanCI chart rendering service |
| `leanci-api-key` | `''` | LeanCI API key (store as a secret); empty = free tier, 14-day image retention |

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

RunnerLens sets its outputs (`cpu-avg`, `cpu-max`, etc.) from its **post step**,
which runs after every other step in the job has already finished. That means
outputs are never available to a later step *in the same job* — only to a
different job that declares `needs:` on this one, via `jobs.<job>.outputs`:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      cpu-max: ${{ steps.lens.outputs.cpu-max }}
    steps:
      - uses: runnerlens/runner-lens@v1
        id: lens
      - run: npm ci && npm test

  check-cpu:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Fail if peak CPU was critically high
        run: |
          cpu_max="${{ needs.build.outputs.cpu-max }}"
          if (( $(echo "$cpu_max > 95" | bc -l) )); then
            echo "::error::Peak CPU was ${cpu_max}%"
            exit 1
          fi
```

If you need the data within the same job instead, read `report-json`'s value
from `core.summary`/the uploaded artifact — that data is written before the
post step ends, but a same-job step still can't read it via `steps.*.outputs`.

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
│   └── job-summary.ts         # Job Summary rendering via the LeanCI chart service
├── dist/                      # Bundled JS (checked in)
└── __tests__/                 # Jest test suite
```

## License

MIT
