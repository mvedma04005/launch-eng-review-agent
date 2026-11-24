import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { AlertState, evaluateAlerts, notify } from './alerts.ts';
import type { Config } from './config.ts';
import { buildContext } from './context.ts';
import { Mirror } from './evidence/git.ts';
import { sweepGate } from './gate.ts';
import { registerStoreGauges, startStatusServer } from './http.ts';
import { CHAT_SCOPES, GoogleChatApi, PUBSUB_SCOPES, PubSubPuller, flushChatOutbox, handleChatMessage, parseChatEvent, pollChatSpaces, resolvePendingChatRequests, serviceAccountTokens } from './ingress/chat.ts';
import { pollRepository } from './ingress/github.ts';
import { log } from './log.ts';
import { metrics } from './metrics.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { Store } from './queue/store.ts';
import { processJob, sameChange } from './worker.ts';

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
    const gitHubFor = async (repo: string) => new OctokitGitHub(await ctx.auth.octokitFor(repo), await ctx.auth.botLogin());
    const sweep = async (repo: string, github: OctokitGitHub) => {
      const mirror = new Mirror(config.stateDir, repo, `https://github.com/${repo}.git`, () => ctx.auth.gitTokenFor(repo));
      // The same comparison the worker uses for Falcon's own approvals: the head from the merge base the gate read (from
      // where it left its base now, when not given), the old commit from the base it was approved on.
      const same = async (number: number, oldSha: string, headSha: string, governs: (path: string) => boolean, oldBase?: string, judgedRef?: string, judgedMergeBase?: string) => {
        await mirror.ensure();
        await mirror.fetchCommit(headSha);
        // The merge base the gate read, as is, so the answer matches the key it is saved under even if the base moved since.
        let mergeBase = judgedMergeBase;
        if (mergeBase) await mirror.fetchCommit(mergeBase);
        else mergeBase = await mirror.mergeBase(await mirror.fetchBranchTip(number, judgedRef ?? (await github.pullState(repo, number)).baseRef), headSha);
        return sameChange(mirror, { headSha: oldSha, baseSha: oldBase ?? mergeBase }, mergeBase, headSha, governs);
      };
      await sweepGate({ github, store, log, falcon: await ctx.auth.botLogin(), repoPack: config.policy.repoPath, requested: config.gate.everyPull ? null : store.chatRequestedPulls(repo), branches: config.gate.branches, stacks: config.gate.stacks, dryRun: config.dryRun, sameChange: same }, repo);
    };
    const pollMs = config.gate.pollSeconds * 1000;
    if (config.gate.probeSeconds > 0) {
      // One loop, so the probe and a pass never run at the same time. Per repository: what the probe saw before the last
      // pass, and when that pass ended.
      const last = new Map<string, { probe: GateProbe | null; at: number }>();
      every(config.gate.probeSeconds * 1000, 'gate_sweep', async () => {
        for (const repo of config.github.repos) {
          const github = await gitHubFor(repo);
          let probe: GateProbe | null = null;
          try { probe = await probeGate(github, repo, config.gate.branches); } catch (error) { metrics.errors.inc({ component: 'gate_probe' }); log.warn({ err: error, repo }, 'merge gate probe failed; the gate runs a pass'); }
          const seen = last.get(repo);
          if (!shouldSweep(seen?.probe ?? null, probe, seen?.at ?? 0, Date.now(), pollMs)) continue;
          await sweep(repo, github);
          // Saved only after a pass that ran to the end, so a pass that threw runs again on the next tick.
          last.set(repo, { probe, at: Date.now() });
        }
      });
    } else {
      every(pollMs, 'gate_sweep', async () => { for (const repo of config.github.repos) await sweep(repo, await gitHubFor(repo)); });
    }
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

/** What the merge gate's probe sees of a repository: the open PR updated last, and each merge queue commit. */
export type GateProbe = { newest: Awaited<ReturnType<OctokitGitHub['newestPull']>>; queue: string[] };

/**
 * About 2 GitHub calls: the open PR updated last, and the merge queue of the default branch and of each extra branch.
 * A review, a push or an edit moves a PR's update time, so it makes that PR the newest one.
 * ponytail: a second update of the newest PR in the same second of its update time looks like no change; the pass due
 * every `gate.pollSeconds` catches it.
 */
export async function probeGate(github: Pick<OctokitGitHub, 'newestPull' | 'queueEntries'>, repo: string, branches: string[]): Promise<GateProbe> {
  const newest = await github.newestPull(repo);
  // No open PR, so no PR is queued.
  if (!newest) return { newest, queue: [] };
  const queue: string[] = [];
  for (const branch of [newest.defaultBranch, ...branches]) for (const e of await github.queueEntries(repo, branch)) queue.push(`${branch}:${e.number}:${e.headSha}`);
  return { newest, queue: queue.sort() };
}

/**
 * Whether a tick of the gate loop runs a pass: on the first tick, when the probe saw a change, when the probe failed
 * (`current` null: fail toward judging, never toward skipping), and when `pollMs` went by since the last pass, so PRs
 * judged in turn and retries still run.
 */
export function shouldSweep(previous: GateProbe | null, current: GateProbe | null, lastSweepAt: number, now: number, pollMs: number): boolean {
  return previous === null || current === null || !isDeepStrictEqual(previous, current) || now - lastSweepAt >= pollMs;
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

/** Resolves after `ms`, or at once when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // The stdlib timer removes its abort listener when it fires. A listener added by hand stayed on the shared
  // signal for good: one per sleep, a few every second, and Node walks that list on every add.
  return delay(ms, undefined, { signal }).catch(() => undefined);
}
