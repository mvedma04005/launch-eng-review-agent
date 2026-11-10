import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.ts';
import { githubAuthFromEnv, parsePullUrl } from './ingress/github.ts';
import { log } from './log.ts';
import { OctokitGitHub } from './publisher/github.ts';
import { Store } from './queue/store.ts';
import { claudeReviewer } from './reviewer/claude.ts';
import { serve } from './serve.ts';
import { findingsSummary, processJob } from './worker.ts';

const USAGE = `falcon — PR review engine

  falcon review <pr-url> [--post]     Review one PR. Dry run by default: prints the review, posts nothing.
  falcon serve                        Run the daemon (polling ingress + workers).
  falcon status                       Queue counts and recent events.

Environment: ANTHROPIC_API_KEY; GITHUB_TOKEN (token mode) or FALCON_GITHUB_PRIVATE_KEY with github.appId in falcon.yaml (app mode).`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { post: { type: 'boolean', default: false }, config: { type: 'string' } } });
  const [command, arg] = positionals;
  const config = loadConfig(values.config);
  if (command === 'review' && arg) {
    const { repo, number } = parsePullUrl(arg);
    const auth = githubAuthFromEnv(config);
    const stateDir = values.post ? config.stateDir : join(tmpdir(), 'falcon-dry-run');
    const store = new Store(join(stateDir, 'falcon.sqlite3'));
    const github = new OctokitGitHub(await auth.octokitFor(repo), await auth.botLogin());
    const meta = await github.pull(repo, number);
    const { job } = store.enqueue({ repo, number, headSha: meta.headSha, baseSha: meta.baseSha, baseRef: meta.baseRef, trigger: 'manual', receivedAt: new Date().toISOString() });
    const leased = store.claim('cli', 3600, { perRepo: 1, global: 1 }) ?? job;
    const outcome = await processJob({ config: { ...config, stateDir }, store, auth, anthropic: new Anthropic(), reviewer: claudeReviewer, log, dryRun: !values.post }, leased, 'cli');
    if (outcome.rendered) {
      process.stdout.write(`\n${outcome.rendered.body}\n\n--- inline comments (${outcome.rendered.comments.length}) ---\n`);
      for (const c of outcome.rendered.comments) process.stdout.write(`\n${c.path}:${c.line} (${c.side})\n${c.body}\n`);
      process.stdout.write(`\n--- findings ---\n${findingsSummary(outcome.output?.findings ?? [])}\n--- usage ---\n${JSON.stringify(outcome.usage)}\n`);
    }
    process.stdout.write(`\nstatus: ${outcome.status}${outcome.reason ? ` — ${outcome.reason}` : ''}${outcome.reviewUrl ? ` — ${outcome.reviewUrl}` : ''}\n`);
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
    const store = new Store(join(config.stateDir, 'falcon.sqlite3'));
    const events = store.db.prepare('select at, job_id, kind, data from events order by id desc limit 20').all();
    process.stdout.write(JSON.stringify({ jobs: store.counts(), recent: events }, null, 2) + '\n');
    store.close();
    return 0;
  }
  process.stderr.write(USAGE + '\n');
  return 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { log.error({ err: error }, 'fatal'); process.exit(1); });
