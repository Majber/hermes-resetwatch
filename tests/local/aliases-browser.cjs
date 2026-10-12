// Focused synthetic browser fixture; no gateway, auth, or user data access.
// NODE_PATH=<scratch npm prefix>/node_modules node tests/local/aliases-browser.cjs
// Dependencies: playwright@1.61.1 react@18.3.1 react-dom@18.3.1.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.resolve(__dirname, '../../resetwatch-local/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {');
const reactScript = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const domScript = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const preferences = { disabled: ['nous', 'openrouter'], order: ['openai-codex'] };
const fixtureHtml = '<!doctype html><html lang="en"><meta charset="utf-8"><style>:root{--ui-text-primary:#eee;--ui-text-secondary:#ccc;--ui-text-tertiary:#aaa;--ui-stroke-secondary:#444;--ui-accent:#9af;--ui-green:#8e9;--ui-bg-primary:#222}body{margin:0;font:14px Arial;background:var(--ui-bg-primary);color:var(--ui-text-primary)}#root{height:700px}</style><div id="root"></div></html>';
async function mount(page, locale = 'en') {
  await page.addScriptTag({ content: reactScript });
  await page.addScriptTag({ content: domScript });
  await page.evaluate(({ source, preferences, locale }) => {
    window.locale = locale;
    window.storageWrites = [];
    window.storageFailure = '';
    const atom = initial => {
      let value = initial;
      const listeners = new Set();
      return { get: () => value, set: next => { value = next; listeners.forEach(fn => fn()); }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
    };
    const now = Date.now();
    const resetDetails = ['You have 0 resets banked', 'You have 1 reset banked', 'You have 2 resets banked', 'You have 5 resets banked', '', 'You have 5 resets banked', 'You have -2 resets banked'];
    window.fixtures = Array.from({ length: 7 }, (_, i) => ({
      provider: 'openai-codex', plan: i === 2 || i === 3 ? '' : 'Plus', account_key: `scope-${i}-synthetic`,
      account_label: i < 2 ? 'same@example.invalid' : i < 4 ? '' : `fixture${i}@example.invalid`,
      source_host: i === 1 ? 'https://second-host.invalid' : 'https://first-host.invalid',
      ...(i < 4 || i === 5 ? { rate_limit_reset_credits: { available_count: [0, 1, 2, 5, null, 5][i], applicable_available_count: [0, 0, 2, 3, null, null][i] } } : {}),
      cache_hit: i === 5,
      account_status: 'verified', quota_state: 'available', allowed: true,
      fetched_at: (now - (i === 5 ? 900000 : 60000)) / 1000,
      details: ['Synthetic diagnostic', ...(resetDetails[i] ? [resetDetails[i]] : [])],
      windows: [{ label: 'Session', remaining_percent: 80, used_percent: 20, reset_at: new Date(now + 3600000).toISOString() },
        { label: 'Weekly', remaining_percent: 60, used_percent: 40, reset_at: new Date(now + 86400000).toISOString() },
        { label: 'Extra model', remaining_percent: 90, used_percent: 10 }]
    }));
    const prefix = 'hermes.plugin.resetwatch-local.';
    if (!localStorage.getItem(prefix + 'providers')) {
      localStorage.setItem(prefix + 'providers', JSON.stringify(preferences));
      localStorage.setItem(prefix + 'display_mode', JSON.stringify('remaining'));
    }
    window.fixtureStorage = {
      get: (key, fallback) => { const raw = localStorage.getItem(prefix + key); return raw === null ? fallback : JSON.parse(raw); },
      set: (key, value) => {
        window.storageWrites.push(key);
        if (window.storageFailure === 'throw') throw new Error('Synthetic storage failure');
        if (window.storageFailure === 'silent') return;
        localStorage.setItem(prefix + key, JSON.stringify(value));
      }
    };
    let bundles;
    const sdk = {
      atom, useValue: a => React.useSyncExternalStore(a.subscribe, a.get),
      host: { state: { gateway: atom('open'), focusedSessionId: atom(''), profile: atom('default') }, request: () => { throw new Error('Unexpected gateway access'); } },
      ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', PALETTE_AREA: 'palette',
      usePluginI18n: () => ({ t: key => bundles[window.locale][key] || bundles.en[key] || key }),
      useQuery: () => ({ data: window.liveData, isFetching: false })
    };
    const { Fragment, useEffect, useMemo, useRef, useState } = React;
    const jsx = (type, props, key) => React.createElement(type, { ...props, ...(key === undefined ? {} : { key }) });
    const jsxs = jsx;
    // Execute the real uncompiled plugin with only its approved imports supplied.
    eval(source + '\nwindow.makeCards = cardsFromAccountSnapshots; window.liveData = {cards: cardsFromAccountSnapshots(window.fixtures), errors: []};');
    const ctx = { storage: window.fixtureStorage, i18n: { register: value => bundles = value }, onDispose: () => {},
      registerMany: contributions => window.route = contributions.find(item => item.area === 'routes') };
    window.plugin.register(ctx);
    window.root = ReactDOM.createRoot(document.getElementById('root'));
    window.root.render(window.route.render());
  }, { source, preferences, locale });
  await page.locator('[data-account-row]').first().waitFor();
}
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
    await context.route('http://resetwatch-fixture.invalid/**', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://resetwatch-fixture.invalid/');
    await mount(page);
    const rows = page.locator('[data-account-row]');
    const first = rows.nth(0);
    const before = await rows.evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.accountRow, status: node.dataset.accountStatus, height: node.getBoundingClientRect().height })));
    assert.equal(before.length, 7);
    assert.equal(await page.getByRole('textbox', { name: 'Local alias' }).count(), 0, 'alias editor stays in collapsed Details');
    await first.getByRole('button', { name: 'Details', exact: false }).click();
    const input = page.getByRole('textbox', { name: 'Local alias', exact: true });
    await input.waitFor({ timeout: 2000 });
    await input.fill('  Work account  ');
    await page.getByRole('button', { name: 'Save alias', exact: true }).click();
    assert.equal(await first.locator('td').first().locator('strong').innerText(), 'Work account');
    assert.match(await page.locator('[data-account-details]').innerText(), /sa\*\*@example\.invalid/, 'original masked identity remains in Details');
    assert.equal(await rows.nth(1).locator('td').first().locator('strong').innerText(), 'sa**@example.invalid', 'same label at another host remains independent');
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.accountRow, status: node.dataset.accountStatus, height: node.getBoundingClientRect().height }))), before, 'aliases neither reorder/merge rows nor alter statuses/compact geometry');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugin.resetwatch-local.providers'))), preferences);
    assert.deepEqual(await page.evaluate(() => window.storageWrites), ['account_aliases'], 'saving aliases writes only its namespace');
    console.log('PASS alias editor, trimmed save, original masked identity, host isolation, stable seven-row geometry/order/status, untouched provider preferences');
    const banked = page.locator('[data-banked-resets]');
    assert.equal(await banked.count(), 4, 'banked-reset badges appear only for vendor-reported positive counts');
    assert.deepEqual(await banked.evaluateAll(nodes => nodes.map(node => Number(node.dataset.bankedResets))), [1, 2, 5, 5]);
    assert.equal(await rows.nth(1).locator('[data-banked-resets]').innerText(), 'Banked: 1 · usable now: 0');
    assert.equal(await rows.nth(2).locator('[data-banked-resets]').innerText(), 'Banked: 2 · usable now: 2');
    assert.equal(await rows.nth(3).locator('[data-banked-resets]').innerText(), 'Banked: 5 · usable now: 3');
    assert.equal(await rows.nth(5).locator('[data-banked-resets]').innerText(), 'Banked: 5 · usable now: ? · hist.');
    for (const index of [0, 4, 6]) assert.equal(await rows.nth(index).locator('[data-banked-resets]').count(), 0, 'zero/missing/invalid is not a banked-reset balance');
    for (const index of [1, 2, 3, 5]) {
      assert.equal(await rows.nth(index).locator('td').nth(2).locator('[data-banked-resets]').count(), 1, 'badge belongs to the account Weekly cell');
      assert.equal(await rows.nth(index).locator('td').nth(1).locator('[data-banked-resets]').count(), 0, 'Session does not duplicate reset balance');
    }
    assert.match(await rows.nth(5).locator('[data-banked-resets]').innerText(), /hist\./, 'stale counts must be marked historical');
    assert.match(await rows.nth(5).locator('[data-banked-resets]').getAttribute('title'), /Last vendor observation/);
    assert.match(await page.locator('[data-account-details]').innerText(), /You have 0 resets banked/, 'original diagnostics stay unchanged');
    await page.evaluate(() => {
      window.fixtures[3].cache_hit = true;
      window.liveData = { cards: window.makeCards(window.fixtures), errors: [] };
      window.root.render(window.route.render());
    });
    await rows.nth(3).locator('[data-banked-resets]').filter({ hasText: /hist\./ }).waitFor({ timeout: 2000 });
    await page.evaluate(() => {
      window.fixtures[3].cache_hit = false;
      window.liveData = { cards: window.makeCards(window.fixtures), errors: [] };
      window.root.render(window.route.render());
    });
    console.log('PASS banked resets: actual 1/2/5 counts, zero/missing/invalid hidden, per-account Weekly placement, stale historical marker');
    await page.evaluate(() => document.querySelectorAll('[data-banked-resets]').forEach(node => node.remove()));
    assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)), before.map(row => row.height), 'banked badge does not add row height');
    await page.reload();
    await mount(page);
    assert.equal(await first.locator('td').first().locator('strong').innerText(), 'Work account', 'alias survives a real browser reload/new plugin instance');
    assert.equal(await page.locator('[data-account-details]').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.storageWrites), [], 'reload does not rewrite preferences or aliases');
    await rows.nth(2).getByRole('button', { name: 'Details', exact: false }).click();
    await input.fill('Unknown A');
    await input.press('Enter');
    assert.equal(await rows.nth(2).locator('td').first().locator('strong').innerText(), 'Unknown A', 'Enter saves the labeled input');
    assert.equal(await rows.nth(3).locator('td').first().locator('strong').innerText(), 'Codex', 'credential-scoped unknown neighbors are not relabeled');
    assert.equal(await first.locator('td').first().locator('strong').innerText(), 'Work account');
    await rows.nth(2).getByRole('button', { name: 'Hide details', exact: false }).click();
    await first.getByRole('button', { name: 'Details', exact: false }).click();
    const hostile = '<img src=x onerror="window.aliasInjected=true">';
    await input.fill(hostile);
    await input.press('Enter');
    assert.equal(await first.locator('td').first().locator('strong').textContent(), hostile, 'alias is literal React text');
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.evaluate(() => window.aliasInjected), undefined);
    await input.fill('x'.repeat(120));
    assert.equal((await input.inputValue()).length, 80, 'alias length is bounded');
    await input.press('Enter');
    assert.equal((await first.locator('td').first().locator('strong').textContent()).length, 80);
    await input.fill('Work account');
    await input.press('Enter');
    for (const failure of ['throw', 'silent']) {
      await page.evaluate(value => window.storageFailure = value, failure);
      await input.fill('Not saved');
      await page.getByRole('button', { name: 'Save alias', exact: true }).click();
      assert.match(await page.getByRole('alert').innerText(), /Could not save/);
      assert.equal(await first.locator('td').first().locator('strong').innerText(), 'Work account', 'failed save must not change visible saved label');
      assert.equal(await page.getByRole('status').count(), 0, 'failed save must not claim success');
      await page.getByRole('button', { name: 'Clear alias', exact: true }).click();
      assert.equal(await first.locator('td').first().locator('strong').innerText(), 'Work account', 'failed clear retains original saved alias');
    }
    await page.evaluate(() => window.storageFailure = '');
    await page.getByRole('button', { name: 'Clear alias', exact: true }).click();
    assert.equal(await first.locator('td').first().locator('strong').innerText(), 'sa**@example.invalid');
    let savedAliases = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugin.resetwatch-local.account_aliases')));
    assert.equal(Object.hasOwn(savedAliases, 'openai-codex:scope-0-synthetic'), false, 'clear deletes the key rather than storing an empty alias');
    assert.equal(savedAliases['openai-codex:scope-2-synthetic'], 'Unknown A');
    await input.fill('Temporary'); await input.press('Enter');
    await input.fill('   '); await input.press('Enter');
    savedAliases = await page.evaluate(() => JSON.parse(localStorage.getItem('hermes.plugin.resetwatch-local.account_aliases')));
    assert.equal(Object.hasOwn(savedAliases, 'openai-codex:scope-0-synthetic'), false, 'whitespace save also deletes the alias');
    console.log('PASS browser reload, keyboard save, credential-scoped unknown isolation, literal text/XSS defense, 80-char limit, thrown/silent write failures, clear and empty-save deletion');
    const other = await context.newPage();
    await other.goto('http://resetwatch-fixture.invalid/'); await mount(other, 'pl');
    const otherRows = other.locator('[data-account-row]');
    assert.equal(await otherRows.nth(0).locator('td').first().locator('strong').innerText(), 'sa**@example.invalid');
    assert.equal(await otherRows.nth(2).locator('td').first().locator('strong').innerText(), 'Unknown A');
    assert.equal(await otherRows.nth(3).locator('td').first().locator('strong').innerText(), 'Codex');
    assert.equal(await otherRows.nth(1).locator('[data-banked-resets]').innerText(), 'W zapasie: 1 · do użycia teraz: 0');
    assert.equal(await otherRows.nth(2).locator('[data-banked-resets]').innerText(), 'W zapasie: 2 · do użycia teraz: 2');
    assert.equal(await otherRows.nth(3).locator('[data-banked-resets]').innerText(), 'W zapasie: 5 · do użycia teraz: 3');
    await otherRows.nth(2).getByRole('button', { name: 'Szczegóły', exact: false }).click();
    assert.match(await other.locator('[data-account-details]').innerText(), /W zapasie: 2 · do użycia teraz: 2/);
    assert.equal(await other.getByRole('textbox', { name: 'Alias lokalny', exact: true }).inputValue(), 'Unknown A');
    await other.getByRole('button', { name: 'Usuń alias', exact: true }).click();
    assert.equal(await otherRows.nth(2).locator('td').first().locator('strong').innerText(), 'Codex');
    await otherRows.nth(2).getByRole('button', { name: 'Ukryj szczegóły', exact: false }).click();
    await other.setViewportSize({ width: 420, height: 700 });
    const geometry = await other.evaluate(() => {
      const table = document.querySelector('[data-account-overview]');
      const rows = [...document.querySelectorAll('[data-account-row]')];
      return { rows: rows.length, heights: rows.map(node => node.getBoundingClientRect().height), lastBottom: rows.at(-1).getBoundingClientRect().bottom,
        horizontalScroll: table.scrollWidth > table.clientWidth, bodyOverflow: document.documentElement.scrollWidth > innerWidth,
        columns: document.querySelector('[data-account-overview] thead tr').children.length };
    });
    assert.equal(geometry.rows, 7); assert.equal(geometry.columns, 4);
    assert.equal(geometry.horizontalScroll, true); assert.equal(geometry.bodyOverflow, false);
    assert.deepEqual(geometry.heights, before.map(row => row.height)); console.log('Geometry:', JSON.stringify(geometry)); assert.ok(geometry.lastBottom < 550);
    console.log('PASS neighboring browser tab reload/account isolation, Polish aliases and exact 1/2/5 balance labels, narrow scrolling; geometry:', JSON.stringify(geometry));
    // A snapshot without a stable key cannot inherit an alias via a masked email.
    await page.evaluate(() => {
      window.fixtures[0] = { ...window.fixtures[0], account_key: '', account_label: 'no-key@example.invalid' };
      window.liveData = { cards: window.makeCards(window.fixtures), errors: [] };
      window.root.render(window.route.render());
    });
    await page.locator('[data-account-row]').first().getByRole('button', { name: 'Details', exact: false }).click();
    assert.match(await page.locator('[data-account-details]').innerText(), /stable account identity is unavailable/);
    assert.equal(await input.count(), 0, 'unscoped legacy unknown has no alias editor');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
