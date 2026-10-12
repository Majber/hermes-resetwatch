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
    assert.doesNotMatch(await details.innerText(), /Resets:.*hist\./, 'Details uses the same freshness');
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
    for (const locale of ['en', 'pl']) {
      await page.evaluate(locale => window.setFixtureLanguage(locale), locale);
      await page.getByRole('columnheader', { name: locale === 'pl' ? 'Konto / stan' : 'Account / status', exact: true }).waitFor();
      for (const width of [1540, 1100, 420]) {
        await page.setViewportSize({ width, height: 630 });
        const result = await page.evaluate(() => {
          const wrapper = document.querySelector('[data-account-overview]');
          const table = wrapper.querySelector('table');
          const headers = [...table.querySelectorAll('thead th')];
          const rows = [...document.querySelectorAll('[data-account-row]')];
          const primary = rows.flatMap(row => [...row.querySelectorAll('strong')]).concat(headers);
          const secondary = [...table.querySelectorAll('[data-auth-health], [data-quota-freshness], [data-banked-resets], [data-account-toggle]')];
          const violations = [];
          for (const row of rows) for (const [index, cell] of [...row.cells].entries()) {
            const bounds = cell.getBoundingClientRect();
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            const rects = [];
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent.trim()) continue;
              const range = document.createRange(); range.selectNodeContents(walker.currentNode);
              const parent = walker.currentNode.parentElement;
              // Aliases intentionally ellipsize; their clipped text is not an overflow.
              if (getComputedStyle(parent).textOverflow === 'ellipsis') continue;
              for (const rect of range.getClientRects()) {
                if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)
                  violations.push(`cell ${index}: overflowing text`);
                rects.push(rect);
              }
            }
            for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i], b = rects[j];
              if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1)
                violations.push(`cell ${index}: overlapping text`);
            }
            for (const meter of cell.querySelectorAll('[role="meter"]')) {
              const rect = meter.getBoundingClientRect();
              if (rect.right > bounds.right - 4) violations.push(`cell ${index}: overflowing meter`);
              if (rects.some(text => Math.min(rect.right, text.right) - Math.max(rect.left, text.left) > 1 && Math.min(rect.bottom, text.bottom) - Math.max(rect.top, text.top) > 1))
                violations.push(`cell ${index}: meter overlaps text`);
            }
          }
          const meter = rows[0].cells[2].querySelector('[role="meter"]');
          return { viewport: innerWidth, width: table.getBoundingClientRect().width, wrapperWidth: wrapper.clientWidth,
            cols: headers.map(n => n.getBoundingClientRect().width), height: table.getBoundingClientRect().height,
            lastRowBottom: rows.at(-1).getBoundingClientRect().bottom,
            primary: [...new Set(primary.map(n => getComputedStyle(n).fontSize))],
            secondary: [...new Set(secondary.map(n => getComputedStyle(n).fontSize))],
            weeklyBar: meter.getBoundingClientRect().width, barEndGap: rows[0].cells[2].getBoundingClientRect().right - meter.getBoundingClientRect().right,
            scroll: wrapper.scrollWidth > wrapper.clientWidth, bodyOverflow: document.documentElement.scrollWidth > innerWidth,
            rows: rows.length, violations };
        });
        assert.equal(result.rows, 7); assert.equal(result.bodyOverflow, false);
        assert.deepEqual(result.primary, ['15px'], 'account, percentages and headers use readable primary typography');
        assert.deepEqual(result.secondary, ['13px'], 'auth, freshness, reset balance and Details use readable secondary typography');
        assert.deepEqual(result.violations, [], `${locale}/${width}: text and meters stay inside their own cells without overlap`);
        assert.ok(result.height < 550 && result.lastRowBottom < (width === 420 ? 630 : 580), `all seven collapsed rows fit the screen: ${JSON.stringify({ locale, ...result })}`);
        assert.equal(result.scroll, width === 420);
        [0.20, 0.24, 0.29, 0.27].forEach((ratio, i) => assert.ok(Math.abs(result.cols[i] / result.width - ratio) < 0.015, 'account is narrower and observation starts closer to Weekly'));
        if (width !== 420) assert.ok(Math.abs(result.width - result.wrapperWidth) < 2, 'table uses its entire container');
        assert.ok(result.barEndGap < 12, 'responsive Weekly bar uses available space, without a 240px cap');
        if (width === 1540) assert.ok(result.weeklyBar > 300 && result.width > 1450, 'wide desktop retains full-width table and proportional bars');
        geometry.push({ locale, ...result });
      }
    }
    assert.ok(await page.getByRole('button', { name: 'Zegary ręczne', exact: false }).count(), 'Manual clocks remains');
    assert.deepEqual(await page.evaluate(() => window.storageWrites), [], 'provider preferences are not rewritten');
    assert.deepEqual(errors, []);
    console.log('PASS fresh cached / stale / elapsed reset / failed / missing observation; vendor timestamp; hidden row ID with retained Details; Manual clocks; no preference writes');
    console.log(JSON.stringify(geometry));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
