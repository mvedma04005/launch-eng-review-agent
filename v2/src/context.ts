import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.ts';
import { deliverOutcome } from './ingress/chat.ts';
import { githubAuthFromEnv } from './ingress/github.ts';
import { log } from './log.ts';
import type { Store } from './queue/store.ts';
import { claudeReviewer } from './reviewer/claude.ts';
import type { WorkerContext } from './worker.ts';

/** Inference goes to the Anthropic API directly (decided over Bedrock). The SDK reads ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN. */
export function anthropicClient(env: NodeJS.ProcessEnv = process.env): Anthropic {
  if (!env['ANTHROPIC_API_KEY'] && !env['ANTHROPIC_AUTH_TOKEN']) {
    throw new Error('No Anthropic credential: set ANTHROPIC_API_KEY in the environment (on the Mac, in ~/.config/falcon/env).');
  }
  // Retries cover 429 and 5xx; each review is many calls, so per-call retries matter more than a long timeout.
  return new Anthropic({ maxRetries: 3 });
}

/** One place to assemble a worker context, so the daemon and its child processes behave identically. */
export function buildContext(config: Config, store: Store, overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    config, store, auth: githubAuthFromEnv(config), anthropic: overrides.anthropic ?? anthropicClient(), reviewer: claudeReviewer, log, dryRun: config.dryRun,
    ...(config.chat.enabled ? { notify: (job, outcome) => deliverOutcome(store, job, outcome) } : {}),
    ...overrides,
  };
}
