import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import { registry } from './metrics.ts';
import type { Store } from './queue/store.ts';

/**
 * Operator surface: /healthz, /metrics (Prometheus text), /api/queue, /api/jobs, /api/jobs/:id, and a plain HTML
 * dashboard at /. Read-only. Binds to localhost by default; put it behind your usual auth if exposed further.
 */
export function registerStoreGauges(store: Store): void {
  registry.gauge('falcon_queue_jobs', 'Jobs by status.', () => Object.entries(store.snapshot().byStatus).map(([status, value]) => ({ labels: { status }, value })));
  registry.gauge('falcon_queue_repo_jobs', 'Live jobs by repository and status.', () => store.snapshot().byRepo.flatMap((r) => [
    { labels: { repo: r.repo, status: 'queued' }, value: r.queued },
    { labels: { repo: r.repo, status: 'leased' }, value: r.leased },
    { labels: { repo: r.repo, status: 'waiting_ci' }, value: r.waiting_ci },
    { labels: { repo: r.repo, status: 'held' }, value: r.held },
  ]));
  registry.gauge('falcon_queue_oldest_wait_seconds', 'Age of the oldest runnable queued job.', () => [{ labels: {}, value: store.snapshot().oldestQueuedAgeSec }]);
  registry.gauge('falcon_spend_today_usd', 'Estimated model spend since 00:00 UTC.', () => [{ labels: {}, value: store.snapshot().spendTodayUsd }]);
}

export function startStatusServer(config: Config, store: Store, log: Logger): Server {
  const server = createServer((req, res) => {
    try { route(req, res, store); }
    catch (error) { log.error({ err: error }, 'status server error'); send(res, 500, 'text/plain', 'error'); }
  });
  server.listen(config.http.port, config.http.host, () => {
    const address = server.address();
    log.info({ address }, 'status server listening');
  });
  return server;
}

function route(req: IncomingMessage, res: ServerResponse, store: Store): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'application/json', JSON.stringify({ ok: true, at: new Date().toISOString(), jobs: store.counts() }));
  if (url.pathname === '/metrics') return send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', registry.render());
  if (url.pathname === '/api/queue') return send(res, 200, 'application/json', JSON.stringify(store.snapshot()));
  if (url.pathname === '/api/jobs') {
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50);
    return send(res, 200, 'application/json', JSON.stringify(store.recentJobs(limit)));
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (jobMatch) {
    const job = store.job(jobMatch[1]!);
    if (!job) return send(res, 404, 'application/json', '{"error":"not found"}');
    return send(res, 200, 'application/json', JSON.stringify({ job, usage: store.usageFor(job.id), steps: store.steps(job.id), events: store.eventsFor(job.id) }));
  }
  if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', dashboard(store));
  send(res, 404, 'text/plain', 'not found');
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c));

function dashboard(store: Store): string {
  const snap = store.snapshot();
  const recent = store.recentJobs(40);
  const statusRow = Object.entries(snap.byStatus).map(([s, n]) => `<span class="pill">${esc(s)} <b>${n}</b></span>`).join(' ');
  const repoRows = snap.byRepo.map((r) => `<tr><td>${esc(r.repo)}</td><td>${r.queued}</td><td>${r.leased}</td><td>${r.waiting_ci}</td><td>${r.held}</td></tr>`).join('');
  const leasedRows = snap.leased.map((l) => `<tr><td>${esc(l.repo)}#${l.number}</td><td><code>${esc(l.head)}</code></td><td>${esc(l.owner)}</td><td>${l.attempts}</td><td>${l.leaseExpiresInSec}s</td><td>${esc(l.since)}</td></tr>`).join('');
  const recentRows = recent.map((j) => `<tr><td><a href="/api/jobs/${esc(j.id)}">${esc(j.id.slice(0, 8))}</a></td><td>${esc(j.repo)}#${j.number}</td><td>${esc(j.status)}</td><td>${j.attempts}</td><td>${j.wallMs == null ? '' : Math.round(j.wallMs / 1000) + 's'}</td><td>${j.costUsd == null ? '' : '$' + j.costUsd.toFixed(3)}</td><td>${esc(j.updatedAt)}</td><td class="muted">${esc(j.error ?? '')}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>Falcon review engine</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:20px}h2{font-size:15px;margin-top:28px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}th{font-weight:600;color:#555}.pill{display:inline-block;background:#f1f1f1;border-radius:12px;padding:2px 10px;margin-right:6px}.muted{color:#777;font-size:12px}code{font-size:12px}.kpi{display:flex;gap:24px;margin:12px 0}.kpi div{background:#f7f7f7;padding:10px 14px;border-radius:8px}.kpi b{display:block;font-size:20px}</style></head><body>
<h1>Falcon review engine</h1>
<div class="muted">Snapshot ${esc(snap.at)} · refreshes every 15s · <a href="/metrics">/metrics</a> · <a href="/api/queue">/api/queue</a> · <a href="/api/jobs">/api/jobs</a></div>
<div class="kpi"><div>Oldest queued<b>${snap.oldestQueuedAgeSec}s</b></div><div>In review<b>${snap.leased.length}</b></div><div>Spend today (est.)<b>$${snap.spendTodayUsd.toFixed(2)}</b></div></div>
<p>${statusRow || '<span class="muted">no jobs yet</span>'}</p>
<h2>By repository</h2><table><tr><th>Repository</th><th>Queued</th><th>In review</th><th>Waiting CI</th><th>Held</th></tr>${repoRows || '<tr><td colspan="5" class="muted">none</td></tr>'}</table>
<h2>In review now</h2><table><tr><th>PR</th><th>Head</th><th>Worker</th><th>Attempt</th><th>Lease left</th><th>Since</th></tr>${leasedRows || '<tr><td colspan="6" class="muted">none</td></tr>'}</table>
<h2>Recent jobs</h2><table><tr><th>Job</th><th>PR</th><th>Status</th><th>Attempts</th><th>Wall</th><th>Cost</th><th>Updated</th><th>Note</th></tr>${recentRows || '<tr><td colspan="8" class="muted">none</td></tr>'}</table>
</body></html>`;
}
