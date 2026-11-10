import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlertState, evaluateAlerts, notify } from './alerts.ts';
import type { Config } from './config.ts';
import { registerStoreGauges, startStatusServer } from './http.ts';
import { githubAuthFromEnv, pollRepository } from './ingress/github.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';
import { Store } from './queue/store.ts';
import { claudeReviewer } from './reviewer/claude.ts';
import { processJob, type WorkerContext } from './worker.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * The daemon: one process, N concurrent reviews, polling ingress, a status and metrics server, alerting.
 * Crash-only by design: all state is in SQLite, leases expire, and the next start simply resumes. With
 * `workers.isolation: process`, each review runs in its own child process under a hard kill timer, so a
 * runaway review cannot take the daemon or its siblings down. Suitable for launchd on a Mac.
 */
export async function serve(config: Config, signal: AbortSignal): Promise<void> {
  const store = new Store(join(config.stateDir, 'falcon.sqlite3'));
  const auth = githubAuthFromEnv(config);
  const ctx: WorkerContext = { config, store, auth, anthropic: new Anthropic(), reviewer: claudeReviewer, log, dryRun: config.dryRun };
  const owner = `${hostname()}:${process.pid}`;
  registerStoreGauges(store);
  const http = config.http.port > 0 ? startStatusServer(config, store, log) : null;
  log.info({ owner, mode: auth.mode, isolation: config.workers.isolation, dryRun: config.dryRun, concurrency: config.workers.concurrency, repos: config.github.repos, http: config.http.port || 'off' }, 'falcon serving');

  const poller = (async () => {
    while (!signal.aborted) {
      for (const repo of config.github.repos) {
        try { await pollRepository(auth, store, repo, log); }
        catch (error) { metrics.errors.inc({ component: 'poller' }); log.warn({ err: error, repo }, 'poll failed'); }
      }
      await sleep(config.github.pollSeconds * 1000, signal);
    }
  })();

  const workers = Array.from({ length: config.workers.concurrency }, async (_, i) => {
    const me = `${owner}#${i}`;
    while (!signal.aborted) {
      const job = store.claim(me, config.workers.leaseSeconds, { perRepo: config.workers.perRepoConcurrency, global: config.workers.concurrency });
      if (!job) { await sleep(2000, signal); continue; }
      try {
        if (config.workers.isolation === 'process') await runInChild(config, store, job.id, me, signal);
        else await processJob(ctx, job, me);
      } catch (error) {
        metrics.errors.inc({ component: 'worker_loop' });
        log.error({ err: error, job: job.id }, 'worker loop error');
        store.finish(job.id, 'failed', { error: String(error) });
      }
    }
  });

  const alerts = (async () => {
    const state = new AlertState();
    const webhook = process.env[config.notify.webhookUrlEnv];
    while (!signal.aborted) {
      try {
        const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
        const last = store.lastProgressAt();
        const active = evaluateAlerts(config, { snapshot: store.snapshot(), lastProgressAt: last ? new Date(last) : null, failedLastHour: store.failedSince(hourAgo) });
        for (const text of state.transition(active)) {
          log.warn({ alert: text }, 'alert');
          if (!(await notify(webhook, text))) log.info('no alert webhook configured; alert logged only');
        }
      } catch (error) { log.warn({ err: error }, 'alert evaluation failed'); }
      await sleep(60_000, signal);
    }
  })();

  await Promise.all([poller, alerts, ...workers]);
  http?.close();
  store.close();
}

/** Runs one leased job in a child process. The parent only waits, enforces the deadline, and tidies up if the child died. */
async function runInChild(config: Config, store: Store, jobId: string, owner: string, signal: AbortSignal): Promise<void> {
  const deadlineMs = (config.workers.leaseSeconds + 60) * 1000;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'run-job', jobId, '--owner', owner, ...(process.env['FALCON_CONFIG'] ? ['--config', process.env['FALCON_CONFIG']] : [])], { stdio: 'inherit', env: process.env });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, deadlineMs);
  const onAbort = () => child.kill('SIGTERM');
  signal.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  clearTimeout(timer);
  signal.removeEventListener('abort', onAbort);
  const job = store.job(jobId);
  if (job?.status === 'leased' && job.leaseOwner === owner) {
    // The child did not reach a terminal state: crash, kill, or deadline. Requeue promptly rather than waiting for the lease to lapse.
    const reason = killed ? `worker process exceeded ${deadlineMs / 1000}s and was killed` : `worker process exited with code ${code}`;
    metrics.errors.inc({ component: 'worker_process' });
    if (job.attempts >= 3) store.finish(jobId, 'failed', { error: reason });
    else store.requeue(jobId, 30, reason);
    log.error({ job: jobId, code, killed }, reason);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
