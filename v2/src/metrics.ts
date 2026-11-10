/**
 * Dependency-free metrics registry rendered in Prometheus text format, which Datadog, the Grafana agent and
 * Prometheus all scrape. Gauges are computed at scrape time from the store, so they are never stale.
 */
type Labels = Record<string, string>;

const escapeLabel = (v: string) => v.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
const labelKey = (labels: Labels) =>
  Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
const withLabels = (name: string, k: string) => (k ? `${name}{${k}}` : name);

export class Counter {
  private readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) { this.name = name; this.help = help; }
  inc(labels: Labels = {}, by = 1): void { const k = labelKey(labels); this.values.set(k, (this.values.get(k) ?? 0) + by); }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${withLabels(this.name, k)} ${v}`);
    return lines.join('\n') + '\n';
  }
}

export class Histogram {
  private readonly rows = new Map<string, { buckets: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly bounds: number[];
  constructor(name: string, help: string, bounds: number[]) { this.name = name; this.help = help; this.bounds = bounds; }
  observe(value: number, labels: Labels = {}): void {
    const k = labelKey(labels);
    const row = this.rows.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((bound, i) => { if (value <= bound) row.buckets[i] = (row.buckets[i] ?? 0) + 1; });
    row.sum += value;
    row.count += 1;
    this.rows.set(k, row);
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, row] of this.rows) {
      const sep = k ? ',' : '';
      this.bounds.forEach((bound, i) => lines.push(`${this.name}_bucket{${k}${sep}le="${bound}"} ${row.buckets[i] ?? 0}`));
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${row.count}`);
      lines.push(`${withLabels(this.name + '_sum', k)} ${row.sum}`);
      lines.push(`${withLabels(this.name + '_count', k)} ${row.count}`);
    }
    return lines.join('\n') + '\n';
  }
}

export type GaugeSource = () => Array<{ labels: Labels; value: number }>;

export class Registry {
  private readonly counters: Counter[] = [];
  private readonly histograms: Histogram[] = [];
  private readonly gauges: Array<{ name: string; help: string; source: GaugeSource }> = [];
  counter(name: string, help: string): Counter { const c = new Counter(name, help); this.counters.push(c); return c; }
  histogram(name: string, help: string, bounds: number[]): Histogram { const h = new Histogram(name, help, bounds); this.histograms.push(h); return h; }
  gauge(name: string, help: string, source: GaugeSource): void { this.gauges.push({ name, help, source }); }
  render(): string {
    const out: string[] = [];
    for (const g of this.gauges) {
      const lines = [`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`];
      for (const { labels, value } of g.source()) lines.push(`${withLabels(g.name, labelKey(labels))} ${value}`);
      out.push(lines.join('\n') + '\n');
    }
    for (const c of this.counters) out.push(c.render());
    for (const h of this.histograms) out.push(h.render());
    return out.join('');
  }
}

/** One registry per process; the engine's metric set. */
export const registry = new Registry();
export const metrics = {
  jobsFinished: registry.counter('falcon_jobs_finished_total', 'Jobs finished, by repository and outcome.'),
  reviewsPublished: registry.counter('falcon_reviews_published_total', 'Reviews posted to GitHub, by repository and event.'),
  findings: registry.counter('falcon_findings_total', 'Findings published, by repository, severity and blocking.'),
  feedback: registry.counter('falcon_feedback_total', 'Feedback signals recorded, by repository and signal.'),
  tokens: registry.counter('falcon_model_tokens_total', 'Model tokens consumed, by repository and kind.'),
  costUsd: registry.counter('falcon_model_cost_usd_total', 'Estimated model spend in USD, by repository.'),
  errors: registry.counter('falcon_errors_total', 'Errors, by component.'),
  deferred: registry.counter('falcon_jobs_deferred_total', 'Jobs deferred, by reason.'),
  reviewSeconds: registry.histogram('falcon_review_duration_seconds', 'Wall time of a review from lease to finish.', [30, 60, 120, 300, 600, 900, 1800, 3600]),
  queueWaitSeconds: registry.histogram('falcon_queue_wait_seconds', 'Time a job waited before its first lease.', [5, 15, 30, 60, 120, 300, 900, 3600]),
  toolCalls: registry.histogram('falcon_review_tool_calls', 'Tool calls per review.', [5, 10, 20, 40, 60, 80, 120]),
};
