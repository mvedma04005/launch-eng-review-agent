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
  gateVerdict({ files, codeowners: CODEOWNERS, team, approvers, falcon: FALCON }).verdict;

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

test('a team member or Falcon covers every path, whoever CODEOWNERS gives it to', () => {
  for (const path of ['Orbit/a.py', 'supplementals/ops-records-api/infra/rds.tf', 'prism-qa/src/app.ts', 'rokt-pixel-helper/manifest.json']) {
    assert.equal(verdict([path], [FALCON]), 'pass', path);
    assert.equal(verdict([path], ['LEE']), 'pass', path);
    assert.equal(verdict([path], ['alex']), 'wait', path); // Another owner team's approval alone is not enough.
  }
  assert.equal(verdict(['Orbit/a.py'], ['lee'], []), 'wait'); // No team list in the pack yet.
});

test('Falcon never covers the files that decide who may merge', () => {
  for (const path of ['.falcon/policy.yaml', '.github/CODEOWNERS']) {
    assert.equal(verdict([path], [FALCON]), 'wait', path);
    assert.equal(verdict([path], [FALCON, 'lee']), 'pass', path);
  }
});

test('where CODEOWNERS names people, one of them must approve as well', () => {
  const issuebot = 'supplementals/ops-records-api/x/issuebot.py';
  assert.equal(verdict([issuebot], [FALCON]), 'wait');
  assert.equal(verdict([issuebot], ['lee']), 'wait');
  assert.equal(verdict([issuebot], ['oz-rokt']), 'wait'); // The owner alone: still needs the team or Falcon.
  assert.equal(verdict([issuebot], ['oz-rokt', FALCON]), 'pass');
  assert.equal(verdict([issuebot], ['liamstoryrokt', 'lee']), 'pass');
  assert.equal(verdict(['merlin-chrome-extension-suite/a.js'], ['pep-rokt', FALCON]), 'pass');
});

test('every file needs cover, and an unknown Falcon login counts for nothing', () => {
  const files = ['Orbit/a.py', 'merlin-chrome-extension-suite/a.js'];
  assert.deepEqual(gateVerdict({ files, codeowners: CODEOWNERS, team: ['lee'], approvers: [FALCON], falcon: FALCON }), { verdict: 'wait', uncovered: ['merlin-chrome-extension-suite/a.js'] });
  assert.equal(verdict(files, [FALCON, 'pep-rokt']), 'pass');
  assert.equal(verdict([], [FALCON]), 'wait');
  assert.equal(gateVerdict({ files: ['Orbit/a.py'], codeowners: CODEOWNERS, team: [], approvers: [FALCON], falcon: null }).verdict, 'wait');
  // A bot is never a person, also when its login is unknown and someone lists it in the team.
  assert.equal(gateVerdict({ files: ['.falcon/policy.yaml'], codeowners: CODEOWNERS, team: ['lee', FALCON], approvers: [FALCON], falcon: null }).verdict, 'wait');
});

test('a line break in a file name does not skip the more specific CODEOWNERS line', () => {
  for (const ch of ['\n', '\r', '\u2028', '\u2029']) {
    assert.deepEqual(ownersOf(`merlin-chrome-extension-suite/x${ch}.js`, CODEOWNERS), ['@pep-rokt', '@chenrog'], JSON.stringify(ch));
    assert.equal(verdict([`merlin-chrome-extension-suite/x${ch}.js`], [FALCON]), 'wait');
    assert.equal(verdict([`.falcon/a${ch}b`], [FALCON]), 'wait');
  }
});
