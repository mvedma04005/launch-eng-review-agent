# Falcon v2 review engine

TypeScript, Node 22+, no native dependencies. Design and rationale: [`../docs/rebuild-design.md`](../docs/rebuild-design.md). Review of the system it replaces: [`../docs/current-system-review.md`](../docs/current-system-review.md).

```bash
npm install
npm run typecheck
npm test
```

Dry run one PR (prints the review, posts nothing). Needs `ANTHROPIC_API_KEY` and either `GITHUB_TOKEN` or a GitHub App configured in `falcon.yaml`:

```bash
npm run falcon -- review https://github.com/ROKT/launch-engineering/pull/1234
```

Run the daemon:

```bash
npm run falcon -- serve
```

Operations. With `http.port` set in `falcon.yaml`, the daemon serves a read-only dashboard at `/`, Prometheus metrics at `/metrics`, and JSON at `/api/queue`, `/api/jobs`, `/api/jobs/:id`. From the command line:

```bash
npm run falcon -- status
```

```bash
npm run falcon -- jobs --limit 50
```

Limits: per-review tool calls, minutes, tokens and dollars come from the policy pack's `budgets`, clamped by `limits.perReview` in `falcon.yaml`; `limits.daily` caps spend per repository and globally per UTC day. Example `falcon.yaml`:

```yaml
stateDir: /Users/svc-falcon/Library/Application Support/falcon
github:
  appId: 123456
  repos: [ROKT/launch-engineering]
  pollSeconds: 30
workers: { concurrency: 8, perRepoConcurrency: 4 }
limits:
  perReview: { maxCostUsd: 10, maxMinutes: 25 }
  daily: { perRepoUsd: 200, globalUsd: 1000 }
http: { port: 8088 }
```

Layout: `src/policy` (packs, merge, enforcement), `src/queue` (SQLite store with leases), `src/evidence` (git mirror, worktree, diff anchors), `src/reviewer` (tools, validation, prompts, Claude), `src/publisher` (render, GitHub), `src/ingress` (auth, polling), `src/feedback`, `src/learning`, `src/worker.ts`, `src/serve.ts`, `src/cli.ts`. Engine policy: `policies/default.yaml`.
