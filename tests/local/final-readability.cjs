// Bounded offline fixture: real renderer helpers, no browser/vendor/gateway calls.
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').resolve(__dirname, '../../resetwatch-local/plugin.js'), 'utf8');
const atom = value => ({ get: () => value, set: next => value = next });
const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
const context = vm.createContext({ sdk: { atom, useValue: a => a.get(), host: {} }, jsx, jsxs: jsx, Fragment: 'fragment', useState: value => [value, () => {}], useEffect: () => {} });
vm.runInContext(source.replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {'), context);
const run = expression => vm.runInContext(expression, context);
context.now = Date.now();
const fixture = { provider: 'openai-codex', account_key: 'fixture', account_label: 'test@example.invalid', account_status: 'verified', credential_status: 'ready', quota_state: 'available', allowed: true, fetched_at: (context.now - 60000) / 1000, windows: [{ label: 'Session', remaining_percent: 80, used_percent: 20, reset_at: new Date(context.now + 3600000).toISOString() }, { label: 'Weekly', remaining_percent: 60, used_percent: 40, reset_at: new Date(context.now + 86400000).toISOString() }], rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } };
function nodes(node, attr) { return Array.isArray(node) ? node.flatMap(n => nodes(n, attr)) : node && typeof node === 'object' ? [...(node.props[attr] !== undefined ? [node] : []), ...nodes(node.props.children, attr)] : []; }
function text(node) { return Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node == null ? '' : String(node); }
for (const [credential, auth, label] of [['ready', 'verified', 'Zalogowane'], ['expired', 'verified', 'Token wygasł / wygasa'], ['revoked', 'verified', 'Zaloguj się ponownie'], ['missing', 'verified', 'Brak tokenu'], ['ready', 'auth_required', 'Błąd logowania'], ['ready', 'unknown', 'Nieznany']]) {
  context.snap = { ...fixture, credential_status: credential, account_status: auth };
  const row = run('AccountOverviewRow({snap, nowMs:now, accountKey:"fixture"})');
  const health = nodes(row, 'data-auth-health')[0];
  assert.equal(text(health), label);
  assert.match(health.props.title, /nie.*gwarancj/);
  assert.equal(text(nodes(row, 'data-quota-availability')[0]), credential === 'ready' && auth === 'verified' ? 'Dostępne' : 'Limity: Nieznane');
  assert.equal(text(nodes(row, 'data-banked-resets')[0]), 'Resety:2 · teraz:0' + (credential === 'ready' && auth === 'verified' ? '' : ' · hist.'));
}
context.snap = fixture;
const row = run('AccountOverviewRow({snap, nowMs:now, accountKey:"fixture"})');
assert.match(text(nodes(row, 'data-quota-freshness')[0]), /min temu · Aktualne/);
context.snap = { ...fixture, fetched_at: (context.now - 900000) / 1000 };
assert.equal(run('deriveAccountStatus(snap,now).availability'), 'unknown');
assert.match(text(nodes(run('AccountOverviewRow({snap,nowMs:now,accountKey:"fixture"})'), 'data-quota-freshness')[0]), /Nieaktualne/);
assert.match(source, /resetwatch-local-account-table > tbody > tr\[data-account-row\]:hover > td/);
assert.match(source, /color-mix\(in srgb, var\(--ui-text-primary\) 5%, transparent\)/);
assert.match(source, /\['account', '20%'\], \['session', '24%'\], \['weekly', '29%'\], \['observation', '27%'\]/);
assert.ok(!source.includes('LanguageControl') && !source.includes('saveLanguage'));
console.log('PASS one offline fixture: Polish labels/tooltips; revoked/expired/missing/401/unknown never logged in; quota/freshness separate; exact 2/0 reset counts; scoped themed hover CSS; original column ratios; no selector/global locale changes.');
