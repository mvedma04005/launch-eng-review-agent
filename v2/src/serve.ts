import Anthropic from '@anthropic-ai/sdk';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { registerStoreGauges, startStatusServer } from './http.ts';
import { githubAuthFromEnv, pollRepository } from './ingress/github.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';
import { Store } from './queue/store.ts';
import { claudeReviewer } from './reviewer/claude.ts';
import { processJob, type WorkerContext } from './worker.ts';

/**
 * The daemon: one process, N concurrent reviews, polling ingress, a status and metrics server. Crash-only by
 * design: all state is in SQLite, leases expire, and the next start simply resumes. Suitable for launchd on a
 * Mac or a container elsewhere.
 */
export async function serve(config: Config, signal: AbortSignal): Promise<void> {
  const store = new Store(join(config.stateDir, 'falcon.sqlite3'));
  const auth = githubAuthFromEnv(config);
  const ctx: WorkerContext = { config, store, auth, anthropic: new Anthropic(), reviewer: claudeReviewer, log, dryRun: false };
  const owner = `${hostname()}:${process.pid}`;
  registerStoreGauges(store);
  const http = config.http.port > 0 ? startStatusServer(config, store, log) : null;
  log.info({ owner, mode: auth.mode, concurrency: config.workers.concurrency, repos: config.github.repos, http: config.http.port || 'off' }, 'falcon serving');

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
      try { await processJob(ctx, job, me); }
      catch (error) {
        metrics.errors.inc({ component: 'worker_loop' });
        log.error({ err: error, job: job.id }, 'worker loop error');
        store.finish(job.id, 'failed', { error: String(error) });
      }
    }
  });

  await Promise.all([poller, ...workers]);
  http?.close();
  store.close();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
