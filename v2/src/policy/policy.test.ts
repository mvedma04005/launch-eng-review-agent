import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimatch } from './glob.ts';
import { applyPolicy, inScope, isTeamMember, loadPolicyFile, mergePolicies, overrideBy, parsePolicy, rulesFor } from './load.ts';
import type { Finding } from '../types.ts';

const finding = (over: Partial<Finding>): Finding => ({ id: 'a', severity: 'high', blocking: false, path: 'src/a.ts', line: 1, side: 'RIGHT', title: 't', scenario: 's', impact: 'i', evidence: 'e', fix: 'f', fingerprint: 'fp', ...over });

test('glob matcher covers the forms policies use', () => {
  assert.ok(minimatch('src/a.ts', '**'));
  assert.ok(minimatch('src/deep/x/a.ts', 'src/**/*.ts'));
  assert.ok(minimatch('a.ts', '**/*.ts'));
  assert.ok(minimatch('pnpm-lock.yaml', '**/pnpm-lock.yaml'));
  assert.ok(minimatch('src/UI/MP.UI.Web.Admin/x.js', 'src/UI/MP.UI.Web.Admin/**'));
  assert.ok(minimatch('a.snap', '**/*.{snap,lock}'));
  assert.ok(!minimatch('src/a.ts', '*.ts'));
  assert.ok(!minimatch('src/a.py', '**/*.ts'));
});

test('default pack parses and excludes generated files', () => {
  const policy = loadPolicyFile(new URL('../../policies/default.yaml', import.meta.url).pathname);
  assert.equal(policy.verdict.mode, 'comment');
  assert.ok(!inScope(policy, 'web/package-lock.json'));
  assert.ok(inScope(policy, 'src/handler.py'));
  assert.ok(rulesFor(policy, 'anything.go').some((r) => r.id === 'secrets-in-code'));
});

test('repository overlay replaces rules by id, concatenates lists, and cannot exceed the verdict ceiling', () => {
  const base = parsePolicy(`
version: 1
name: base
verdict: { mode: comment, maxMode: request_changes }
rules:
  - { id: r1, title: One, severity: high, guidance: base guidance }
  - { id: r2, title: Two, severity: low, guidance: keep }
suppressions: []
`, 'base');
  const overlay = parsePolicy(`
version: 1
name: repo
verdict: { mode: approve }
scope: { exclude: ["docs/**"] }
rules:
  - { id: r1, title: One (repo), severity: medium, paths: ["svc/**"], guidance: repo guidance }
suppressions:
  - { rule: r2, paths: ["legacy/**"], reason: legacy code is frozen }
standards:
  - { title: Local, text: Use the shared client. }
`, 'repo');
  const merged = mergePolicies(base, overlay);
  assert.equal(merged.verdict.mode, 'request_changes', 'approve is above the ceiling, so the overlay gets the ceiling');
  assert.equal(merged.verdict.maxMode, 'request_changes', 'an overlay cannot raise the ceiling');
  assert.equal(merged.rules.length, 2);
  assert.equal(merged.rules.find((r) => r.id === 'r1')?.severity, 'medium');
  assert.deepEqual(merged.scope.exclude, ['docs/**']);
  assert.equal(merged.standards.length, 1);
  assert.equal(mergePolicies(parsePolicy('version: 1\nname: b\nverdict: { mode: comment, maxMode: approve }', 'b'), overlay).verdict.mode, 'approve', 'within the ceiling the overlay wins');
  assert.equal(mergePolicies(parsePolicy('version: 1\nname: b\nverdict: { mode: comment, maxMode: comment }', 'b'), overlay).verdict.mode, 'comment', 'a comment-only ceiling pins every repository to comments');
});

test('applyPolicy enforces suppressions, scope and severity-derived blocking', () => {
  const policy = parsePolicy(`
version: 1
name: p
scope: { exclude: ["gen/**"] }
verdict: { blockOn: [critical] }
suppressions:
  - { rule: noisy, paths: ["**"], reason: too noisy }
`, 'p');
  const { kept, dropped } = applyPolicy(policy, [
    finding({ id: '1', severity: 'critical' }),
    finding({ id: '2', severity: 'high' }),
    finding({ id: '3', path: 'gen/x.ts' }),
    finding({ id: '4', ruleId: 'noisy' }),
  ]);
  assert.deepEqual(kept.map((f) => [f.id, f.blocking]), [['1', true], ['2', false]]);
  assert.deepEqual(dropped.map((d) => d.finding.id), ['3', '4']);
});

test('invalid policies fail loudly with a path to the problem', () => {
  assert.throws(() => parsePolicy('version: 1\nname: x\nrules:\n  - { id: Bad Id, title: t, severity: high, guidance: g }', 'x'), /rules\.0\.id/);
  assert.throws(() => parsePolicy('version: 1\nname: x\nrules:\n  - { id: dup, title: t, severity: high, guidance: g }\n  - { id: dup, title: t, severity: high, guidance: g }', 'x'), /twice/);
});

test('team membership is case-insensitive; outsiders need no plan by default', () => {
  const p = parsePolicy('version: 1\nname: t\nteam: { members: [Ann, bob] }\noutsiders: { requirePlan: true }', 't');
  assert.equal(isTeamMember(p, 'ann'), true);
  assert.equal(isTeamMember(p, 'BOB'), true);
  assert.equal(isTeamMember(p, 'eve'), false);
  assert.deepEqual(p.outsiders.planHeadings, ['Problem', 'Plan']);
  const d = parsePolicy('version: 1\nname: d', 'd');
  assert.equal(d.outsiders.requirePlan, false);
  assert.deepEqual(d.team.members, []);
});

test('only a team member who is not the author can override', () => {
  const p = parsePolicy('version: 1\nname: t\nteam: { members: [lee, ann] }', 't');
  assert.equal(overrideBy(p, 'eve', ['Lee']), 'Lee');
  assert.equal(overrideBy(p, 'lee', ['lee']), null, 'own approval');
  assert.equal(overrideBy(p, 'eve', ['mallory']), null, 'not on the team');
  assert.equal(overrideBy(p, 'eve', []), null);
});

test('the engine pack lets a repository opt into approvals', () => {
  const base = loadPolicyFile(new URL('../../policies/default.yaml', import.meta.url).pathname);
  const merged = mergePolicies(base, parsePolicy('version: 1\nname: le\nverdict: { mode: approve }', 'le'));
  assert.equal(merged.verdict.mode, 'approve');
  assert.equal(base.verdict.mode, 'comment', 'repositories without a pack still only comment');
});

test('team logins are trimmed and may carry one leading @', () => {
  const p = parsePolicy('version: 1\nname: t\nteam: { members: ["@lee", " ann ", Bob] }', 't');
  assert.ok(isTeamMember(p, 'lee'));
  assert.ok(isTeamMember(p, 'ann'));
  assert.ok(isTeamMember(p, 'bob'));
  assert.throws(() => parsePolicy('version: 1\nname: t\nteam: { members: ["@"] }', 't'), /team\.members/);
});

test('commentOnly paths from the central pack and the repository pack both apply', () => {
  const base = parsePolicy('version: 1\nname: base\nverdict: { maxMode: approve, commentOnly: ["**/infra/**"] }\n', 'base');
  const merged = mergePolicies(base, parsePolicy('version: 1\nname: repo\nverdict: { mode: approve, commentOnly: ["**/*.tf"] }\n', 'repo'));
  assert.deepEqual(merged.verdict.commentOnly, ['**/infra/**', '**/*.tf']);
  assert.deepEqual(mergePolicies(base, parsePolicy('version: 1\nname: repo\nverdict: { mode: approve }\n', 'repo')).verdict.commentOnly, ['**/infra/**']);
});
