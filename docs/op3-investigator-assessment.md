# OP3 Investigator: how it works and what it means for us

Source: `ROKT/op3` at `apps/op3-investigator` (commit `a1bedeb`, 10 Nov 2026), its architecture docs, the PR review runbook, and the OP3 review space. Owner is `@ROKT/op3`.

## What it is

A Go service that turns a signal (One Platform feedback, a Google Chat question, a Datadog alert, a Buildkite failure, or a pull request) into an evidence-backed investigation run by Claude Code inside a single-purpose Kubernetes Job, with every input, run, step and finding persisted in PostgreSQL. It is large and mature: about 80k lines of Go, 113k lines of Go tests, 131 migrations, 25k lines of design docs, rules and lessons, deployed to the `eks-2` cluster through Buildkite and Deploy Kit with nightly production promotion and Datadog metrics.

## How the PR review lane works

| Step | Mechanism |
| --- | --- |
| Identity | Posts as the Google Chat app `op3-investigator` and the GitHub App `op3-investigator[bot]`. The agent Job never holds the write token; the host mints an OP3-only token with pull-request write and publishes. |
| Intake | Three paths, each a flag: a PR link in the review space (`PR_REVIEW_ENABLED`), automatic sweeps of open human PRs after a cutover date (`PR_REVIEW_AUTOMATIC_ENABLED`, on in prod since 28 Oct), and `@op3-investigator adversarial review` comments on the PR (`PR_REVIEW_GITHUB_ENABLED`). Requests are admitted transactionally in Postgres with revision dedup and a three-round manual cap per PR. |
| Size limit | PRs over 750 changed lines are refused with a request to split. |
| Preparation | The host clones at depth 64 with a read-only credential, fetches and verifies the pinned head and base, checks out the head, writes the full diff and changed-path list, and snapshots the trusted policy from master (root `REVIEW.md`, matched rules, ancestor instructions, specialist reviewer procedures). Budgets: 8 MiB evidence, 3 minutes. No partial manifest is ever published. |
| Review | Claude Code in a Job with no network, no code execution, no write tools, reading the manifest and the checkout. Model is Sonnet 5.5 via Bedrock for reviews, at medium effort. The runbook is a 550-line "strict ruleset v1" adapted from Rokt Code's `pr-review` skill. |
| Result contract | Nine mandatory gates (intent, op3_rules, ownership, logic, authorization, contracts, tests, ci, deployment), each pass, fail, uncertain or not_applicable with evidence; a verdict; a confidence; up to 40 inline comments at 8 KB each; a 600-byte Chat summary. The host rejects missing gates, approvals with uncertain gates, and incomplete results. |
| Verdict rules | REQUEST_CHANGES needs a proven blocking defect. APPROVE needs every gate supported, high confidence, and a verified human approval on the exact head for schema, contract, integration or authorization changes. Medium confidence is always COMMENT with the uncertain gate named. Pending CI never blocks publication. |
| Publication | One review POST with an explicit commit id, marker reconciliation for ambiguous writes, a database lease serializing publishers across replicas, bounded retries that park for operator replay with the finding retained. A notice says comment-only reviews do not withdraw earlier verdicts. |
| Concurrency | Four replicas times five in-flight is twenty investigation slots; the namespace quota admits ten agent Jobs at a time with capacity deferral instead of failed attempts. Five reviews started in the same second last night. |
| Observability | Datadog: intake, dispatch, completion by verdict and confidence, requeued, reclaimed, abandoned, backlog by status, oldest actionable age, duration, cost in dollars, GitHub poll lag and rate-limit budget. Pages only on sustained throughput failure, never on single failures. An operator-declared "time saved" field per review. |
| Learning | A living `docs/lessons.md`, promoted to `docs/rules/` when recurring, plus an offline historical evaluation set with a replay protocol. No automatic feedback capture. |

In the review space tonight it answered within seconds ("👀 Looking"), finished in 3 to 8 minutes, ran several PRs in parallel, and humans used `re-review`, `rereview` and `override` as commands.

## What blocks simply onboarding launch-engineering

It is hard-wired to one repository and one team's policy:

- The runbook opens with "Review only the `ROKT/op3` pull request". Request keys, poll cursors, the fixed clone remote and the comment-command parser all name `ROKT/op3`. The design doc states other repositories launch no work.
- The nine gates and the X0 to X4 change classes encode OP3's review bar and delivery process. Launch-engineering would need its own policy source and its own gate set.
- One Chat space constant, one GitHub App installation, shared Job quota in the OP3 namespace, and the `@ROKT/op3` team's roadmap.

Generalizing it is a real project for them: a repository registry, per-repository policy roots and runbooks, per-repository space and App installation, and quota partitioning. It is the right long-term shape for the company, but it is not a switch we can flip this month.

## What to take from it now

Its decisions are the ones the rebuild already made, with better evidence behind them. Adopt these directly:

1. Host-prepared, immutable evidence: pinned head and base, local clone, policy snapshot from the trusted branch, never from the PR. The scaffold does this through its mirror and worktree.
2. A result contract the host validates, with gates and a confidence, and a hard rule that medium confidence is comment-only. Added to the scaffold.
3. A changed-line cap with a request to split. Added to the scaffold as `budgets.maxChangedLines`, default 750.
4. One publication per head with marker reconciliation, a publisher lease, and bounded retries that park with the finding retained for replay. The scaffold has the first two; parking for replay is next.
5. Alert on sustained stall, never on one failure. The scaffold's queue-age and spend gauges are the right inputs.
6. A notice that a comment-only review does not withdraw earlier verdicts.
7. The eval replay protocol: same model, settings, policy commit and tools for baseline and candidate; constructed buggy and fixed commit pairs; fresh conversation per case.

## Recommendation

Run two tracks.

- **Now, launch-engineering owned:** ship Falcon v2 for `ROKT/launch-engineering` on a host that is not a laptop, with the result contract, limits and verdict rules aligned to OP3 Investigator's. This ends the outage pattern in weeks, not quarters.
- **In parallel, with `@ROKT/op3`:** propose a multi-repository PR review lane in OP3 Investigator with per-repository policy packs, and offer Falcon's policy-pack format and launch-engineering as the second tenant. If they take it, Falcon v2 becomes that tenant's policy and evaluation set rather than a separate service. Aligning contracts now keeps that merge cheap.

The question for you is whether to open that conversation with the OP3 team this week.
