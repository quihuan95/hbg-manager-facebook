import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { resolveFacebookPage } from '../src/meta.js';

test('resolveFacebookPage never falls back to a different single Page when a target is explicit', async t => {
  const originalToken = config.meta.pageAccessToken;
  const originalFetch = globalThis.fetch;
  config.meta.pageAccessToken = 'test-token';
  globalThis.fetch = async url => {
    if (String(url).includes('/me/accounts')) {
      return new Response(JSON.stringify({
        data: [{ id: '111', name: 'Wrong Page', access_token: 'wrong-page-token' }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  t.after(() => {
    config.meta.pageAccessToken = originalToken;
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    () => resolveFacebookPage('222'),
    /không quản lý Facebook Page đã cấu hình \(222\)/
  );
});

test('resolveFacebookPage selects the exact requested Page from a multi-Page token', async t => {
  const originalToken = config.meta.pageAccessToken;
  const originalFetch = globalThis.fetch;
  config.meta.pageAccessToken = 'test-token';
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: '111', name: 'First Page', access_token: 'first-token' },
      { id: '1350620321464801', name: 'The HBG Admin', access_token: 'target-token' }
    ]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  t.after(() => {
    config.meta.pageAccessToken = originalToken;
    globalThis.fetch = originalFetch;
  });

  const page = await resolveFacebookPage('1350620321464801');
  assert.deepEqual(page, {
    pageId: '1350620321464801',
    pageName: 'The HBG Admin',
    accessToken: 'target-token'
  });
});
