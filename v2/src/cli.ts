import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.ts';
import { buildContext } from './context.ts';
import { keylessPublicJwks } from './ingress/chat.ts';
import { githubAuthFromEnv, parsePullUrl } from './ingress/github.ts';
import { log } from './log.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { Store } from './queue/store.ts';
import { serve } from './serve.ts';
import { findingsSummary, processJob } from './worker.ts';

const USAGE = `falcon: PR review engine

  falcon review <pr-url> [--post]     Review one PR. Dry run by default: prints the review, posts nothing.
  falcon serve                        Run the daemon (polling ingress, workers, alerts, status server when http.port is set).
  falcon status                       Queue snapshot: counts by status and repository, jobs in review, spend today.
  falcon jobs [--limit N]             Recent jobs with outcome, wall time and estimated cost.
  falcon job <id>                     One job with its usage, tool-call trail and event trail.
  falcon replay <id>                  Re-run a held or failed job. A retained finished review is republished without another model run.
  falcon keyless-key <file>           Create this host's Chat signing key if absent and print its public half (JWKS) for the trust setup. Never prints the private key.
  falcon run-job <id> --owner <w>     Internal: run one already-leased job (used by process isolation).

Environment: ANTHROPIC_API_KEY; GITHUB_TOKEN (token mode) or FALCON_GITHUB_PRIVATE_KEY with github.appId in falcon.yaml (app mode).`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { post: { type: 'boolean', default: false }, config: { type: 'string' }, limit: { type: 'string' }, owner: { type: 'string' } } });
  const [command, arg] = positionals;
  const config = loadConfig(values.config);
  const out = (s: string) => process.stdout.write(s + '\n');
  const openStore = () => new Store(join(config.stateDir, 'falcon.sqlite3'));

  if (command === 'keyless-key' && arg) { out(JSON.stringify(keylessPublicJwks(arg))); return 0; }

  if (command === 'review' && arg) {
    const { repo, number } = parsePullUrl(arg);
    const auth = githubAuthFromEnv(config);
    const stateDir = values.post ? config.stateDir : join(tmpdir(), 'falcon-dry-run');
    const store = new Store(join(stateDir, 'falcon.sqlite3'));
    const github = new OctokitGitHub(await auth.octokitFor(repo), await auth.botLogin());
    const meta = await github.pull(repo, number);
    const { job } = store.enqueue({ repo, number, headSha: meta.headSha, baseSha: meta.baseSha, baseRef: meta.baseRef, trigger: 'manual', receivedAt: new Date().toISOString() });
    const leased = store.claim('cli', 3600, { perRepo: 1, global: 1 }) ?? job;
    const outcome = await processJob(buildContext({ ...config, stateDir, chat: { ...config.chat, enabled: false } }, store, { auth, dryRun: !values.post }), leased, 'cli');
    if (outcome.rendered) {
      out(`\n${outcome.rendered.body}\n\n--- inline comments (${outcome.rendered.comments.length}) ---`);
      for (const c of outcome.rendered.comments) out(`\n${c.path}:${c.line} (${c.side})\n${c.body}`);
      out(`\n--- findings ---\n${findingsSummary(outcome.output?.findings ?? [])}\n--- tool calls ---`);
      for (const s of store.steps(leased.id)) out(`${String(s.seq).padStart(3)} ${s.tool.padEnd(13)} ${String(s.durationMs).padStart(6)}ms ${s.outcome.padEnd(6)} ${s.input}`);
      out(`--- usage ---\n${JSON.stringify(outcome.usage)}`);
    }
    out(`\nstatus: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ''}${outcome.reviewUrl ? ` ${outcome.reviewUrl}` : ''}`);
    store.close();
    return outcome.status === 'held' ? 2 : 0;
  }
  if (command === 'run-job' && arg && values.owner) {
    const store = openStore();
    const job = store.job(arg);
    if (!job || job.status !== 'leased' || job.leaseOwner !== values.owner) { process.stderr.write('run-job: job is not leased to this owner\n'); store.close(); return 1; }
    const outcome = await processJob(buildContext(config, store), job, values.owner);
    store.close();
    return outcome.status === 'held' ? 2 : 0;
  }
  if (command === 'serve') {
    const controller = new AbortController();
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { log.info({ sig }, 'stopping'); controller.abort(); });
    await serve(config, controller.signal);
    return 0;
  }
  if (command === 'status') {
    const store = openStore();
    out(JSON.stringify(store.snapshot(), null, 2));
    store.close();
    return 0;
  }
  if (command === 'jobs') {
    const store = openStore();
    const rows = store.recentJobs(Math.min(500, Number(values.limit ?? 30) || 30));
    out(['job      pr                              status      att  wall    cost     updated                   note', ...rows.map((j) =>
      `${j.id.slice(0, 8)} ${(j.repo + '#' + j.number).padEnd(31)} ${j.status.padEnd(11)} ${String(j.attempts).padEnd(4)} ${(j.wallMs == null ? '' : Math.round(j.wallMs / 1000) + 's').padEnd(7)} ${(j.costUsd == null ? '' : '$' + j.costUsd.toFixed(3)).padEnd(8)} ${j.updatedAt} ${j.error ?? ''}`)].join('\n'));
    store.close();
    return 0;
  }
  if ((command === 'job' || command === 'replay') && arg) {
    const store = openStore();
    const job = store.job(arg) ?? store.recentJobs(500).find((j) => j.id.startsWith(arg));
    if (!job) { out('no such job'); store.close(); return 1; }
    if (command === 'replay') {
      if (!['held', 'failed', 'skipped'].includes(job.status)) { out(`job is ${job.status}; only held, failed or skipped jobs can be replayed`); store.close(); return 1; }
      store.requeue(job.id, 0, `operator replay${store.pending(job) ? ' (retained review will be republished)' : ''}`);
      out(`queued ${job.id}${store.pending(job) ? ' with its retained review' : ' for a fresh review'}`);
    } else {
      out(JSON.stringify({ job, usage: store.usageFor(job.id), steps: store.steps(job.id), events: store.eventsFor(job.id) }, null, 2));
    }
    store.close();
    return 0;
  }
  process.stderr.write(USAGE + '\n');
  return 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { log.error({ err: error }, 'fatal'); process.exit(1); });
