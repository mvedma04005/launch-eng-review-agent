import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.ts';
import { deliverOutcome } from './ingress/chat.ts';
import { githubAuthFromEnv } from './ingress/github.ts';
import { log } from './log.ts';
import type { Store } from './queue/store.ts';
import { claudeReviewer } from './reviewer/claude.ts';
import type { WorkerContext } from './worker.ts';

/** One place to assemble a worker context, so the daemon and its child processes behave identically. */
export function buildContext(config: Config, store: Store, overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    config, store, auth: githubAuthFromEnv(config), anthropic: new Anthropic(), reviewer: claudeReviewer, log, dryRun: config.dryRun,
    ...(config.chat.enabled ? { notify: (job, outcome) => deliverOutcome(store, job, outcome) } : {}),
    ...overrides,
  };
}
