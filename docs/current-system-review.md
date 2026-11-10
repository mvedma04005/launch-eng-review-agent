# Review of the current Launch Engineering review agent

Scope: `agent.py`, `review.py`, `auth.py`, `usage.py`, `launch_agent.py`, `deploy/`, and the test suite at commit `dcb4d54`. Read in full by one reviewer and independently by three others, one per module. Line references are to that commit.

## Verdict

The agent is a careful single-operator prototype. Its best ideas are real and worth keeping: commit-anchored, deduplicated reviews; a model with no tools or credentials; host-side verification of every finding; a durable outbox. Its structure cannot become a team tool: it runs as one person's Google and GitHub identity on one laptop, reviews one PR at a time, hardcodes the repository, the space, the operator, the policy, and three files on Justin's disk, and has no way to learn from feedback. Those are design choices, not bugs, and they are the reason it keeps breaking when the laptop or the person is unavailable.

## Structural flaws (would recur in a rebuild if not designed out)

1. **Identity is a person.** Google OAuth as `justin.lee@rokt.com` (auth.py:26) and GitHub as `justinlee1253` (agent.py:55). Approvals satisfy branch protection as a human approval, distinguishable from Justin's own only by an HTML comment (review.py:109). The operator cannot use the tool (own messages are dropped, agent.py:280). Handover means a new browser grant, a new GitHub identity, and code edits. In the cloud variant the proxy pins GitHub identity to the session owner, so the problem moves rather than disappears.
2. **Trigger is a chat poll by a human account.** The source of truth for "review this" is a 2-second scan of a Google Chat space with a 2-minute lookback (agent.py:463-485). It is quota-bound, single-space, and needs a consent flow that only works with a browser on the same machine. GitHub already emits the events the agent needs.
3. **One worker, one process, no leases.** A single review thread (agent.py:549), a process-wide file lock (agent.py:505-513), and a select-then-update `claim()` with no owner or expiry (agent.py:341-346). Ten simultaneous requests wait for ten sequential multi-minute reviews; a second instance anywhere duplicates work; a crash mid-review strands the job in `needs-attention` forever (agent.py:542-546).
4. **Required context lives on Justin's laptop.** `local_context()` reads three absolute paths under `/Users/jklee/...` and holds the review if any is missing (review.py:325-337). Every non-STAMP review on any other host, including the cloud deployment, is held. The test suite stubs this out, so it never fails a test.
5. **Evidence is assembled by hundreds of REST calls per PR.** Each changed file costs tree walks plus a blob fetch (review.py:205-262), repeated for before and after, with no retry, backoff, ETag, or rate-limit handling (review.py:135-145). A few 150-file PRs exhaust a user's 5000 requests/hour; any 403 holds the job.
6. **The model loop re-sends everything.** Each `needs_evidence` round spawns a fresh Codex process with the entire evidence blob (up to 1.2 MB) and no memory of prior rounds, up to eight times (review.py:509-532). Cost is bounded by time and characters, never by money; a worst-case PR is hundreds of dollars.
7. **Everything is hardcoded.** Repository allowlist, space, self-user, operators, poll interval, worker count, STAMP phrases and contact email, Admin-UI conventions inside the policy prose, skill path (agent.py:30-34, review.py:20-24, 312-317, review-policy.md). "What good looks like" is a single global Markdown file plus a private skill file.
8. **Verdict is binary and strong.** The bot APPROVEs when it finds no blockers. For a tool meant to be trusted daily, approval authority should be an explicit, per-repository policy decision, and the default should be a comment plus a check run.
9. **No feedback loop.** Reactions are outbound only; nothing records what humans did with a finding (review.py, agent.py). The only "learning" is a hand-maintained `Orbit/tasks/lessons.md` read as context.
10. **Operations are silent.** A Chat 401/403 pauses intake permanently until a human runs `check-chat --resume` (agent.py:425-428); exceptions are reduced to their class name (agent.py:544); events dedupe on type so a second outage leaves no record (agent.py:183-187); nothing alerts.
11. **Model coupling.** Thirty Codex-specific flags, string-matched error messages, and a JSONL event parser (review.py:434-504). Swapping providers means rewriting the invocation, usage accounting, and event filter.
12. **Fail-closed budgets with no triage.** 150 files, 250 KB per file, 1.2M characters; a PR touching a lockfile or snapshot is held for manual review (review.py:23-24, 263). Generated and vendored files are not distinguished from source.

## Local bugs worth knowing about

- LEFT-side anchors are generated for context lines, which GitHub rejects with 422; the resulting `AmbiguousWrite` strands a finished review (review.py:298-299, 577-578, 122-151).
- Any non-zero exit on a write is "ambiguous", and reconciliation demands exactly one match or goes terminal, so a deterministic 422 or a rate limit loses the completed model output (review.py:617-622).
- `\bSTAMP\b` anywhere in a message switches to stamp mode and then rejects anything but two exact phrases (agent.py:292-307).
- One acknowledgment per message even when it contains several PR links (agent.py:331-333).
- Timestamps are compared as strings, so mixed fractional precision mis-orders requests (agent.py:231, 270).
- The documented grant-repair path cannot clear a `blocked` auth state; only a browser re-authorization can (auth.py:199-201 vs deploy/CLOUD.md).
- `stop.sh` waits 30 s while the worker joins for 45 s, so graceful stops report failure.

## What to carry forward

- Commit-anchored reviews with a marker, same-head deduplication, head-moved cancellation with a stability delay, and reserve-then-reconcile writes instead of blind retries.
- Pre-flight gates before spending tokens: draft, closed, merged, CI pending or failed, bot author.
- Host-side verification of every finding: file and line must exist at the captured commit and the quoted evidence must be on that line; the host, not the model, picks the GitHub event.
- Model isolation: no tools, scrubbed environment, schema-constrained output.
- Idempotent outbox with deterministic request ids; checkpoint committed in the same transaction as the work it covers.
- The review policy's ethos: material blockers only; style never blocks; a clean approval is a successful review.

## Against the four primitives

| Primitive | Today |
| --- | --- |
| Configurable rules | One global Markdown file plus a private skill on one laptop; no per-repository or per-path rules, severities, or suppressions. |
| Hundreds of concurrent PRs | One worker, one process, REST-per-file evidence, a human account's GitHub quota. |
| Daily reliability and trust | Silent holds, no alerting, no retries, approval as a human, state inside a laptop checkout. |
| Learns from feedback | Nothing captured. |
