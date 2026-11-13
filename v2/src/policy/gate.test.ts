import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateVerdict } from './gate.ts';

const FALCON = 'falcon-review[bot]';
const verdict = (files: string[], approvers: string[], team = ['Lee', 'mvedma04005']) =>
  gateVerdict({ files, team, approvers, falcon: FALCON }).verdict;

test('a team member or Falcon covers every path, and nobody else does', () => {
  for (const path of ['Orbit/a.py', 'prism-qa/src/app.ts', 'rokt-pixel-helper/manifest.json', 'supplementals/ops-records-api/x/issuebot.py', 'merlin-chrome-extension-suite/a.js']) {
    assert.equal(verdict([path], [FALCON]), 'pass', path);
    assert.equal(verdict([path], ['LEE']), 'pass', path);
    assert.equal(verdict([path], ['alex']), 'wait', path); // Not on the team: another owner's approval alone is not enough.
    assert.equal(verdict([path], ['oz-rokt', 'pep-rokt']), 'wait', path); // CODEOWNERS plays no part.
  }
  assert.equal(verdict(['Orbit/a.py'], ['lee'], []), 'wait'); // No team list in the pack yet.
});

test('Falcon never covers the files that decide who may merge', () => {
  for (const path of ['.falcon/policy.yaml', '.github/CODEOWNERS']) {
    assert.equal(verdict([path], [FALCON]), 'wait', path);
    assert.equal(verdict([path], [FALCON, 'lee']), 'pass', path);
  }
});

test('Falcon never covers a path the pack keeps for a person', () => {
  const run = (files: string[], approvers: string[]) => gateVerdict({ files, team: ['lee'], humanPaths: ['**/infra/**', '**/*.tf'], approvers, falcon: FALCON });
  assert.deepEqual(run(['Orbit/a.py', 'Orbit/infra/kube/values.yaml', 'x/main.tf'], [FALCON]), { verdict: 'wait', uncovered: ['Orbit/infra/kube/values.yaml', 'x/main.tf'] });
  assert.equal(run(['Orbit/infra/kube/values.yaml'], [FALCON, 'lee']).verdict, 'pass');
  assert.equal(run(['Orbit/a.py'], [FALCON]).verdict, 'pass');
});

test('no files is a wait, and an unknown Falcon login or a bot in the team list counts for nothing', () => {
  assert.equal(verdict([], [FALCON]), 'wait');
  assert.equal(gateVerdict({ files: ['Orbit/a.py'], team: [], approvers: [FALCON], falcon: null }).verdict, 'wait');
  assert.equal(gateVerdict({ files: ['.falcon/policy.yaml'], team: ['lee', FALCON], approvers: [FALCON], falcon: null }).verdict, 'wait');
  assert.equal(gateVerdict({ files: ['Orbit/a.py'], team: ['lee', FALCON], approvers: [FALCON], falcon: null }).verdict, 'wait');
});

test('a line break in a file name does not open a gate file to Falcon', () => {
  for (const ch of ['\n', '\r', ' ', ' ']) assert.equal(verdict([`.falcon/a${ch}b`], [FALCON]), 'wait', JSON.stringify(ch));
});
