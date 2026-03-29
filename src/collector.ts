import * as core from '@actions/core';
import * as fs from 'fs';
import { PID_FILE } from './constants';

/** Wall-clock wait after SIGTERM so the shell collector can flush its last sample. */
const FLUSH_AFTER_SIGTERM_MS = 1200;

/**
 * Stop the detached metrics collector (process group from `main.ts`).
 */
function stopCollector(): void {
  try {
    if (!fs.existsSync(PID_FILE)) return;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (pid > 0) {
      // Kill the entire process group (collector + child awk/ps/df).
      // The collector is spawned with { detached: true } so it's a
      // process group leader and -pid targets the whole group.
      try { process.kill(-pid, 'SIGTERM'); } catch {
        // If group kill fails (e.g. not a group leader), fall back to
        // killing just the parent process.
        try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
      }
      core.info(`RunnerLens: collector stopped (PID ${pid})`);
    }
  } catch (e) {
    core.debug(`RunnerLens: stop error — ${e}`);
  }
}

/**
 * Signal the collector to exit, then wait for flush/close of metrics file.
 */
export async function stopCollectorAndFlush(): Promise<void> {
  stopCollector();
  await new Promise((r) => setTimeout(r, FLUSH_AFTER_SIGTERM_MS));
}
