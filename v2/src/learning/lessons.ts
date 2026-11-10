import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LessonSchema } from '../reviewer/schema.ts';
import type { Store } from '../queue/store.ts';
import type { Finding, FindingOutcome, Lesson } from '../types.ts';

/**
 * Learning happens in three auditable layers:
 *  1. Lessons: short, repository-scoped notes derived from corrective feedback, injected into the reviewer prompt.
 *  2. Rule proposals: recurring rejected patterns become a proposed policy-pack change (a PR a human merges).
 *  3. Evals: every finding with an outcome is a labeled case for measuring precision before changing policy or model.
 * Nothing here rewrites the engine prompt silently; every change is visible in the store or in git.
 */
const NEGATIVE: ReadonlySet<FindingOutcome['signal']> = new Set(['thumbs_down', 'reply_disagree', 'merged_unaddressed', 'dismissed', 'command_wrong', 'command_ignore']);

export function isCorrective(outcome: FindingOutcome): boolean { return NEGATIVE.has(outcome.signal); }

export async function deriveLesson(client: Anthropic, model: string, repo: string, finding: Finding, outcome: FindingOutcome): Promise<Lesson | null> {
  const response = await client.messages.parse({
    model,
    max_tokens: 2000,
    output_config: { format: zodOutputFormat(LessonSchema), effort: 'low' },
    system: 'You turn a maintainer\'s correction of an automated code-review finding into one reusable lesson for future reviews of the same repository. Generalize only what the correction supports. Prefer lessons about codebase conventions, intentional patterns, and what is not material here. If the correction is specific to this one line and does not generalize, return null.',
    messages: [{ role: 'user', content: `Repository: ${repo}\nFinding at ${finding.path}:${finding.line} (${finding.severity}${finding.ruleId ? `, rule ${finding.ruleId}` : ''})\nTitle: ${finding.title}\nScenario: ${finding.scenario}\nImpact: ${finding.impact}\nFix proposed: ${finding.fix}\n\nMaintainer signal: ${outcome.signal}${outcome.detail ? `\nMaintainer said: ${outcome.detail}` : ''}` }],
  });
  const parsed = response.parsed_output;
  if (!parsed?.lesson) return null;
  return { id: '', repo, pathPrefix: parsed.path_prefix.replace(/^\/+|\/+$/g, ''), text: parsed.lesson.trim(), sourceFindingId: finding.id, confidence: parsed.confidence, uses: 0, createdAt: '', lastUsedAt: null, retiredAt: null };
}

export async function learnFromOutcome(store: Store, client: Anthropic, model: string, repo: string, finding: Finding, outcome: FindingOutcome): Promise<Lesson | null> {
  if (!isCorrective(outcome)) return null;
  const lesson = await deriveLesson(client, model, repo, finding, outcome);
  if (!lesson) return null;
  // Deduplicate against active lessons with the same first sentence; strengthen instead of repeating.
  const existing = store.lessons(repo, [], 200).find((l) => firstSentence(l.text) === firstSentence(lesson.text));
  if (existing) return existing;
  return store.addLesson({ repo: lesson.repo, pathPrefix: lesson.pathPrefix, text: lesson.text, sourceFindingId: lesson.sourceFindingId, confidence: lesson.confidence });
}

const firstSentence = (t: string) => t.split(/[.!?]/)[0]!.trim().toLowerCase();
