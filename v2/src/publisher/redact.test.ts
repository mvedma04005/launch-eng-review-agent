import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundBytes, buildRedactor } from './redact.ts';

test('redactor removes held secret values and common credential shapes', () => {
  const r = buildRedactor(['my-exact-anthropic-key-value', undefined, 'short']);
  const text = [
    'key my-exact-anthropic-key-value here',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789 end',
    'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'ant sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'aws AKIAIOSFODNN7EXAMPLE',
    'slack xoxb-123456789012-abcdefghijkl',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'cfg password = hunter2hunter2hunter2',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    'short stays',
  ].join('\n');
  const out = r.apply(text);
  assert.doesNotMatch(out, /my-exact-anthropic-key-value|ghp_abc|github_pat_|sk-ant-|AKIAIOSFODNN7|xoxb-|eyJhbGci|hunter2|MIIE/);
  assert.match(out, /\[redacted\] here/);
  assert.match(out, /\[redacted github token\]/);
  assert.match(out, /\[redacted aws key id\]/);
  assert.match(out, /\[redacted private key\]/);
  assert.match(out, /password = \[redacted\]/);
  assert.match(out, /short stays/, 'values under 8 characters are not treated as secrets');
});

test('boundBytes truncates on a UTF-8 boundary and marks the cut', () => {
  const text = 'héllo wörld ' .repeat(100);
  const out = boundBytes(text, 64);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 64 + 1);
  assert.ok(out.endsWith('… [truncated]'));
  assert.doesNotMatch(out, /�/, 'no replacement characters from a split sequence');
  assert.equal(boundBytes('short', 64), 'short');
  const emoji = '🙂'.repeat(50);
  const cut = boundBytes(emoji, 30);
  assert.doesNotMatch(cut, /�/);
});
