// Targeted synthetic Chromium regression; imports the existing SDK fixture only.
// No gateway, token probes or full test suite. All network is fixture-routed.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { mount, fixtureHtml } = require('./aliases-browser.cjs');

function contrast(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [a, b] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (a + 0.05) / (b + 0.05);
}
async function measure(page) {
  return page.evaluate(() => {
    const overview = document.querySelector('[data-account-overview]');
    const table = overview.querySelector('table');
    const rows = [...document.querySelectorAll('[data-account-row]')];
    const box = table.getBoundingClientRect();
    return {
      width: box.width, left: box.left, wrapperLeft: overview.getBoundingClientRect().left,
      horizontalScroll: overview.scrollWidth > overview.clientWidth,
      bodyOverflow: document.documentElement.scrollWidth > innerWidth,
      rows: rows.length, lastBottom: rows.at(-1).getBoundingClientRect().bottom,
      heights: rows.map(row => row.getBoundingClientRect().height),
      primary: getComputedStyle(rows[0].querySelector('strong')).fontSize,
      secondary: getComputedStyle(rows[0].querySelector('[data-auth-health]')).fontSize,
      collapsed: document.querySelectorAll('[data-account-toggle][aria-expanded="false"]').length,
      columns: table.querySelector('thead tr').children.length,
      widths: [...table.querySelector('thead tr').children].map(node => node.getBoundingClientRect().width)
    };
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 700 } });
    await context.route('**/*', route => {
      assert.equal(new URL(route.request().url()).hostname, 'resetwatch-fixture.invalid', 'no external requests');
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://resetwatch-fixture.invalid/');
    await mount(page, 'pl');
    const failures = [];
    for (const mode of ['dark', 'light']) {
      await page.evaluate(mode => {
        const root = document.documentElement;
        root.style.colorScheme = mode;
        document.body.style.backgroundColor = 'var(--ui-bg-elevated)';
        // Deliberately distinct test palettes, not production hardcoded colors.
        for (const [key, value] of Object.entries(mode === 'dark'
          ? { primary: '#eeeeee', secondary: '#cccccc', tertiary: '#aaaaaa', bg: '#222222' }
          : { primary: '#171717', secondary: '#333333', tertiary: '#555555', bg: '#fafafa' })) {
          root.style.setProperty(key === 'bg' ? '--ui-bg-elevated' : `--ui-text-${key}`, value);
          if (key === 'bg') root.style.setProperty('--ui-bg-primary', 'rgba(127, 127, 127, 0.1)');
        }
      }, mode);
      const styles = await page.locator('select, select option').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { label: node.textContent, option: node.tagName === 'OPTION', color: style.color,
          background: style.backgroundColor, font: style.fontSize, scheme: style.colorScheme };
      }));
      assert.equal(styles.filter(style => style.option).length, 7, 'all five sorts plus both display options');
      for (const style of styles) {
        if (style.background === 'rgba(0, 0, 0, 0)' || contrast(style.color, style.background) < 4.5)
          failures.push(`${mode}: unreadable unhovered ${style.label}: ${JSON.stringify(style)}`);
        if (style.scheme !== mode) failures.push(`${mode}: native color scheme mismatch`);
        if (parseFloat(style.font) < 13) failures.push(`${mode}: tiny control/option type`);
      }
      const geometry = await measure(page);
      if (geometry.width > 1161) failures.push(`${mode}: stretched table ${geometry.width}px`);
      if (parseFloat(geometry.primary) < 13 || parseFloat(geometry.secondary) < 12) failures.push(`${mode}: tiny account typography`);
      console.log(JSON.stringify({ mode, minimumContrast: Math.min(...styles.map(style => contrast(style.color, style.background))), styles, geometry }));
      if (process.env.RESETWATCH_READABILITY_SCREENSHOT) {
        await page.getByRole('combobox', { name: 'Sortowanie kont' }).click();
        await page.screenshot({ path: process.env.RESETWATCH_READABILITY_SCREENSHOT.replace(/\.png$/, `-${mode}-popup.png`) });
        await page.keyboard.press('Escape');
      }
    }
    assert.deepEqual(failures, [], 'all unhovered options need readable theme colors, and table needs a compact readable layout');
    const desktop = await measure(page);
    assert.equal(desktop.rows, 7); assert.equal(desktop.columns, 4); assert.equal(desktop.collapsed, 7);
    assert.equal(desktop.left, desktop.wrapperLeft, 'left aligned, not centered');
    assert.equal(desktop.horizontalScroll, false); assert.equal(desktop.bodyOverflow, false);
    assert.ok(desktop.lastBottom <= 600, 'seven collapsed rows within 600px');
    for (const width of [1100, 420]) {
      await page.setViewportSize({ width, height: 700 });
      const geometry = await measure(page);
      assert.equal(geometry.bodyOverflow, false);
      assert.equal(geometry.horizontalScroll, width === 420);
      assert.deepEqual(geometry.heights, desktop.heights, 'narrow view preserves compact rows');
      assert.ok(geometry.lastBottom <= 600);
      console.log(JSON.stringify({ viewport: width, geometry }));
    }
    await page.setViewportSize({ width: 1500, height: 700 });
    const sort = page.getByRole('combobox', { name: 'Sortowanie kont' });
    for (const key of ['default', 'session', 'weekly', 'reset', 'state']) {
      await sort.selectOption(key);
      assert.equal(await sort.inputValue(), key);
      if (key !== 'default') {
        const direction = page.getByTitle(/^(Rosnąco|Malejąco)$/);
        const old = await direction.getAttribute('title');
        await direction.click();
        assert.notEqual(await direction.getAttribute('title'), old);
      }
    }
    // Native select remains keyboard-operable without a custom control implementation.
    await sort.focus(); await sort.press('Home'); await sort.press('ArrowDown'); await sort.press('Enter');
    assert.equal(await sort.inputValue(), 'session');
    await page.getByRole('combobox', { name: 'Sposób wyświetlania limitu' }).selectOption('used');
    await page.reload(); await mount(page, 'pl');
    assert.equal(await sort.inputValue(), 'session');
    assert.equal(await page.getByRole('combobox', { name: 'Sposób wyświetlania limitu' }).inputValue(), 'used');
    assert.equal(await page.locator('[data-account-row]').first().locator('td').nth(1).locator('strong').innerText(), '20%');
    assert.deepEqual(await page.evaluate(() => window.storageWrites), [], 'mount/reload do not rewrite preferences');
    await page.evaluate(() => window.fixtureHost.state.profile.set('neighbor-profile'));
    await page.waitForFunction(() => document.querySelector('select[aria-label="Sortowanie kont"]').value === 'default');
    await sort.selectOption('weekly');
    await page.evaluate(() => window.fixtureHost.state.connectionId.set('neighbor-connection'));
    await page.waitForFunction(() => document.querySelector('select[aria-label="Sortowanie kont"]').value === 'default');
    await sort.selectOption('reset');
    await page.evaluate(() => { window.fixtureHost.state.connectionId.set(''); window.fixtureHost.state.profile.set('default'); });
    await page.waitForFunction(() => document.querySelector('select[aria-label="Sortowanie kont"]').value === 'session');
    assert.equal(await page.getByTitle('Malejąco', { exact: true }).count(), 1, 'saved direction restored with scope');
    assert.deepEqual(await page.evaluate(() => window.fixtureStorage.get('providers')), { disabled: ['nous', 'openrouter'], order: ['openai-codex'] });
    assert.equal(await page.locator('[data-banked-resets]').count(), 4);
    await page.locator('[data-account-toggle]').first().click();
    await page.getByRole('textbox', { name: 'Alias lokalny', exact: true }).fill('Synthetic alias');
    await page.getByRole('button', { name: 'Zapisz alias', exact: true }).click();
    assert.equal(await page.locator('[data-account-row]').first().locator('strong').first().innerText(), 'Synthetic alias');
    await page.locator('[data-account-toggle]').first().click();
    assert.equal(await page.locator('[data-account-details]').count(), 0);
    assert.deepEqual(errors, []);
    if (process.env.RESETWATCH_READABILITY_SCREENSHOT) await page.screenshot({ path: process.env.RESETWATCH_READABILITY_SCREENSHOT });
    console.log('PASS minimal synthetic browser: every unhovered option contrasts in both themes; 13/12px type, bounded left-aligned table, seven compact rows, narrow scroll, keyboard/native selection, all sorts/direction, reload and connection/profile isolation, used mode, aliases, counts and provider preferences');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
