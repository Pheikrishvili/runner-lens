import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseConfig } from './config';
import { errMsg } from './errors';
import type { SystemInfo } from './types';
import {
  DATA_DIR, METRICS_FILE, PID_FILE, SYSINFO_FILE, START_TS_FILE,
  STATE,
} from './constants';

async function run(): Promise<void> {
  try {
    const cfg = parseConfig();

    // ── Prepare workspace ─────────────────────────────────
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(START_TS_FILE, Date.now().toString());

    // ── Resolve script path ───────────────────────────────
    // __dirname is dist/main/ after bundling → up two levels to action root
    const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'collect.sh');

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Collector script not found at ${scriptPath}`);
    }

    fs.chmodSync(scriptPath, 0o755);

    // ── Build arguments ───────────────────────────────────
    const args: string[] = [
      scriptPath,
      METRICS_FILE,
      cfg.sampleInterval.toString(),
      `--max-size=${cfg.maxSizeMb}`,
    ];

    // ── Spawn collector (detached, won't block the job) ───
    const child = spawn('sh', args, {
      detached: true,
      stdio: 'ignore',
    });

    // A ChildProcess emits 'error' when the binary can't be spawned at all
    // (e.g. no `sh` on the PATH). Without a listener Node re-throws it as an
    // uncaught exception *outside* this try/catch, which would fail the user's
    // job — exactly what this action promises never to do.
    child.on('error', (e) => {
      core.warning(`RunnerLens: collector could not be spawned — ${e.message}`);
    });

    child.unref();

    if (!child.pid) {
      throw new Error('Collector process did not start');
    }

    fs.writeFileSync(PID_FILE, child.pid.toString());

    // Brief delay then verify the process is still alive.
    // Catches immediate failures (bad shebang, missing /proc, etc.).
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(child.pid, 0); // signal 0 = existence check
    } catch {
      throw new Error(`Collector exited immediately (PID ${child.pid})`);
    }

    // The collector writes sysinfo.json before entering its loop,
    // so it's available after the 200ms health check above.
    let infoMsg = `RunnerLens: collector started (PID ${child.pid})`;
    try {
      if (fs.existsSync(SYSINFO_FILE)) {
        const si = JSON.parse(
          fs.readFileSync(SYSINFO_FILE, 'utf-8'),
        ) as Partial<SystemInfo>;
        infoMsg += ` · ${si.cpu_count} CPUs · ${si.total_memory_mb} MB RAM`;
      }
    } catch { /* best-effort: the banner is cosmetic */ }
    infoMsg += ` · sampling every ${cfg.sampleInterval}s`;
    core.info(infoMsg);

    // ── Persist state for the post step ───────────────────
    core.saveState(STATE.ACTIVE, 'true');

  } catch (err) {
    // Never fail the user's workflow — monitoring is best-effort.
    core.warning(`RunnerLens: failed to start monitoring — ${errMsg(err)}`);
  }
}

// `run` never rejects — every path is caught above — so nothing is left
// floating here; `void` states that intent for the linter.
void run();
