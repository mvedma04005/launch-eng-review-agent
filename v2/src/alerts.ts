import type { Config } from './config.ts';
import type { QueueSnapshot } from './queue/store.ts';

/**
 * Page on sustained failure to advance work, never on one failed job. Alerts are edge-triggered: a message is
 * sent when a condition starts and when it clears, not every minute it persists.
 */
export type AlertKey = 'stalled' | 'spend_near_cap' | 'repeated_failures';

export interface AlertInput {
  snapshot: QueueSnapshot;
  /** When a job last reached published, skipped or held. Null if never in this process. */
  lastProgressAt: Date | null;
  /** Jobs that ended in `failed` during the last hour. */
  failedLastHour: number;
  now?: Date;
}

export function evaluateAlerts(config: Config, input: AlertInput): Map<AlertKey, string> {
  const now = input.now ?? new Date();
  const active = new Map<AlertKey, string>();
  const runnable = (input.snapshot.byStatus['queued'] ?? 0) + (input.snapshot.byStatus['leased'] ?? 0);
  const stallSec = config.alerts.stallMinutes * 60;
  const sinceProgress = input.lastProgressAt ? (now.getTime() - input.lastProgressAt.getTime()) / 1000 : Infinity;
  if (runnable > 0 && input.snapshot.oldestQueuedAgeSec > stallSec && sinceProgress > stallSec) {
    active.set('stalled', `Review queue stalled: ${runnable} job(s) waiting, oldest for ${Math.round(input.snapshot.oldestQueuedAgeSec / 60)} min, nothing finished for ${Number.isFinite(sinceProgress) ? Math.round(sinceProgress / 60) + ' min' : 'the whole run'}.`);
  }
  const cap = config.limits.daily.globalUsd;
  if (cap > 0 && input.snapshot.spendTodayUsd >= cap * config.alerts.spendWarnFraction) {
    active.set('spend_near_cap', `Model spend today is $${input.snapshot.spendTodayUsd.toFixed(2)} of the $${cap} daily cap.`);
  }
  if (input.failedLastHour >= config.alerts.failuresPerHour) {
    active.set('repeated_failures', `${input.failedLastHour} review(s) failed in the last hour.`);
  }
  return active;
}

export class AlertState {
  private active = new Set<AlertKey>();
  /** Returns the messages to send: new conditions and cleared ones. */
  transition(now: Map<AlertKey, string>): string[] {
    const messages: string[] = [];
    for (const [key, text] of now) if (!this.active.has(key)) { messages.push(`🔴 ${text}`); this.active.add(key); }
    for (const key of [...this.active]) if (!now.has(key)) { messages.push(`🟢 Cleared: ${key.replace('_', ' ')}.`); this.active.delete(key); }
    return messages;
  }
}

/** Google Chat and Slack incoming webhooks both accept {"text": "..."}. */
export async function notify(webhookUrl: string | undefined, text: string): Promise<boolean> {
  if (!webhookUrl) return false;
  const response = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  return response.ok;
}
