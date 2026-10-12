// Minimal synthetic regression: no gateway, vendor calls or real credentials.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { mount, fixtureHtml } = require('./aliases-browser.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 700 } });
    await context.route('**/*', route => {
      assert.equal(new URL(route.request().url()).hostname, 'resetwatch-fixture.invalid');
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://resetwatch-fixture.invalid/');
    await mount(page);
    const row = page.locator('[data-account-row]').nth(3);
    const badge = row.locator('[data-banked-resets]');
    await page.evaluate(() => {
      window.fixtures[3].cache_hit = true;
      window.liveData = { cards: window.makeCards(window.fixtures), errors: [] };
      window.root.render(window.route.render());
    });
    await row.getByRole('button', { name: 'Details', exact: false }).click();
    assert.equal(await row.locator('[data-quota-freshness]').getAttribute('data-quota-freshness'), 'fresh');
    assert.doesNotMatch(await badge.innerText(), /hist\./, 'fresh cache reuse is not historical');
    const details = page.locator('[data-account-details]');
    assert.doesNotMatch(await details.innerText(), /Banked:.*hist\./, 'Details uses the same freshness');
    assert.match(await details.innerText(), /first-host\.invalid.*ID scope-3-sy/, 'technical identity remains in Details');
    assert.doesNotMatch(await row.innerText(), /scope-3/, 'technical ID is absent from the main row');
    const vendorStamp = await page.evaluate(() => new Date(window.fixtures[3].fetched_at * 1000).toLocaleString());
    assert.ok((await badge.getAttribute('title')).includes(vendorStamp), 'timestamp is the vendor observation, not the cache read');
    await row.locator('[data-account-toggle]').click();
    for (const [kind, expected] of [['stale', 'stale'], ['pending', 'pending'], ['failed', 'historical'], ['missing', 'unknown']]) {
      await page.evaluate(kind => {
        const snap = window.fixtures[3];
        snap.fetched_at = kind === 'missing' ? null : (Date.now() - (kind === 'stale' ? 900000 : 60000)) / 1000;
        snap.error = kind === 'failed' ? 'Synthetic failed check' : '';
        snap.windows[0].reset_at = new Date(Date.now() + (kind === 'pending' ? -1000 : 3600000)).toISOString();
        window.liveData = { cards: window.makeCards(window.fixtures), errors: [] };
        window.root.render(window.route.render());
      }, kind);
      await page.waitForFunction(expected => document.querySelectorAll('[data-account-row]')[3].querySelector('[data-quota-freshness]').dataset.quotaFreshness === expected, expected);
      assert.match(await badge.innerText(), /hist\./, `${kind} balance must be historical`);
    }
    const geometry = [];
    for (const width of [1500, 1100, 420]) {
      await page.setViewportSize({ width, height: 700 });
      const result = await page.evaluate(() => {
        const wrapper = document.querySelector('[data-account-overview]');
        const table = wrapper.querySelector('table');
        const cols = [...table.querySelectorAll('thead th')].map(n => n.getBoundingClientRect().width);
        return { viewport: innerWidth, width: table.getBoundingClientRect().width, cols,
          scroll: wrapper.scrollWidth > wrapper.clientWidth, bodyOverflow: document.documentElement.scrollWidth > innerWidth,
          rows: document.querySelectorAll('[data-account-row]').length };
      });
      assert.equal(result.rows, 7); assert.equal(result.bodyOverflow, false);
      assert.equal(result.scroll, width === 420);
      [0.22, 0.24, 0.32, 0.22].forEach((ratio, i) => assert.ok(Math.abs(result.cols[i] / result.width - ratio) < 0.015, 'columns follow balanced proportions'));
      if (width === 1500) assert.ok(result.width > 1400, 'parent full-width correction remains');
      geometry.push(result);
    }
    assert.ok(await page.getByRole('button', { name: 'Manual clocks', exact: false }).count(), 'Manual clocks remains');
    assert.deepEqual(await page.evaluate(() => window.storageWrites), [], 'provider preferences are not rewritten');
    assert.deepEqual(errors, []);
    console.log('PASS fresh cached / stale / elapsed reset / failed / missing observation; vendor timestamp; hidden row ID with retained Details; Manual clocks; no preference writes');
    console.log(JSON.stringify(geometry));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
