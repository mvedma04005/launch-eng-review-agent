# Falcon v2 against OP3 Investigator: what is missing

Decision: build our own, on a dedicated Mac, borrowing the OP3 team's proven design. This compares the scaffold on the `rebuild` branch with `apps/op3-investigator` capability by capability. "Added" means added on 10 Nov after this comparison.

## Closed tonight

| Capability | OP3 Investigator | Falcon v2 |
| --- | --- | --- |
| Policy cannot be changed by the PR it governs | Policy snapshot from the trusted master commit; PR copies are evidence only | **Added.** Repository policy and instruction files are read from the base branch; the reviewer is told when the PR edits them |
| Finished review survives publication failure | Finding persisted; publisher retries, parks after N passes with the finding retained for operator replay | **Added.** Rendered review saved before posting; retried with backoff; parked after 12 attempts; `falcon replay <id>` republishes without a model run |
| Author sees that the bot is working and why it stopped | "👀 Looking" in Chat; GitHub notices on refusal | **Added.** Check run goes to "in progress" when the review starts and completes with the verdict, or with the reason the review was held or refused |
| Secrets cannot leak through a review | Redaction of held credentials before persistence and publication; bounded text | **Added.** Held secrets and credential shapes redacted; body, comment and summary sizes bounded on UTF-8 boundaries |
| Operator can see what the agent did | Per-step activity trail with drop counters | **Added.** Every tool call recorded per job: tool, bounded input, duration, outcome; in `falcon job`, the dry-run output and `/api/jobs/:id` |
| One bad review cannot take the service down | Kubernetes Job per investigation with `activeDeadlineSeconds` and resource limits | **Added.** Each review runs in a child process with a hard kill timer; the daemon requeues or fails the job on exit |
| Stage before production | Stage environment in dry-run | **Added.** `dryRun: true` in the daemon config runs the full pipeline and retains the rendered review without posting |
| Alerts | Datadog monitors: page on sustained stall, never on one failure | **Added.** Stall, spend near cap, repeated failures; edge-triggered to a Chat or Slack webhook; logged when none |
| GitHub rate limits | Budgeted pollers, rate-limit preflight and telemetry | **Added.** Octokit throttling plugin backs off on primary and secondary limits and counts them |
| Confidence and verdict discipline | Nine gates with evidence; medium confidence is comment-only; 750-line cap | Added earlier: confidence in the result, comment-only on medium, non-withdrawal notice, `maxChangedLines` |

## Still open, in priority order

| Capability | OP3 Investigator | Falcon v2 | Plan |
| --- | --- | --- | --- |
| Intake by command | `@op3-investigator adversarial review` on the PR with requester permission checks, bot allowlist, edit-history check; `re-review`, `override` in Chat; three manual rounds per PR | Automatic polling only; command parser exists but no poller | Phase 1: poll PR comments for `/falcon review` and `/falcon re-review`, require write permission, dedupe by comment id, cap manual rounds |
| Google Chat as a request and summary channel | Chat app identity, allowlisted spaces, Pub/Sub, attempt-scoped request ids | None | Decision needed. If kept, a Chat app (not a human) posting a one-line summary per review into the LE space, same durable outbox pattern as v1 |
| Structured coverage evidence | Nine mandatory gates each with evidence; host rejects approvals with uncertain or missing gates | Lenses are free text; findings and confidence are structured | Phase 1 with the LE policy pack: gates per lens with evidence, host-enforced before approve |
| Repeat-review semantics | Delta review: do not repeat resolved comments; reuse earlier findings | "Still open from an earlier head" marker only | Phase 2: carry resolved thread state and prior finding outcomes into the prompt and the renderer |
| Human approval before bot approval on risky changes | Approval withheld on schema, contract, integration or authorization changes until a non-author human approves the exact head | Not implemented | Phase 2 policy option: `verdict.requireHumanApprovalFor` globs, checked against reviews on the head |
| Depth modes and comment budgets | lite / default / deep; 40 comments; 5 inline nits; "N Important, N Nit" summary | Severity and blocking only | Policy pack content plus small renderer caps; Phase 1 |
| Run resumption | Partial conclusions checkpointed so a retried attempt does not start from zero | A killed review restarts from scratch | Phase 2: checkpoint accepted findings every N tool calls and feed them into the retry prompt |
| Evaluation set | Offline historical cases with a replay protocol | Planned only | Phase 2: `falcon eval` with constructed buggy/fixed commit pairs, same model, policy commit and tools for baseline and candidate |
| Model access | Bedrock cross-account inference | Anthropic API direct | Decision needed. The SDK supports Bedrock through the Mantle client; a one-line client swap if governance requires it |
| Time saved | Operator-declared minutes per review, audited | None | Later; cheap once the dashboard has write actions |
| Multi-host | Postgres leases across replicas, Kubernetes quota | SQLite on one Mac | Not needed on a Mac. The store is behind an interface if a second host is ever required |

## Where Falcon v2 is ahead

- Feedback capture from reactions, replies, resolutions, next-push line changes and merges, keyed by stable finding fingerprint.
- Lessons derived from corrective feedback and injected into the prompt per repository, bounded and deduplicated.
- Independent verifier pass on blocking findings before anything blocks.
- Per-review dollar and token caps enforced inside the model loop, plus daily caps per repository and global.
- Policy packs with a central authority ceiling that repositories cannot raise.
- Installation on a Mac is one script; no cluster, no Postgres, no mesh.

## Decisions for you

1. Google Chat: keep as a summary channel through a Chat app, or rely on GitHub only?
2. Command intake on the PR (`/falcon review`): wanted in phase 1?
3. Bedrock or the Anthropic API for inference?
4. Who owns the launch-engineering policy pack, and what are its gates?
