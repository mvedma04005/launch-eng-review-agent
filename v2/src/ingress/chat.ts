import { JWT } from 'google-auth-library';
import { isAllowedRepo, type Config } from '../config.ts';
import type { Logger } from '../log.ts';
import { metrics } from '../metrics.ts';
import type { Store } from '../queue/store.ts';
import type { ChatRequest, Job, PullMeta } from '../types.ts';

/**
 * Google Chat as the front door, the way OP3 Investigator does it: the engine is a Chat *app* (its own identity),
 * events reach it through a Pub/Sub subscription it pulls from (works behind NAT, nothing inbound), it answers
 * "👀 Looking" in the thread before it touches GitHub, and every reply goes through a durable, idempotent outbox.
 * An app-authenticated poll of the allowlisted spaces catches bare links posted without a mention.
 */

export const CHAT_SCOPES = ['https://www.googleapis.com/auth/chat.bot', 'https://www.googleapis.com/auth/chat.app.messages.readonly'];
export const PUBSUB_SCOPES = ['https://www.googleapis.com/auth/pubsub'];

export interface TokenProvider { token(): Promise<string> }

/** Service-account credentials from the JSON key Google issues; never from a person's login. */
export function serviceAccountTokens(json: string, scopes: string[]): TokenProvider {
  const key = JSON.parse(json) as { client_email?: string; private_key?: string };
  if (!key.client_email || !key.private_key) throw new Error('service account JSON needs client_email and private_key');
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes });
  return {
    async token() {
      const { token } = await client.getAccessToken();
      if (!token) throw new Error('no access token for the Chat service account');
      return token;
    },
  };
}

export interface ChatMessage {
  name: string;
  space: string;
  thread: string;
  sender: { name: string; type: string; email?: string | undefined };
  text: string;
  createTime: string;
}

export interface ChatApi {
  reply(space: string, thread: string, text: string, requestId: string): Promise<{ name: string }>;
  listMessages(space: string, sinceIso: string, pageToken?: string): Promise<{ messages: ChatMessage[]; nextPageToken?: string | undefined }>;
}

export class GoogleChatApi implements ChatApi {
  private readonly tokens: TokenProvider;
  constructor(tokens: TokenProvider) { this.tokens = tokens; }

  async reply(space: string, thread: string, text: string, requestId: string) {
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    url.searchParams.set('requestId', requestId);
    const response = await fetch(url, { method: 'POST', headers: await this.headers(), body: JSON.stringify({ text, thread: { name: thread } }) });
    if (!response.ok) throw new ChatHttpError(response.status, await response.text());
    return (await response.json()) as { name: string };
  }

  async listMessages(space: string, sinceIso: string, pageToken?: string) {
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('orderBy', 'createTime ASC');
    url.searchParams.set('filter', `createTime > "${sinceIso}"`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, { headers: await this.headers() });
    if (!response.ok) throw new ChatHttpError(response.status, await response.text());
    const data = (await response.json()) as { messages?: unknown[]; nextPageToken?: string };
    return { messages: (data.messages ?? []).map(parseChatEvent).filter((m): m is ChatMessage => m !== null), nextPageToken: data.nextPageToken };
  }

  private async headers() { return { authorization: `Bearer ${await this.tokens.token()}`, 'content-type': 'application/json' }; }
}

export class ChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, body: string) { super(`Chat API ${status}: ${body.slice(0, 200)}`); this.status = status; }
}

/** Pub/Sub over REST: long-poll pull plus acknowledge. No gRPC dependency, no inbound port. */
export class PubSubPuller {
  private readonly tokens: TokenProvider;
  private readonly base: string;
  constructor(tokens: TokenProvider, project: string, subscription: string) {
    this.tokens = tokens;
    this.base = `https://pubsub.googleapis.com/v1/projects/${project}/subscriptions/${subscription}`;
  }
  async pull(maxMessages = 10): Promise<Array<{ ackId: string; event: unknown }>> {
    const response = await fetch(`${this.base}:pull`, { method: 'POST', headers: await this.headers(), body: JSON.stringify({ maxMessages }) });
    if (!response.ok) throw new ChatHttpError(response.status, await response.text());
    const data = (await response.json()) as { receivedMessages?: Array<{ ackId: string; message?: { data?: string } }> };
    return (data.receivedMessages ?? []).map((m) => {
      let event: unknown = null;
      try { event = m.message?.data ? JSON.parse(Buffer.from(m.message.data, 'base64').toString('utf8')) : null; } catch { event = null; }
      return { ackId: m.ackId, event };
    });
  }
  async ack(ackIds: string[]): Promise<void> {
    if (!ackIds.length) return;
    const response = await fetch(`${this.base}:acknowledge`, { method: 'POST', headers: await this.headers(), body: JSON.stringify({ ackIds }) });
    if (!response.ok) throw new ChatHttpError(response.status, await response.text());
  }
  private async headers() { return { authorization: `Bearer ${await this.tokens.token()}`, 'content-type': 'application/json' }; }
}

/** Accepts a Chat event envelope ({type: "MESSAGE", message}) or a bare message resource from messages.list. */
export function parseChatEvent(event: unknown): ChatMessage | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: string; message?: Record<string, unknown> } & Record<string, unknown>;
  if (e.type && e.type !== 'MESSAGE') return null;
  const m = (e.message ?? e) as { name?: string; space?: { name?: string }; thread?: { name?: string }; sender?: { name?: string; type?: string; email?: string }; text?: string; argumentText?: string; createTime?: string };
  if (typeof m.name !== 'string' || typeof m.createTime !== 'string') return null;
  const space = m.space?.name ?? m.name.split('/messages/')[0];
  const thread = m.thread?.name;
  if (!space || !thread) return null;
  return {
    name: m.name, space, thread,
    sender: { name: m.sender?.name ?? '', type: m.sender?.type ?? 'UNKNOWN', email: m.sender?.email },
    text: typeof m.text === 'string' ? m.text : '',
    createTime: m.createTime,
  };
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#][^\s<>)]*)?/g;

export function extractPullRequests(text: string): Array<{ repo: string; number: number }> {
  const seen = new Set<string>();
  const out: Array<{ repo: string; number: number }> = [];
  for (const m of text.matchAll(PR_URL)) {
    const key = `${m[1]!.toLowerCase()}#${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ repo: m[1]!, number: Number(m[2]) });
  }
  return out;
}

export interface ParsedCommand { command: 'review' | 're-review'; allowed: Array<{ repo: string; number: number }>; refused: string[] }

/** A bare link is a review request; "re-review <link>" asks for a fresh round on the same head. Everything else is ignored. */
export function parseChatCommand(config: Pick<Config, 'github'>, text: string): ParsedCommand | null {
  const stripped = text.replace(/<users\/[^>]+>/g, ' ').replace(/@\S+/g, ' ');
  const prs = extractPullRequests(stripped);
  if (!prs.length) return null;
  const command: ParsedCommand['command'] = /\bre-?review\b/i.test(stripped) ? 're-review' : 'review';
  const allowed = prs.filter((p) => isAllowedRepo(config, p.repo));
  const refused = [...new Set(prs.filter((p) => !isAllowedRepo(config, p.repo)).map((p) => p.repo))];
  return { command, allowed, refused };
}

export interface IntakeContext { config: Config; store: Store; log: Logger }

/** Records the request and queues the acknowledgement. Nothing here waits on GitHub; that is why pickup is fast. */
export function handleChatMessage(ctx: IntakeContext, msg: ChatMessage): 'recorded' | 'ignored' | 'duplicate' | 'refused' {
  const { config, store } = ctx;
  if (!config.chat.spaces.includes(msg.space)) return 'ignored';
  if (msg.sender.type !== 'HUMAN') return 'ignored';
  const parsed = parseChatCommand(config, msg.text);
  if (!parsed) return 'ignored';
  const only = config.github.repos.join(', ');
  if (parsed.refused.length) {
    store.queueChatReply(`scope:${msg.name}`, msg.space, msg.thread, `Only ${only} is reviewed here. Not queued: ${parsed.refused.join(', ')}.`);
    metrics.feedback.inc({ repo: 'chat', signal: 'scope_refused' });
  }
  if (!parsed.allowed.length) return 'refused';
  let recorded = 0;
  for (const pr of parsed.allowed) {
    const request = store.addChatRequest({ messageName: `${msg.name}#${pr.repo}/${pr.number}`, space: msg.space, thread: msg.thread, sender: msg.sender.name, senderEmail: msg.sender.email ?? null, repo: pr.repo, number: pr.number, command: parsed.command });
    if (!request) continue;
    recorded++;
    const ahead = store.snapshot().byStatus['queued'] ?? 0;
    store.queueChatReply(`ack:${request.id}`, msg.space, msg.thread, `👀 Looking at ${pr.repo}#${pr.number}${parsed.command === 're-review' ? ' (fresh review requested)' : ''}${ahead ? ` · ${ahead} ahead in the queue` : ''}`);
    ctx.log.info({ request: request.id, repo: pr.repo, number: pr.number, command: parsed.command, sender: msg.sender.name }, 'chat request recorded');
  }
  return recorded ? 'recorded' : 'duplicate';
}

/**
 * Turns recorded requests into review jobs once GitHub answers with the current head. Transient GitHub failures
 * retry with backoff; the requester already has an acknowledgement, so nothing is lost while GitHub is slow.
 */
export async function resolvePendingChatRequests(ctx: IntakeContext, pull: (repo: string, number: number) => Promise<PullMeta>, nowSec = Date.now() / 1000): Promise<number> {
  const { config, store } = ctx;
  let resolved = 0;
  for (const req of store.pendingChatRequests(nowSec)) {
    const refuse = (text: string) => { store.setChatRequest(req.id, { status: 'refused', note: text }); store.queueChatReply(`refused:${req.id}`, req.space, req.thread, `⚠️ ${req.repo}#${req.number}: ${text}`); };
    try {
      const meta = await pull(req.repo, req.number);
      if (meta.state !== 'open' || meta.merged) { refuse(meta.merged ? 'the PR is already merged; nothing to review.' : 'the PR is closed; nothing to review.'); continue; }
      if (meta.authorType === 'Bot') { refuse('bot-authored PRs are not reviewed.'); continue; }
      const { job, created } = store.enqueue({ repo: req.repo, number: req.number, headSha: meta.headSha, baseSha: meta.baseSha, baseRef: meta.baseRef, trigger: 'comment', requestedBy: req.senderEmail ?? req.sender, receivedAt: new Date().toISOString() }, 10);
      if (!created && job.status === 'published') {
        const result = job.resultJson ? (JSON.parse(job.resultJson) as { reviewUrl?: string }) : {};
        store.setChatRequest(req.id, { status: 'delivered', jobId: job.id, note: 'already reviewed at this head' });
        store.queueChatReply(`already:${req.id}`, req.space, req.thread, `${req.repo}#${req.number} was already reviewed at ${meta.headSha.slice(0, 8)}.${result.reviewUrl ? ` Review: ${result.reviewUrl}` : ''}${req.command === 're-review' ? ' Push a new commit for a fresh review.' : ''}`);
        resolved++;
        continue;
      }
      if (!created && ['held', 'failed', 'cancelled', 'skipped'].includes(job.status)) {
        if (store.chatRoundsForPr(req.repo, req.number) >= config.chat.maxRoundsPerPr) { refuse(`this PR has used its ${config.chat.maxRoundsPerPr} manual review rounds.${config.github.pollSeconds > 0 ? ' Push a new commit for an automatic review.' : ' Ask a team member to review it.'}`); continue; }
        store.requeue(job.id, 0, `chat ${req.command} by ${req.sender}`);
      } else if (created && store.chatRoundsForPr(req.repo, req.number) >= config.chat.maxRoundsPerPr) {
        store.finish(job.id, 'cancelled', { error: 'manual rounds exhausted' });
        refuse(`this PR has used its ${config.chat.maxRoundsPerPr} manual review rounds.${config.github.pollSeconds > 0 ? ' Push a new commit for an automatic review.' : ' Ask a team member to review it.'}`);
        continue;
      }
      store.setChatRequest(req.id, { status: 'queued', jobId: job.id });
      metrics.feedback.inc({ repo: req.repo, signal: created ? 'chat_queued' : 'chat_attached' });
      resolved++;
    } catch (error) {
      const attempts = req.attempts + 1;
      if (attempts >= 6) { refuse('GitHub could not be reached for this PR. Post the link again later.'); metrics.errors.inc({ component: 'chat_resolve' }); continue; }
      store.setChatRequest(req.id, { attempts, nextAttemptAt: nowSec + Math.min(120, 5 * 2 ** attempts) });
      ctx.log.warn({ err: error, request: req.id, attempts }, 'chat request could not resolve its PR yet');
    }
  }
  return resolved;
}

/** Sends queued replies: one Chat write per call per reply, idempotent through requestId, backoff on failure. */
export async function flushChatOutbox(store: Store, chat: ChatApi, log: Logger, nowSec = Date.now() / 1000): Promise<number> {
  let sent = 0;
  for (const reply of store.pendingChatReplies(nowSec)) {
    try {
      const { name } = await chat.reply(reply.space, reply.thread, reply.text, reply.id);
      store.markChatReply(reply.id, 'sent', name, nowSec);
      sent++;
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      const permanent = status === 400 || status === 403 || status === 404 || reply.attempts >= 8;
      store.markChatReply(reply.id, permanent ? 'failed' : 'retry', undefined, nowSec);
      metrics.errors.inc({ component: 'chat_outbox' });
      log.warn({ err: error, reply: reply.id, permanent }, 'chat reply failed');
      if (status === 429 || status >= 500) break; // let the backoff breathe
    }
  }
  return sent;
}

/** Reads bare links posted without a mention. Requires the app to hold chat.app.messages.readonly; otherwise it fails fast and is logged once. */
export async function pollChatSpaces(ctx: IntakeContext, chat: ChatApi): Promise<number> {
  let recorded = 0;
  for (const space of ctx.config.chat.spaces) {
    const key = `chat:${space}`;
    const since = ctx.store.cursor(key) ?? new Date(Date.now() - 10 * 60_000).toISOString();
    let token: string | undefined;
    let newest = since;
    do {
      const page = await chat.listMessages(space, since, token);
      for (const msg of page.messages) {
        if (msg.createTime > newest) newest = msg.createTime;
        if (handleChatMessage(ctx, msg) === 'recorded') recorded++;
      }
      token = page.nextPageToken;
    } while (token);
    if (newest !== since) ctx.store.setCursor(key, newest);
  }
  return recorded;
}

export interface Outcome { status: 'published' | 'skipped' | 'held' | 'deferred' | 'dry_run'; reason?: string | undefined; reviewUrl?: string | undefined; event?: string | undefined; summary?: string | undefined; confidence?: string | undefined }

export function chatOutcomeText(job: Pick<Job, 'repo' | 'number' | 'headSha'>, outcome: Outcome): string | null {
  const pr = `${job.repo}#${job.number}`;
  const head = job.headSha.slice(0, 8);
  switch (outcome.status) {
    case 'published': {
      const headline = outcome.event === 'APPROVE' ? '✅ Review complete — Approved' : outcome.event === 'REQUEST_CHANGES' ? '🛑 Review complete — Changes requested' : '💬 Review complete — comments only';
      const confidence = outcome.confidence ? ` (confidence: ${outcome.confidence})` : '';
      return `${headline}${confidence}\n\n${outcome.summary ?? ''}${outcome.summary ? '\n\n' : ''}Full review: ${outcome.reviewUrl ?? ''}\nCommit: ${head}`;
    }
    case 'held': return `⚠️ ${pr} — Review held\n\n${outcome.reason ?? 'See the engine logs.'}\nCommit: ${head}`;
    case 'skipped': return `${pr} — Not reviewed\n\n${outcome.reason ?? ''}`;
    case 'dry_run': return `${pr} — Dry run complete; nothing was posted.`;
    default: return null;
  }
}

/** Called by the worker on every terminal outcome. Each requesting thread gets one reply; the outbox makes retries safe. */
export function deliverOutcome(store: Store, job: Job, outcome: Outcome): void {
  const text = chatOutcomeText(job, outcome);
  if (!text) return;
  for (const req of store.chatRequestsForJob(job.id)) {
    store.queueChatReply(`result:${req.id}:${outcome.status}`, req.space, req.thread, text);
    store.setChatRequest(req.id, { status: 'delivered' });
  }
}

export type { ChatRequest };
