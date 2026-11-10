import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Anchors } from '../evidence/diff.ts';
import type { Worktree } from '../evidence/git.ts';
import type { PolicyPack } from '../policy/schema.ts';
import type { Finding, Lesson, PullMeta, ReviewOutput, Usage } from '../types.ts';
import { buildTools, type ToolState } from './tools.ts';
import { systemPrompt, userTurn, type UserTurnInput } from './prompt.ts';
import { VerificationSchema } from './schema.ts';

export class Incomplete extends Error {}

export interface ReviewerOptions {
  client: Anthropic;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  serverSideFallback: boolean;
  policy: PolicyPack;
  worktree: Worktree;
  anchors: Anchors;
  meta: PullMeta;
  lessons: Lesson[];
  baseRead: (path: string) => Promise<string | null>;
  turn: Omit<UserTurnInput, 'meta' | 'anchors' | 'inlineDiffBytes'>;
  signal?: AbortSignal;
}

/** Interface the worker depends on, so tests and dry runs can substitute a fake. */
export interface Reviewer {
  review(opts: ReviewerOptions): Promise<{ output: ReviewOutput; usage: Usage }>;
  verify(client: Anthropic, model: string, finding: Finding, excerpt: string): Promise<Finding['verified']>;
}

export const claudeReviewer: Reviewer = {
  async review(opts) {
    const started = Date.now();
    const state: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
    const tools = buildTools(opts.worktree, opts.anchors, opts.policy, { baseRead: opts.baseRead, changedFiles: opts.turn.changedFiles }, state);
    const system = systemPrompt(opts.policy, opts.lessons);
    const user = userTurn({ ...opts.turn, meta: opts.meta, anchors: opts.anchors, inlineDiffBytes: opts.policy.budgets.inlineDiffBytes });
    const usage: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, toolCalls: 0, modelCalls: 0, wallMs: 0 };
    const deadline = started + opts.policy.budgets.maxMinutes * 60_000;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1000, deadline - Date.now()));
    try {
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: user }];
      for (let attempt = 0; attempt < 2 && !state.accepted; attempt++) {
        const params: Anthropic.Beta.Messages.BetaToolRunnerParams & { stream?: false } = {
          model: opts.model,
          max_tokens: 32_000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools,
          max_iterations: opts.policy.budgets.maxToolCalls + 6,
          output_config: { effort: opts.effort },
          // Server-side fallback: if a safety classifier declines the review on the primary model, the API re-runs it
          // on a fallback model inside the same call instead of failing the review.
          ...(opts.serverSideFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        };
        const runner = opts.client.beta.messages.toolRunner(params, { signal: controller.signal });
        let last: Anthropic.Beta.Messages.BetaMessage | null = null;
        for await (const message of runner) {
          last = message;
          usage.modelCalls++;
          usage.inputTokens += message.usage.input_tokens;
          usage.cachedInputTokens += message.usage.cache_read_input_tokens ?? 0;
          usage.outputTokens += message.usage.output_tokens;
          if (message.stop_reason === 'refusal') throw new Incomplete('The model declined to review this change.');
          if (state.accepted) break;
        }
        if (!state.accepted && last) {
          messages.push({ role: 'assistant', content: last.content }, { role: 'user', content: 'You stopped without a successful submit_review call. Call submit_review now with your verified findings, or with an empty findings list and a summary if the change is sound.' });
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Incomplete(Date.now() >= deadline ? 'Review exceeded its time budget.' : 'Review was cancelled.');
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      usage.toolCalls = state.calls;
      usage.wallMs = Date.now() - started;
    }
    if (!state.accepted) throw new Incomplete('The model did not produce a verifiable review.');
    const { submission, findings } = state.accepted;
    return {
      output: { summary: submission.summary.trim(), findings, reviewedFiles: submission.reviewed_files, lenses: submission.lenses_completed, questions: submission.questions },
      usage,
    };
  },

  /** Second, independent look at one finding with only the relevant source in view. Cuts false positives before anything blocks. */
  async verify(client, model, finding, excerpt) {
    const response = await client.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(VerificationSchema), effort: 'medium' },
      system: 'You independently verify one code-review finding. Judge only from the source shown. Be skeptical of findings that depend on assumptions about code you cannot see; say so and lower confidence.',
      messages: [{ role: 'user', content: `Finding (${finding.severity}) at ${finding.path}:${finding.line}\nTitle: ${finding.title}\nScenario: ${finding.scenario}\nImpact: ${finding.impact}\nEvidence: ${finding.evidence}\n\nSource around the cited line:\n\`\`\`\n${excerpt}\n\`\`\`` }],
    });
    const parsed = response.parsed_output;
    return parsed ? { real: parsed.real, confidence: parsed.confidence, reason: parsed.reason } : { real: false, confidence: 0, reason: 'verifier returned no structured result' };
  },
};
