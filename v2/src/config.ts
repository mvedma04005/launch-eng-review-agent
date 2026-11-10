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
    /** Repositories to watch when polling; empty means every installed repository. */
    repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).default([]),
    pollSeconds: z.number().int().min(10).default(30),
    webhookPort: z.number().int().min(0).default(0),
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
  notify: z.object({
    webhookUrlEnv: z.string().default('FALCON_NOTIFY_WEBHOOK'),
  }).prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = process.env['FALCON_CONFIG'] ?? 'falcon.yaml'): Config {
  const raw = existsSync(path) ? YAML.parse(readFileSync(path, 'utf8')) ?? {} : {};
  return ConfigSchema.parse(raw);
}
