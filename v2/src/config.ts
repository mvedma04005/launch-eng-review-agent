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
