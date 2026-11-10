import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod/v4';
import type { Anchors } from '../evidence/diff.ts';
import type { Worktree } from '../evidence/git.ts';
import type { PolicyPack } from '../policy/schema.ts';
import type { Finding, ReviewStep } from '../types.ts';
import { ReviewSubmissionSchema, type ReviewSubmission } from './schema.ts';
import { validateSubmission, type ValidationContext } from './validate.ts';

export interface ToolState {
  calls: number;
  accepted: { submission: ReviewSubmission; findings: Finding[] } | null;
  rejectedSubmissions: number;
}

const MAX_LINES_PER_READ = 400;

/**
 * The reviewer's whole world: read-only, confined to one commit, budgeted, and recorded. There is no shell, no
 * network and no write path, so prompt injection in repository content can at most waste tool calls. Every call
 * is reported through `onStep` so an operator can later see exactly what the reviewer looked at.
 */
export function buildTools(
  worktree: Worktree, anchors: Anchors, policy: PolicyPack,
  ctx: Omit<ValidationContext, 'worktree' | 'anchors' | 'maxFileBytes'>, state: ToolState,
  onStep?: (step: ReviewStep) => void,
) {
  const budget = policy.budgets.maxToolCalls;
  const record = (tool: string, input: string, started: number, outcome: ReviewStep['outcome']) => {
    onStep?.({ seq: state.calls, at: new Date(started).toISOString(), tool, input: input.slice(0, 200), durationMs: Date.now() - started, outcome });
  };
  const track = async (tool: string, input: string, fn: () => Promise<string> | string): Promise<string> => {
    state.calls++;
    const started = Date.now();
    if (state.calls > budget) {
      record(tool, input, started, 'budget');
      return `Tool budget of ${budget} calls exhausted. Call submit_review now with what you have verified; report unreviewed files as questions.`;
    }
    try {
      const out = await fn();
      record(tool, input, started, 'ok');
      return out;
    } catch (error) {
      record(tool, input, started, 'error');
      return `Error: ${(error as Error).message}`;
    }
  };
  const numbered = (text: string, start: number) => text.split('\n').map((l, i) => `${String(start + i).padStart(5)}│${l}`).join('\n');

  const readFile = betaZodTool({
    name: 'read_file',
    description: `Read a file at the PR head commit with line numbers. Returns at most ${MAX_LINES_PER_READ} lines per call; use start_line/end_line to page.`,
    inputSchema: z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
    run: ({ path, start_line, end_line }) => track('read_file', `${path}:${start_line ?? 1}-${end_line ?? ''}`, () => {
      const lines = worktree.readText(path, policy.budgets.maxFileBytes).split('\n');
      const start = start_line ?? 1;
      const end = Math.min(end_line ?? start + MAX_LINES_PER_READ - 1, start + MAX_LINES_PER_READ - 1, lines.length);
      if (start > lines.length) return `File has ${lines.length} lines.`;
      return `${path} (lines ${start}-${end} of ${lines.length})\n` + numbered(lines.slice(start - 1, end).join('\n'), start);
    }),
  });

  const listDir = betaZodTool({
    name: 'list_dir',
    description: 'List the immediate entries of a directory at the PR head commit. Directories end with "/".',
    inputSchema: z.object({ path: z.string().default('') }),
    run: ({ path }) => track('list_dir', path || '/', async () => {
      worktree.resolve(path || '.');
      const entries = await worktree.listDir(path);
      return entries.length ? entries.join('\n') : '(empty)';
    }),
  });

  const search = betaZodTool({
    name: 'search',
    description: 'Search file contents at the PR head with an extended regular expression. Optional path globs narrow the search. Returns path:line:text, at most 60 matches.',
    inputSchema: z.object({ pattern: z.string().min(1).max(300), globs: z.array(z.string()).max(10).default([]) }),
    run: ({ pattern, globs }) => track('search', `${pattern} ${globs.join(' ')}`, async () => {
      const hits = await worktree.grep(pattern, globs, 60);
      return hits.length ? hits.join('\n') : 'No matches.';
    }),
  });

  const showDiff = betaZodTool({
    name: 'show_diff',
    description: 'Show the unified diff of one changed file (merge base to PR head).',
    inputSchema: z.object({ path: z.string() }),
    run: ({ path }) => track('show_diff', path, () => {
      const file = anchors.files.find((f) => f.path === path || f.oldPath === path);
      if (!file) return 'That file is not part of the change.';
      return file.binary ? 'Binary file changed.' : file.text.slice(0, 200_000);
    }),
  });

  const history = betaZodTool({
    name: 'git_history',
    description: 'Recent commits touching a path (up to 20), or the blame line for one line when line is given.',
    inputSchema: z.object({ path: z.string(), line: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(20).default(10) }),
    run: ({ path, line, limit }) => track('git_history', `${path}${line ? ':' + line : ''}`, async () => {
      worktree.resolve(path);
      return line ? await worktree.blame(path, line) : (await worktree.log(path, limit)) || 'No history.';
    }),
  });

  const submit = betaZodTool({
    name: 'submit_review',
    description: 'Submit the completed review. The host verifies every finding against the source; if any fail, you get the reasons back and must correct and resubmit. Call this exactly once successfully, then stop.',
    inputSchema: ReviewSubmissionSchema,
    run: async (input) => {
      state.calls++;
      const started = Date.now();
      const { findings, errors } = await validateSubmission(input, { ...ctx, worktree, anchors, maxFileBytes: policy.budgets.maxFileBytes });
      if (errors.length && state.rejectedSubmissions < 3) {
        state.rejectedSubmissions++;
        record('submit_review', `${input.findings.length} findings, ${errors.length} rejected`, started, 'error');
        return `REJECTED (${errors.length} problem(s)). Fix these and call submit_review again:\n- ${errors.join('\n- ')}`;
      }
      state.accepted = { submission: input, findings };
      record('submit_review', `${findings.length} verified, ${errors.length} dropped, confidence ${input.confidence}`, started, 'ok');
      return errors.length
        ? `ACCEPTED with ${findings.length} verified finding(s); ${errors.length} unverifiable finding(s) were dropped. You are done; end your turn.`
        : `ACCEPTED with ${findings.length} verified finding(s). You are done; end your turn.`;
    },
  });

  return [readFile, listDir, search, showDiff, history, submit];
}
