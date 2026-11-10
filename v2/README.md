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

Layout: `src/policy` (packs, merge, enforcement), `src/queue` (SQLite store with leases), `src/evidence` (git mirror, worktree, diff anchors), `src/reviewer` (tools, validation, prompts, Claude), `src/publisher` (render, GitHub), `src/ingress` (auth, polling), `src/feedback`, `src/learning`, `src/worker.ts`, `src/serve.ts`, `src/cli.ts`. Engine policy: `policies/default.yaml`.
