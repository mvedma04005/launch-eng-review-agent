import { z } from 'zod/v4';

export const FindingInputSchema = z.object({
  rule_id: z.string().optional().describe('Policy rule id this finding applies, when one fits.'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  path: z.string().describe('Repository-relative path.'),
  side: z.enum(['RIGHT', 'LEFT']).describe('RIGHT cites the PR head; LEFT cites a deleted line in the base.'),
  line: z.number().int().min(1),
  title: z.string().min(3).max(200),
  scenario: z.string().min(3).max(2500).describe('Concrete triggering scenario or precondition.'),
  impact: z.string().min(3).max(2500),
  evidence: z.string().min(1).max(500).describe('Verbatim excerpt from the cited line, used by the host to verify the anchor.'),
  fix: z.string().min(3).max(2500).describe('Smallest practical fix, or a precise question.'),
});
export type FindingInput = z.infer<typeof FindingInputSchema>;

export const ReviewSubmissionSchema = z.object({
  summary: z.string().min(3).max(2500),
  reviewed_files: z.array(z.string()).describe('Every in-scope changed file you inspected.'),
  lenses_completed: z.array(z.string()),
  findings: z.array(FindingInputSchema),
  questions: z.array(z.string().max(1000)).default([]).describe('Open questions for the author that are not findings.'),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;

export const VerificationSchema = z.object({
  real: z.boolean().describe('True only if the cited code, read in context, actually has the described problem.'),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(800),
});

export const LessonSchema = z.object({
  lesson: z.string().max(600).nullable().describe('A general, reusable lesson for future reviews of this repository, or null if the feedback does not generalize.'),
  path_prefix: z.string().max(200).describe('Directory prefix the lesson applies to, or empty for the whole repository.'),
  confidence: z.number().min(0).max(1),
});
