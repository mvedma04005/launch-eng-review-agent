import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateVerdict, ownersOf } from './gate.ts';

const CODEOWNERS = `
# Comments and blank lines are skipped.
* @ROKT/launch-engineering
/rokt-pixel-helper/ @ROKT/rokt-global-infrastructure
/prism-qa/ @ROKT/launch-engineering @ROKT/gtm-operations-customer-operations
/prism-qa/.buildkite/ @ROKT/launch-engineering
/supplementals/ops-records-api/ @ROKT/launch-engineering @ROKT/gtm-operations-customer-operations
/supplementals/ops-records-api/**/*issuebot* @oz-rokt @liamstoryrokt
/supplementals/ops-records-api/infra/ @ROKT/launch-engineering
/supplementals/ops-records-api/**/AGENT*.md @oz-rokt @liamstoryrokt
/merlin-chrome-extension-suite/ @pep-rokt @chenrog
`;
const LE = '@rokt/launch-engineering';
const OPS = '@rokt/gtm-operations-customer-operations';
const FALCON = 'falcon-review[bot]';

const verdict = (files: string[], approvers: string[], team = ['Lee', 'mvedma04005']) =>
  gateVerdict({ files, codeowners: CODEOWNERS, teamOwner: '@ROKT/launch-engineering', team, approvers, falcon: FALCON }).verdict;

test('ownersOf takes the last matching CODEOWNERS line', () => {
  const cases: Record<string, string[]> = {
    'Orbit/api/main.py': [LE],
    'prism-qa/src/app.ts': [LE, OPS],
    'prism-qa/.buildkite/pipeline.yml': [LE],
    'supplementals/ops-records-api/app/main.py': [LE, OPS],
    'supplementals/ops-records-api/infra/rds.tf': [LE],
    'supplementals/ops-records-api/app/bots/issuebot_handler.py': ['@oz-rokt', '@liamstoryrokt'],
    'supplementals/ops-records-api/docs/AGENTS.md': ['@oz-rokt', '@liamstoryrokt'],
    'rokt-pixel-helper/manifest.json': ['@rokt/rokt-global-infrastructure'],
    'merlin-chrome-extension-suite/a/b.js': ['@pep-rokt', '@chenrog'],
  };
  for (const [path, owners] of Object.entries(cases)) assert.deepEqual(ownersOf(path, CODEOWNERS), owners, path);
});

test('ownersOf follows the CODEOWNERS pattern shapes', () => {
  const cases: Array<[string, string, boolean]> = [
    ['*.js', 'a/b/c.js', true],
    ['apps/', 'x/apps/y.py', true],
    ['apps/', 'apps', false],
    ['docs/*', 'docs/a.md', true],
    ['docs/*', 'docs/a/b.md', false],
    ['/docs', 'docs/a/b.md', true],
    ['/docs', 'x/docs/a.md', false],
    ['**/logs', 'a/logs/x.txt', true],
    ['/a.b', 'aXb', false],
  ];
  for (const [pattern, path, matches] of cases) assert.equal(ownersOf(path, `${pattern} @x`).length === 1, matches, `${pattern} ${path}`);
});

test('Falcon counts wherever the team is an owner, and nowhere else', () => {
  assert.equal(verdict(['Orbit/a.py', 'supplementals/ops-records-api/infra/rds.tf'], [FALCON]), 'pass');
  assert.equal(verdict(['prism-qa/src/app.ts'], [FALCON]), 'pass');
  assert.equal(verdict(['merlin-chrome-extension-suite/a.js'], [FALCON]), 'wait');
  assert.equal(verdict(['supplementals/ops-records-api/x/issuebot.py'], [FALCON]), 'wait');
  assert.equal(verdict(['rokt-pixel-helper/manifest.json'], [FALCON]), 'wait');
});

test('Falcon never covers the files that decide who may merge', () => {
  for (const path of ['.falcon/policy.yaml', '.github/CODEOWNERS']) {
    assert.equal(verdict([path], [FALCON]), 'wait', path);
    assert.equal(verdict([path], [FALCON, 'lee']), 'pass', path);
  }
});

test('a person counts only as an owner', () => {
  assert.equal(verdict(['Orbit/a.py'], ['LEE']), 'pass');
  assert.equal(verdict(['Orbit/a.py'], ['alex']), 'wait');
  assert.equal(verdict(['Orbit/a.py'], ['lee'], []), 'wait'); // No team list in the pack yet.
  assert.equal(verdict(['merlin-chrome-extension-suite/a.js'], ['pep-rokt']), 'pass');
  assert.equal(verdict(['supplementals/ops-records-api/x/issuebot.py'], ['lee']), 'wait');
});

test('another owner team is unknown, never a guess', () => {
  assert.equal(verdict(['prism-qa/src/app.ts'], ['alex']), 'unknown');
  assert.equal(verdict(['rokt-pixel-helper/manifest.json'], ['lee']), 'wait');
});

test('every file needs cover, and an unknown Falcon login counts for nothing', () => {
  const files = ['Orbit/a.py', 'merlin-chrome-extension-suite/a.js'];
  assert.deepEqual(gateVerdict({ files, codeowners: CODEOWNERS, teamOwner: LE, team: [], approvers: [FALCON], falcon: FALCON }), { verdict: 'wait', uncovered: ['merlin-chrome-extension-suite/a.js'] });
  assert.equal(verdict(files, [FALCON, 'pep-rokt']), 'pass');
  assert.equal(verdict([], [FALCON]), 'wait');
  assert.equal(gateVerdict({ files: ['Orbit/a.py'], codeowners: CODEOWNERS, teamOwner: LE, team: [], approvers: [FALCON], falcon: null }).verdict, 'wait');
});
