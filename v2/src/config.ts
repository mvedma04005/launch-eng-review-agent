import { z } from 'zod/v4';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

/** Runtime configuration. Secrets come from the environment, never from this file. */
export const ConfigSchema = z.object({
  stateDir: z.string().default(join(homedir(), 'Library', 'Application Support', 'falcon')),
  github: z.object({
    /** GitHub App mode (production). */
    appId: z.number().int().positive().optional(),
    privateKeyEnv: z.string().default('FALCON_GITHUB_PRIVATE_KEY'),
    webhookSecretEnv: z.string().default('FALCON_GITHUB_WEBHOOK_SECRET'),
    /** Token mode (dry runs, local development). */
    tokenEnv: z.string().default('GITHUB_TOKEN'),
    /** THE repository allowlist. Every intake path, the queue and the worker refuse anything else. */
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1).default(['ROKT/launch-engineering']),
    /** Seconds between looks at GitHub for changed PRs. 0 turns this off: only PRs requested in Chat are reviewed. */
    pollSeconds: z.number().int().refine((n) => n === 0 || n >= 10, 'must be 0 (off) or at least 10').default(30),
    /** A check that has been pending for longer than this is treated as stalled, so it does not hold up a review. */
    stalledCheckMinutes: z.number().int().min(5).default(60),
    webhookPort: z.number().int().min(0).default(0),
  }).prefault({}),
  /** Google Chat as the request channel: a Chat app identity, events over Pub/Sub, replies through a durable outbox. */
  chat: z.object({
    enabled: z.boolean().default(false),
    /** Closed allowlist of spaces a request may come from and where replies go. */
    spaces: z.array(z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/)).default([]),
    /** Env var holding the service-account JSON for the Chat app (chat.bot scope; plus chat.app.messages.readonly for polling). */
    serviceAccountEnv: z.string().default('FALCON_GOOGLE_SERVICE_ACCOUNT_JSON'),
    pubsub: z.object({
      project: z.string().default(''),
      subscription: z.string().default(''),
    }).prefault({}),
    /** App-authenticated poll of the spaces for bare links without a mention; 0 disables. */
    pollSeconds: z.number().int().min(0).default(5),
    /** Manual review rounds per PR from Chat, counted across threads. */
    maxRoundsPerPr: z.number().int().min(1).default(3),
  }).prefault({}),
  model: z.object({
    reviewer: z.string().default('claude-opus-5-5'),
    verifier: z.string().default('claude-opus-5-5'),
    learner: z.string().default('claude-haiku-5-5'),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    serverSideFallback: z.boolean().default(true),
  }).prefault({}),
  workers: z.object({
    concurrency: z.number().int().min(1).default(8),
    perRepoConcurrency: z.number().int().min(1).default(4),
    leaseSeconds: z.number().int().min(60).default(900),
    /** process: each review runs in its own child process with a hard kill timer, so one bad review cannot take the daemon down. */
    isolation: z.enum(['process', 'inline']).default('process'),
    /** Publication retries before a finished review is parked for `falcon replay`. */
    maxPublicationAttempts: z.number().int().min(1).default(12),
  }).prefault({}),
  /** Full pipeline, nothing posted to GitHub. Use it to stage a new host or policy against real PRs. */
  dryRun: z.boolean().default(false),
  alerts: z.object({
    stallMinutes: z.number().int().min(5).default(30),
    spendWarnFraction: z.number().min(0.1).max(1).default(0.8),
    failuresPerHour: z.number().int().min(1).default(5),
  }).prefault({}),
  /** Hard ceilings the operator sets centrally. Repository policy budgets are clamped to these. */
  limits: z.object({
    perReview: z.object({
      maxInputTokens: z.number().int().min(10_000).default(1_500_000),
      maxOutputTokens: z.number().int().min(1_000).default(150_000),
      maxCostUsd: z.number().min(0.1).default(15),
      maxMinutes: z.number().int().min(1).default(30),
      maxToolCalls: z.number().int().min(5).default(120),
    }).prefault({}),
    /** UTC-day spend caps. When reached, new reviews defer to the next day instead of failing. */
    daily: z.object({
      perRepoUsd: z.number().min(0).default(200),
      globalUsd: z.number().min(0).default(1000),
    }).prefault({}),
  }).prefault({}),
  /** Status and metrics HTTP server. Port 0 disables it. Binds to localhost unless host is set. */
  http: z.object({
    port: z.number().int().min(0).default(0),
    host: z.string().default('127.0.0.1'),
  }).prefault({}),
  policy: z.object({
    /** Engine-wide pack applied before repository packs. */
    defaultPack: z.string().default('policies/default.yaml'),
    /** Path inside each repository that may refine the pack. */
    repoPath: z.string().default('.falcon/policy.yaml'),
  }).prefault({}),
  /** The merge gate: a second check on every open PR, passing only when its owners or Falcon approved the current commit. */
  gate: z.object({
    enabled: z.boolean().default(false),
    /** The CODEOWNERS entry Falcon stands in for, e.g. `@ROKT/launch-engineering`. Required when enabled. */
    teamOwner: z.string().default(''),
    /** Judge every open PR into the default branch, not only the ones requested in Chat. Turn it on before the check is required to merge: a PR nobody posted in Chat still needs its check. */
    everyPull: z.boolean().default(false),
    /** Seconds between passes. */
    pollSeconds: z.number().int().min(10).default(30),
  }).prefault({}),
  notify: z.object({
    webhookUrlEnv: z.string().default('FALCON_NOTIFY_WEBHOOK'),
  }).prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/** The one place the repository scope is decided. Case-insensitive on purpose: GitHub is. */
export function isAllowedRepo(config: Pick<Config, 'github'>, repo: string): boolean {
  const wanted = repo.toLowerCase();
  return config.github.repos.some((r) => r.toLowerCase() === wanted);
}

export function loadConfig(path = process.env['FALCON_CONFIG'] ?? 'falcon.yaml'): Config {
  const raw = existsSync(path) ? YAML.parse(readFileSync(path, 'utf8')) ?? {} : {};
  return ConfigSchema.parse(raw);
}
