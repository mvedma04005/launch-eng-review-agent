import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { sleep } from './serve.ts';

test('sleep leaves no listener on the signal, and an abort ends it early', async () => {
  const controller = new AbortController();
  // The loops share one signal for the life of the process. A listener left per sleep made each later sleep
  // slower (Node walks the list on every add) until the process spent a whole core on it.
  for (let i = 0; i < 200; i++) await sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);
  await sleep(60_000, controller.signal);
  assert.ok(Date.now() - started < 5_000, 'abort resolves the sleep, it does not reject or wait');
  await sleep(60_000, controller.signal);
});
