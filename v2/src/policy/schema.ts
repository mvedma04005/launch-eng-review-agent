import { z } from 'zod/v4';

const severity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const glob = z.string().min(1);

/** One reviewable expectation. Prose guidance is applied by the model; severity, paths and suppressions are enforced by the host. */
export const RuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  title: z.string().min(1),
  severity,
  /** Globs this rule applies to; default everything. */
  paths: z.array(glob).default(['**']),
  /** What good looks like, what bad looks like, and why it matters. Shown to the reviewer. */
  guidance: z.string().min(1),
  /** Worked examples sharpen judgment and are the main lever for "this is not a bug here". */
  examples: z.array(z.object({ good: z.string().optional(), bad: z.string().optional(), note: z.string().optional() })).default([]),
  enabled: z.boolean().default(true),
});
export type Rule = z.infer<typeof RuleSchema>;

export const PolicyPackSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().default(''),
  scope: z.object({
    include: z.array(glob).default(['**']),
    /** Files never reviewed or counted against budgets (lockfiles, generated code, snapshots). */
    exclude: z.array(glob).default([]),
  }).prefault({}),
  verdict: z.object({
    /** comment: always a COMMENT review plus a check run. approve: APPROVE when nothing blocks. request_changes: REQUEST_CHANGES when something blocks. */
    mode: z.enum(['comment', 'approve', 'request_changes']).default('comment'),
    /** Ceiling a repository overlay may opt into. Set centrally by the operator; an overlay cannot raise it. */
    maxMode: z.enum(['comment', 'approve', 'request_changes']).default('request_changes'),
    blockOn: z.array(severity).default(['critical', 'high']),
    checkRun: z.boolean().default(true),
    /** Blocking findings must pass the verifier before they can block. */
    verifyBlocking: z.boolean().default(true),
  }).prefault({}),
  lenses: z.array(z.string().min(1)).default(['correctness', 'security', 'operability']),
  budgets: z.object({
    maxChangedFiles: z.number().int().min(1).default(300),
    /** Additions plus deletions across in-scope files. Larger PRs are asked to split; the review would not be reliable. */
    maxChangedLines: z.number().int().min(50).default(750),
    maxFileBytes: z.number().int().min(1024).default(400_000),
    maxToolCalls: z.number().int().min(5).default(80),
    maxMinutes: z.number().int().min(1).default(25),
    /** Token and spend ceilings per review; the engine config may clamp these lower. */
    maxInputTokens: z.number().int().min(10_000).default(800_000),
    maxOutputTokens: z.number().int().min(1_000).default(60_000),
    maxCostUsd: z.number().min(0.1).default(6),
    /** Diff larger than this is not inlined; the reviewer reads files through tools instead. */
    inlineDiffBytes: z.number().int().min(1024).default(200_000),
  }).prefault({}),
  context: z.object({
    /** Instruction files picked up from the changed files' ancestor directories at the head commit. */
    instructionFiles: z.array(z.string()).default(['AGENTS.md', 'CLAUDE.md']),
    /** Always-read files at the head commit (repository-relative). Missing files hold the review. */
    required: z.array(z.string()).default([]),
  }).prefault({}),
  /** Free-form statements of what good looks like for this codebase. */
  standards: z.array(z.object({ title: z.string().min(1), text: z.string().min(1), paths: z.array(glob).default(['**']) })).default([]),
  rules: z.array(RuleSchema).default([]),
  suppressions: z.array(z.object({ rule: z.string(), paths: z.array(glob).default(['**']), reason: z.string().min(1) })).default([]),
  feedback: z.object({
    learn: z.boolean().default(true),
    maxLessons: z.number().int().min(0).default(40),
  }).prefault({}),
});
export type PolicyPack = z.infer<typeof PolicyPackSchema>;
