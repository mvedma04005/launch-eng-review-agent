import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlertState, evaluateAlerts, notify } from './alerts.ts';
import type { Config } from './config.ts';
import { buildContext } from './context.ts';
import { sweepGate } from './gate.ts';
import { registerStoreGauges, startStatusServer } from './http.ts';
import { CHAT_SCOPES, GoogleChatApi, PUBSUB_SCOPES, PubSubPuller, flushChatOutbox, handleChatMessage, parseChatEvent, pollChatSpaces, resolvePendingChatRequests, serviceAccountTokens } from './ingress/chat.ts';
import { pollRepository } from './ingress/github.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { Store } from './queue/store.ts';
import { processJob } from './worker.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * The daemon: Chat intake (Pub/Sub pull plus app-authenticated poll), GitHub polling, N concurrent reviews each
 * in its own child process, a Chat reply outbox, alerts, and a status server. Crash-only: all state is in SQLite,
 * leases expire, and the next start resumes. Suitable for launchd on a Mac.
 */
export async function serve(config: Config, signal: AbortSignal): Promise<void> {
  const store = new Store(join(config.stateDir, 'falcon.sqlite3'));
  const ctx = buildContext(config, store);
  const owner = `${hostname()}:${process.pid}`;
  registerStoreGauges(store);
  const http = config.http.port > 0 ? startStatusServer(config, store, log) : null;
  log.info({ owner, mode: ctx.auth.mode, isolation: config.workers.isolation, dryRun: config.dryRun, chat: config.chat.enabled, repos: config.github.repos, concurrency: config.workers.concurrency, http: config.http.port || 'off' }, 'falcon serving');

  const loops: Array<Promise<void>> = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => loops.push((async () => {
    while (!signal.aborted) {
      try { await fn(); } catch (error) { metrics.errors.inc({ component: name }); log.warn({ err: error }, `${name} failed`); }
      await sleep(ms, signal);
    }
  })());

  // GitHub: automatic intake of open PRs in the allowlisted repositories.
  if (config.github.pollSeconds > 0) {
    every(config.github.pollSeconds * 1000, 'github_poll', async () => {
      for (const repo of config.github.repos) await pollRepository(ctx.auth, store, repo, log, config);
    });
  } else log.info('github.pollSeconds is 0: only PRs requested in Chat are reviewed');

  // Merge gate: re-read the open PRs whose approvals changed and post the second check.
  if (config.gate.enabled) {
    if (!config.gate.teamOwner) throw new Error('gate.enabled requires gate.teamOwner, the CODEOWNERS entry Falcon stands in for');
    every(config.gate.pollSeconds * 1000, 'gate_sweep', async () => {
      for (const repo of config.github.repos) {
        const github = new OctokitGitHub(await ctx.auth.octokitFor(repo), await ctx.auth.botLogin());
        await sweepGate({ github, store, log, teamOwner: config.gate.teamOwner, falcon: await ctx.auth.botLogin(), repoPack: config.policy.repoPath, requested: config.gate.everyPull ? null : store.chatRequestedPulls(repo), dryRun: config.dryRun }, repo);
      }
    });
  }

  // Chat: the fast path. Events arrive through Pub/Sub within about a second of being posted.
  if (config.chat.enabled) {
    const json = process.env[config.chat.serviceAccountEnv];
    if (!json) throw new Error(`chat.enabled requires ${config.chat.serviceAccountEnv} in the environment`);
    const chat = new GoogleChatApi(serviceAccountTokens(json, CHAT_SCOPES));
    const intake = { config, store, log };
    if (config.chat.pubsub.project && config.chat.pubsub.subscription) {
      const puller = new PubSubPuller(serviceAccountTokens(json, PUBSUB_SCOPES), config.chat.pubsub.project, config.chat.pubsub.subscription);
      loops.push((async () => {
        while (!signal.aborted) {
          try {
            const received = await puller.pull(10);
            for (const { event } of received) {
              const msg = parseChatEvent(event);
              if (msg) { const r = handleChatMessage(intake, msg); metrics.feedback.inc({ repo: 'chat', signal: `event_${r}` }); }
            }
            await puller.ack(received.map((r) => r.ackId));
            if (!received.length) await sleep(300, signal);
          } catch (error) { metrics.errors.inc({ component: 'chat_pubsub' }); log.warn({ err: error }, 'pubsub pull failed'); await sleep(5000, signal); }
        }
      })());
    } else {
      log.warn('chat.pubsub is not configured; relying on polling alone, so pickup is bounded by chat.pollSeconds');
    }
    if (config.chat.pollSeconds > 0) every(config.chat.pollSeconds * 1000, 'chat_poll', () => pollChatSpaces(intake, chat));
    every(1000, 'chat_resolve', () => resolvePendingChatRequests(intake, async (repo, number) => new OctokitGitHub(await ctx.auth.octokitFor(repo), await ctx.auth.botLogin()).pull(repo, number)));
    every(1000, 'chat_outbox', () => flushChatOutbox(store, chat, log));
  }

  // Workers.
  for (let i = 0; i < config.workers.concurrency; i++) {
    const me = `${owner}#${i}`;
    loops.push((async () => {
      while (!signal.aborted) {
        const job = store.claim(me, config.workers.leaseSeconds, { perRepo: config.workers.perRepoConcurrency, global: config.workers.concurrency });
        if (!job) { await sleep(1000, signal); continue; }
        try {
          if (config.workers.isolation === 'process') await runInChild(config, store, job.id, me, signal);
          else await processJob(ctx, job, me);
        } catch (error) {
          metrics.errors.inc({ component: 'worker_loop' });
          log.error({ err: error, job: job.id }, 'worker loop error');
          store.finish(job.id, 'failed', { error: String(error) });
        }
      }
    })());
  }

  // Alerts: edge-triggered, to a Chat or Slack webhook when configured.
  const alertState = new AlertState();
  const webhook = process.env[config.notify.webhookUrlEnv];
  every(60_000, 'alerts', async () => {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const last = store.lastProgressAt();
    const active = evaluateAlerts(config, { snapshot: store.snapshot(), lastProgressAt: last ? new Date(last) : null, failedLastHour: store.failedSince(hourAgo) });
    for (const text of alertState.transition(active)) {
      log.warn({ alert: text }, 'alert');
      if (!(await notify(webhook, text))) log.info('no alert webhook configured; alert logged only');
    }
  });

  await Promise.all(loops);
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
