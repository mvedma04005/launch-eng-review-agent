import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigSchema, isAllowedRepo } from '../config.ts';
import { log } from '../log.ts';
import { Store } from '../queue/store.ts';
import type { PullMeta } from '../types.ts';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleChatApi, chatOutcomeText, deliverOutcome, extractPullRequests, flushChatOutbox, handleChatMessage, parseChatCommand, parseChatEvent, keylessPublicJwks, resolvePendingChatRequests, serviceAccountTokens, signedNote, type ChatApi, type ChatMessage } from './chat.ts';

const SPACE = 'spaces/AAQAixK3auw';
const config = ConfigSchema.parse({ chat: { enabled: true, spaces: [SPACE], maxRoundsPerPr: 2 } });
const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  name: `${SPACE}/messages/m1`, space: SPACE, thread: `${SPACE}/threads/t1`, sender: { name: 'users/117476753422602532202', type: 'HUMAN', email: 'mani.vedma@rokt.com' },
  text: 'https://github.com/ROKT/launch-engineering/pull/585', createTime: '2026-11-10T00:43:11Z', ...over,
});
const meta = (over: Partial<PullMeta> = {}): PullMeta => ({ repo: 'ROKT/launch-engineering', number: 585, title: 't', body: '', author: 'ann', authorType: 'User', draft: false, state: 'open', merged: false, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRef: 'main', defaultBranch: 'main', headRef: 'f', changedFiles: 1, additions: 1, deletions: 1, labels: [], htmlUrl: 'u', cloneUrl: 'c', ...over });

test('the repository allowlist is exact and case-insensitive', () => {
  assert.ok(isAllowedRepo(config, 'ROKT/launch-engineering'));
  assert.ok(isAllowedRepo(config, 'rokt/Launch-Engineering'));
  assert.ok(!isAllowedRepo(config, 'ROKT/launch-engineering-docs'));
  assert.ok(!isAllowedRepo(config, 'ROKT/op3'));
  assert.throws(() => ConfigSchema.parse({ github: { repos: [] } }), /too_small|at least 1/i, 'an empty allowlist is refused');
});

test('chat events and bare message resources parse to the same shape; non-message events are ignored', () => {
  const fromEvent = parseChatEvent({ type: 'MESSAGE', eventTime: 'x', message: { name: `${SPACE}/messages/m9`, sender: { name: 'users/1', type: 'HUMAN' }, createTime: '2026-11-10T00:00:00Z', text: 'hi', thread: { name: `${SPACE}/threads/t` }, space: { name: SPACE } } });
  assert.equal(fromEvent?.space, SPACE);
  assert.equal(fromEvent?.thread, `${SPACE}/threads/t`);
  const fromList = parseChatEvent({ name: `${SPACE}/messages/m9`, sender: { name: 'users/1', type: 'HUMAN' }, createTime: '2026-11-10T00:00:00Z', text: 'hi', thread: { name: `${SPACE}/threads/t` } });
  assert.equal(fromList?.space, SPACE, 'space derived from the message name when absent');
  assert.equal(parseChatEvent({ type: 'ADDED_TO_SPACE', space: { name: SPACE } }), null);
  assert.equal(parseChatEvent('junk'), null);
});

test('PR links are extracted exactly; other repositories are refused; re-review is a command', () => {
  assert.deepEqual(extractPullRequests('see https://github.com/ROKT/launch-engineering/pull/585/files?x=1 and https://github.com/ROKT/launch-engineering/pull/585 again, plus https://github.com/ROKT/op3/pull/1'),
    [{ repo: 'ROKT/launch-engineering', number: 585 }, { repo: 'ROKT/op3', number: 1 }]);
  const parsed = parseChatCommand(config, '<users/123> re-review https://github.com/ROKT/launch-engineering/pull/600 https://github.com/ROKT/catalog/pull/7')!;
  assert.equal(parsed.command, 're-review');
  assert.deepEqual(parsed.allowed, [{ repo: 'ROKT/launch-engineering', number: 600 }]);
  assert.deepEqual(parsed.refused, ['ROKT/catalog']);
  assert.equal(parseChatCommand(config, 'no links here'), null);
  assert.equal(parseChatCommand(config, 'https://github.com/ROKT/launch-engineering/tree/main')?.allowed.length ?? 0, 0, 'a folder link is not a PR');
});

test('intake records once, acknowledges immediately, refuses other repositories, ignores bots and foreign spaces', () => {
  const store = new Store(':memory:');
  const ctx = { config, store, log };
  assert.equal(handleChatMessage(ctx, msg()), 'recorded');
  assert.equal(handleChatMessage(ctx, msg()), 'duplicate', 'Pub/Sub redelivery or a poll overlap records nothing twice');
  assert.equal(handleChatMessage(ctx, msg({ name: `${SPACE}/messages/bot`, sender: { name: 'users/app', type: 'BOT' } })), 'ignored');
  assert.equal(handleChatMessage(ctx, msg({ name: `${SPACE}/messages/elsewhere`, space: 'spaces/other' })), 'ignored');
  assert.equal(handleChatMessage(ctx, msg({ name: `${SPACE}/messages/op3`, text: 'https://github.com/ROKT/op3/pull/1' })), 'refused');
  const replies = store.pendingChatReplies(Date.now() / 1000 + 1, 10);
  assert.equal(replies.length, 2);
  assert.match(replies[0]!.text, /🦅 Looking at ROKT\/launch-engineering#585/);
  assert.match(replies[1]!.text, /Only ROKT\/launch-engineering is reviewed here. Not queued: ROKT\/op3/);
  assert.equal(store.pendingChatRequests().length, 1);
});

test('pending requests become prioritized jobs once GitHub answers; merged PRs and exhausted rounds are refused in-thread; a draft is taken', async () => {
  const store = new Store(':memory:');
  const ctx = { config, store, log };
  handleChatMessage(ctx, msg());
  let fail = 1;
  const pull = async () => { if (fail-- > 0) { const e = new Error('503') as Error & { status: number }; e.status = 503; throw e; } return meta(); };
  assert.equal(await resolvePendingChatRequests(ctx, pull, 1000), 0, 'GitHub failure defers the request');
  const [req] = store.pendingChatRequests(10_000);
  assert.equal(req?.attempts, 1);
  assert.equal(await resolvePendingChatRequests(ctx, pull, 10_000), 1);
  const job = store.claim('w', 60, { perRepo: 1, global: 1 })!;
  assert.equal(job.priority, 10, 'chat requests go ahead of polled ones');
  assert.equal(job.trigger, 'comment');
  assert.equal(store.chatRequestsForJob(job.id).length, 1);

  // A second thread asks for the same head while it is in review: it attaches to the same job.
  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/m2`, thread: `${SPACE}/threads/t2` }));
  await resolvePendingChatRequests(ctx, async () => meta(), 20_000);
  assert.equal(store.chatRequestsForJob(job.id).length, 2);

  // The outcome reaches every requesting thread once.
  store.finish(job.id, 'published', { result: { reviewUrl: 'https://github.com/ROKT/launch-engineering/pull/585#pullrequestreview-1' } });
  deliverOutcome(store, store.job(job.id)!, { status: 'published', event: 'APPROVE', summary: 'Looks good.', confidence: 'high', reviewUrl: 'https://github.com/ROKT/launch-engineering/pull/585#pullrequestreview-1' });
  const replies = store.pendingChatReplies(Date.now() / 1000 + 1, 20).filter((r) => /Review complete/.test(r.text));
  assert.equal(replies.length, 2);
  assert.match(replies[0]!.text, /✅ Review complete — Approved \(confidence: high\)/);
  assert.deepEqual(new Set(replies.map((r) => r.thread)), new Set([`${SPACE}/threads/t1`, `${SPACE}/threads/t2`]));

  // Same head again after publication: the existing review is linked, no new job.
  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/m3`, thread: `${SPACE}/threads/t3` }));
  await resolvePendingChatRequests(ctx, async () => meta(), 30_000);
  assert.equal(store.counts()['queued'] ?? 0, 0);
  assert.ok(store.pendingChatReplies(Date.now() / 1000 + 1, 20).some((r) => /already reviewed at aaaaaaaa/.test(r.text)));

  // A draft that someone asks for is queued like any other PR.
  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/m4`, text: 'https://github.com/ROKT/launch-engineering/pull/586' }));
  await resolvePendingChatRequests(ctx, async () => meta({ number: 586, draft: true, headSha: 'd'.repeat(40) }), 40_000);
  assert.equal(store.counts()['queued'] ?? 0, 1);
  assert.ok(!store.pendingChatReplies(Date.now() / 1000 + 1, 30).some((r) => /#586: .*draft/.test(r.text)));
});

test('the outbox sends once per reply, retries transient failures and parks permanent ones', async () => {
  const store = new Store(':memory:');
  store.queueChatReply('k1', SPACE, `${SPACE}/threads/a`, 'one');
  store.queueChatReply('k1', SPACE, `${SPACE}/threads/a`, 'one again');
  store.queueChatReply('k2', SPACE, `${SPACE}/threads/b`, 'two');
  store.queueChatReply('k3', SPACE, `${SPACE}/threads/c`, 'three');
  const sent: string[] = [];
  const chat: ChatApi = {
    async reply(_s, thread, text, requestId) {
      if (text === 'two') { const e = new Error('x') as Error & { status: number }; e.status = 404; throw e; }
      if (text === 'three' && !sent.includes('three')) { sent.push('three'); const e = new Error('x') as Error & { status: number }; e.status = 500; throw e; }
      sent.push(`${thread}:${text}:${requestId.length}`);
      return { name: 'm' };
    },
    async listMessages() { return { messages: [] }; },
  };
  const first = await flushChatOutbox(store, chat, log, 1000);
  assert.equal(first, 1, 'one sent, one parked, one retrying (and the loop paused on the 500)');
  assert.equal(sent.filter((s) => s.endsWith(':36')).length, 1, 'requestId is the stable uuid, so a redelivery is idempotent on the Chat side');
  assert.equal(store.pendingChatReplies(1000, 10).length, 0, 'the retry is scheduled in the future');
  assert.equal(store.pendingChatReplies(10_000, 10).length, 1);
  assert.equal(await flushChatOutbox(store, chat, log, 10_000), 1);
  assert.equal(store.pendingChatReplies(100_000, 10).length, 0);
});

test('a reply to a deleted request is never posted top-level: Chat is told to fail, and the outbox parks it', async () => {
  const store = new Store(':memory:');
  store.queueChatReply('k1', SPACE, `${SPACE}/threads/gone`, 'review');
  const calls: URL[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL) => { calls.push(url); return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 }); }) as typeof fetch;
  try {
    assert.equal(await flushChatOutbox(store, new GoogleChatApi({ token: async () => 't' }), log, 1000), 0);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.searchParams.get('messageReplyOption'), 'REPLY_MESSAGE_OR_FAIL');
  assert.equal(store.pendingChatReplies(1e9, 10).length, 0, 'parked for good, never retried');
});

test('outcome text follows the OP3 shape and holds carry the reason', () => {
  const job = { repo: 'ROKT/launch-engineering', number: 585, headSha: 'abcdef1234567890'.padEnd(40, '0') };
  assert.match(chatOutcomeText(job, { status: 'published', event: 'REQUEST_CHANGES', summary: 'Two defects.', confidence: 'high', reviewUrl: 'u' })!, /🛑 Review complete — Changes requested \(confidence: high\)\n\nTwo defects\.\n\nFull review: u\nCommit: abcdef12/);
  assert.match(chatOutcomeText(job, { status: 'published', event: 'COMMENT', confidence: 'medium' })!, /💬 Review complete — comments only/);
  assert.match(chatOutcomeText(job, { status: 'held', reason: 'CI failed at this head.' })!, /⚠️ ROKT\/launch-engineering#585 — Review held\n\nCI failed/);
  assert.equal(chatOutcomeText(job, { status: 'deferred' }), null, 'deferrals are not announced; the acknowledgement already said we are looking');
});

test('re-review runs a published commit again, drops the stored result, and counts as a round', async () => {
  const store = new Store(':memory:');
  const ctx = { config, store, log }; // maxRoundsPerPr is 2 here.
  const link = 'https://github.com/ROKT/launch-engineering/pull/585';
  handleChatMessage(ctx, msg());
  await resolvePendingChatRequests(ctx, async () => meta(), 1000);
  const job = store.claim('w', 60, { perRepo: 1, global: 1 })!;
  store.finish(job.id, 'published', { result: { reviewUrl: 'https://example/review-1' } });
  deliverOutcome(store, store.job(job.id)!, { status: 'published', event: 'COMMENT', summary: 's', confidence: 'high', reviewUrl: 'https://example/review-1' });

  // A plain link is answered with the existing review and how to ask for a fresh one.
  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/p1`, text: link }));
  await resolvePendingChatRequests(ctx, async () => meta(), 1500);
  assert.equal(store.job(job.id)!.status, 'published');
  assert.ok(store.pendingChatReplies(Date.now() / 1000 + 1, 30).some((r) => /already reviewed at aaaaaaaa.*Post "re-review" with the link/.test(r.text)));

  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/r1`, text: `re-review ${link}` }));
  await resolvePendingChatRequests(ctx, async () => meta(), 2000);
  const again = store.job(job.id)!;
  assert.equal(again.status, 'queued');
  assert.equal(again.resultJson, null, 'the stored result is dropped, so nothing is replayed');
  assert.ok(store.chatRequestsForJob(job.id).some((r) => r.command === 're-review' && r.status === 'queued'));
  assert.equal(store.chatRoundsForPr('ROKT/launch-engineering', 585), 2);

  // The rounds are used up: a second fresh review is refused and the job stays as it is.
  store.finish(job.id, 'published', { result: { reviewUrl: 'https://example/review-2' } });
  handleChatMessage(ctx, msg({ name: `${SPACE}/messages/r2`, text: `re-review ${link}` }));
  await resolvePendingChatRequests(ctx, async () => meta(), 3000);
  assert.equal(store.job(job.id)!.status, 'published');
  assert.ok(store.pendingChatReplies(Date.now() / 1000 + 1, 30).some((r) => /used its 2 manual review rounds/.test(r.text)));
});

test('keyless sign-in: the note is signed by the local key, names the trust provider, and expires in minutes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = join(mkdtempSync(join(tmpdir(), 'falcon-keyless-')), 'signing.pem');
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const cfg = { audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/falcon/providers/host', service_account: 'falcon-chat@example.iam.gserviceaccount.com', issuer: 'https://falcon.example', subject: 'falcon-host', key_id: 'k1', signing_key_file: keyFile };

  const [h, p, sig] = signedNote(cfg, 1_000_000).split('.') as [string, string, string];
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'k1' });
  assert.deepEqual(claims, { iss: 'https://falcon.example', sub: 'falcon-host', aud: `https:${cfg.audience}`, iat: 1000, exp: 1300 });
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), 'the public key verifies the note');

  assert.ok(serviceAccountTokens(JSON.stringify(cfg), ['s']).token, 'a keyless config is accepted');
  assert.ok(serviceAccountTokens(JSON.stringify({ client_email: 'a@b', private_key: 'x' }), ['s']).token, 'a JSON key is still accepted');
  assert.throws(() => serviceAccountTokens(JSON.stringify({ audience: cfg.audience }), ['s']), /keyless config needs/, 'a partial keyless config is refused by name');
  assert.throws(() => serviceAccountTokens('{}', ['s']), /client_email and private_key/, 'an empty config is refused');
});

test('keyless key: created once, owner-only, and only the public half is returned', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'falcon-keyless-')), 'signing.pem');
  const jwks = keylessPublicJwks(file);
  const key = jwks.keys[0]!;
  assert.deepEqual(Object.keys(key).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use'], 'no private field such as d');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const pem = readFileSync(file, 'utf8');
  assert.deepEqual(keylessPublicJwks(file), jwks, 'a second call returns the same key');
  assert.equal(readFileSync(file, 'utf8'), pem, 'and does not rewrite the file');

  const [h, p, sig] = signedNote({ audience: '//a', service_account: 's', issuer: 'https://i', subject: 'x', key_id: key.kid, signing_key_file: file }).split('.') as [string, string, string];
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), { key, format: 'jwk' }, Buffer.from(sig, 'base64url')), 'the printed public key verifies a note from the file');
});
