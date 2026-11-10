import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minimatch } from './glob.ts';
import { applyPolicy, inScope, loadPolicyFile, mergePolicies, parsePolicy, rulesFor } from './load.ts';
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
