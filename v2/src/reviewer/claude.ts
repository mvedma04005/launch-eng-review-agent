import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Anchors } from '../evidence/diff.ts';
import type { Worktree } from '../evidence/git.ts';
import type { PolicyPack } from '../policy/schema.ts';
import { DEFAULT_PRICES, emptyUsage, estimateCostUsd, overBudget, type ModelPrice, type ReviewBudget } from '../pricing.ts';
import type { Finding, Lesson, PullMeta, ReviewOutput, ReviewStep, Usage } from '../types.ts';
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
  /** Effective per-review limits after the engine config clamps the policy budgets. */
  budget: ReviewBudget & { maxMinutes: number; maxToolCalls: number };
  prices?: Record<string, ModelPrice>;
  worktree: Worktree;
  anchors: Anchors;
  meta: PullMeta;
  lessons: Lesson[];
  baseRead: (path: string) => Promise<string | null>;
  turn: Omit<UserTurnInput, 'meta' | 'anchors' | 'inlineDiffBytes'>;
  signal?: AbortSignal;
  /** Receives every tool call for the audit trail. */
  onStep?: (step: ReviewStep) => void;
}

/** Interface the worker depends on, so tests and dry runs can substitute a fake. */
export interface Reviewer {
  review(opts: ReviewerOptions): Promise<{ output: ReviewOutput; usage: Usage }>;
  verify(client: Anthropic, model: string, finding: Finding, excerpt: string): Promise<Finding['verified']>;
}

export const claudeReviewer: Reviewer = {
  async review(opts) {
    const started = Date.now();
    const prices = opts.prices ?? DEFAULT_PRICES;
    const state: ToolState = { calls: 0, accepted: null, rejectedSubmissions: 0 };
    const policy: PolicyPack = { ...opts.policy, budgets: { ...opts.policy.budgets, maxToolCalls: opts.budget.maxToolCalls } };
    const tools = buildTools(opts.worktree, opts.anchors, policy, { baseRead: opts.baseRead, changedFiles: opts.turn.changedFiles }, state, opts.onStep);
    const system = systemPrompt(opts.policy, opts.lessons);
    const user = userTurn({ ...opts.turn, meta: opts.meta, anchors: opts.anchors, inlineDiffBytes: opts.policy.budgets.inlineDiffBytes });
    const usage = emptyUsage();
    const deadline = started + opts.budget.maxMinutes * 60_000;
    const controller = new AbortController();
    let stopReason: string | null = null;
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { stopReason = 'Review exceeded its time budget.'; controller.abort(); }, Math.max(1000, deadline - Date.now()));
    try {
      const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: 'user', content: user }];
      for (let attempt = 0; attempt < 2 && !state.accepted; attempt++) {
        // Streamed: the SDK refuses a non-streaming request this large ("Streaming is required for operations that
        // may take longer than 10 minutes"). Tool inputs stay server-validated (no eager_input_streaming).
        const params: Anthropic.Beta.Messages.BetaToolRunnerParams & { stream: true } = {
          model: opts.model,
          max_tokens: 32_000,
          stream: true,
          // Cache the growing conversation: each turn re-reads the earlier turns at the cache-read price instead
          // of paying full input price for the diff, the instruction files and every tool result again.
          cache_control: { type: 'ephemeral' },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools,
          max_iterations: opts.budget.maxToolCalls + 6,
          output_config: { effort: opts.effort },
          // Server-side fallback: if a safety classifier declines on the primary model, the API re-runs the call on
          // a fallback model instead of failing the review.
          ...(opts.serverSideFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        };
        const runner = opts.client.beta.messages.toolRunner(params, { signal: controller.signal });
        let last: Anthropic.Beta.Messages.BetaMessage | null = null;
        for await (const messageStream of runner) {
          const message = await messageStream.finalMessage();
          last = message;
          usage.modelCalls += 1;
          usage.inputTokens += message.usage.input_tokens;
          usage.cachedInputTokens += message.usage.cache_read_input_tokens ?? 0;
          usage.cacheCreationTokens += message.usage.cache_creation_input_tokens ?? 0;
          usage.outputTokens += message.usage.output_tokens;
          usage.estimatedCostUsd = estimateCostUsd(opts.model, usage, prices);
          if (message.stop_reason === 'refusal') throw new Incomplete('The model declined to review this change.');
          const over = overBudget(usage, opts.budget);
          if (over) { stopReason = `Review stopped: ${over}.`; controller.abort(); break; }
          if (state.accepted) break;
        }
        if (stopReason) break;
        if (!state.accepted && last) {
          messages.push(
            { role: 'assistant', content: last.content },
            { role: 'user', content: 'You stopped without a successful submit_review call. Call submit_review now with your verified findings, or with an empty findings list and a summary if the change is sound.' },
          );
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Incomplete(stopReason ?? 'Review was cancelled.');
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      usage.toolCalls = state.calls;
      usage.wallMs = Date.now() - started;
    }
    if (stopReason) throw new Incomplete(stopReason);
    if (!state.accepted) throw new Incomplete('The model did not produce a verifiable review.');
    const { submission, findings } = state.accepted;
    return {
      output: { summary: submission.summary.trim(), confidence: submission.confidence, findings, reviewedFiles: submission.reviewed_files, lenses: submission.lenses_completed, questions: submission.questions, risks: submission.risks },
      usage,
    };
  },

  /** Independent second look at one finding with only the relevant source in view. Cuts false positives before anything blocks. */
  async verify(client, model, finding, excerpt) {
    const response = await client.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { format: zodOutputFormat(VerificationSchema), effort: 'medium' },
      system: 'You independently verify one code-review finding. Judge from the source shown. Answer real=false only when that source contradicts the finding: the cited code does not do what the finding says. When the finding depends on code or facts you cannot see, keep real=true, say what you could not check, and lower confidence.',
      messages: [{ role: 'user', content: `Finding (${finding.severity}) at ${finding.path}:${finding.line}\nTitle: ${finding.title}\nScenario: ${finding.scenario}\nImpact: ${finding.impact}\nEvidence: ${finding.evidence}\n\nSource around the cited line:\n\`\`\`\n${excerpt}\n\`\`\`` }],
    });
    const parsed = response.parsed_output;
    return parsed ? { real: parsed.real, confidence: parsed.confidence, reason: parsed.reason.slice(0, 800) } : { real: false, confidence: 0, reason: 'verifier returned no structured result' };
  },
};
