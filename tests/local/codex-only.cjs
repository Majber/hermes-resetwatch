// One offline targeted check: real plugin logic with a synthetic SDK, no vendor calls.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.resolve(__dirname, '../../resetwatch-local/plugin.js'), 'utf8')
  .replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {');
const atom = value => ({ get: () => value, set: next => { value = next; } });
const jsx = (type, props, key) => ({ type, props, key });
const preferences = { disabled: ['openai-codex', 'nous'], order: ['openrouter', 'openai-codex'] };
const clocks = [{ id: 'clock:fixture', name: 'Manual fixture', remaining: 40, resetAt: null }];
const store = new Map([['providers', preferences], ['clocks', clocks], ['display_mode', 'used']]);
const writes = [];
let rejectWrites = false;
let query;
const cards = [
  { id: 'account:openai-codex:fixture:0:Session', provider: 'Codex', group: 'Codex' },
  { id: 'account:openrouter:fixture:0:Credits', provider: 'OpenRouter', group: 'OpenRouter' },
  { id: 'unknown:fixture', provider: 'Unknown fixture', group: 'Unknown fixture' }
];
const host = { state: { gateway: atom('idle'), focusedSessionId: atom(''), connectionId: atom('local'), profile: atom('default') },
  request: () => { throw Error('Network forbidden'); } };
const context = vm.createContext({ console, Date, Math, Set, Map, JSON, Number, String, Boolean, Promise, Error, RegExp,
  sdk: { atom, host, useValue: a => a.get(), useQuery: options => { query = options; return { data: { cards, errors: [] } }; },
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'nav', PALETTE_AREA: 'palette' }, Fragment: 'fragment', jsx, jsxs: jsx,
  useEffect: () => {}, useMemo: f => f(), useRef: value => ({ current: value }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  setInterval: () => { throw Error('Polling forbidden'); }, clearInterval: () => {},
  setTimeout: () => { throw Error('Timers forbidden'); }, clearTimeout: () => {} });
vm.runInContext(source, context);
const run = expression => vm.runInContext(expression, context);
context.ctx = { storage: { get: (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback,
  set: (key, value) => { writes.push(key); if (!rejectWrites) store.set(key, structuredClone(value)); } },
  registerMany: () => {}, onDispose: () => {} };
const nodes = (element, predicate) => Array.isArray(element) ? element.flatMap(item => nodes(item, predicate))
  : !element || typeof element !== 'object' ? []
  : [...(predicate(element) ? [element] : []), ...nodes(element.props?.children, predicate)];
const named = (element, name) => nodes(element, node => typeof node.type === 'function' && node.type.name === name);
const render = () => run('PluginPageContent()');
const settings = page => { context.settingsProps = named(page, 'ProviderControls')[0].props; return run('ProviderControls(settingsProps)'); };
const toggle = page => nodes(settings(page), node => node.type === 'select' && node.props['aria-label'] === 'Zakres dostawców')[0];
run('plugin.register(ctx)');
let page = render();
assert.equal(toggle(page).props.value, 'all', 'default preserves full view');
assert.equal(named(page, 'SectionHeader').some(node => node.props.title === 'Zegary ręczne'), true);
assert.equal(query.queryKey.at(-1), 'nous,openai-codex');
assert.deepEqual(writes, [], 'registration/render never rewrites existing preferences');
assert.equal(settings(page).type, 'details', 'toggle lives in collapsed provider settings');
assert.equal(settings(page).props.open, undefined, 'settings remain collapsed by default');
toggle(page).props.onChange({ target: { value: 'codex' } });
page = render();
assert.equal(toggle(page).props.value, 'codex');
const effectiveDisabled = Array.from(run('effectiveProviderPreferences($providerPreferences.get(), "codex").disabled'));
assert.deepEqual(effectiveDisabled.slice().sort(), Array.from(run('LIVE_PROVIDERS')).filter(key => key !== 'openai-codex').sort());
assert.equal(query.queryKey.at(-1), effectiveDisabled.join(','), 'fetch query uses effective disabled list, not stored disabled Codex');
assert.deepEqual(named(page, 'ProviderBlock').flatMap(node => node.props.cards.map(card => card.id)), [cards[0].id], 'even unknown/non-Codex rows hidden');
assert.equal(named(page, 'SectionHeader').some(node => node.props.title === 'Zegary ręczne'), false, 'whole manual section including Add clock hidden');
assert.equal(named(page, 'ProviderControls').length, 1, 'provider settings still reachable');
assert.equal(nodes(page, node => node.type === 'summary' && node.props.children === 'Pomoc · tylko odczyt').length, 1);
run('plugin.register(ctx)');
assert.equal(toggle(render()).props.value, 'codex', 'mode persists after reload');
assert.equal(run('viewModeFor("remote", "default")'), 'all', 'connection isolation');
assert.equal(run('viewModeFor("local", "other")'), 'all', 'profile isolation');
rejectWrites = true;
assert.equal(run('saveViewMode("local", "default", "all")'), false);
assert.equal(run('viewModeFor("local", "default")'), 'codex', 'failed storage write does not change displayed mode');
assert.equal(run('saveViewMode(null, "default", "codex")'), false, 'unresolved owner cannot persist mode');
rejectWrites = false;
toggle(render()).props.onChange({ target: { value: 'all' } });
run('plugin.register(ctx)');
page = render();
assert.equal(toggle(page).props.value, 'all');
assert.equal(query.queryKey.at(-1), 'nous,openai-codex', 'prior fetch choices restored including disabled Codex');
assert.equal(named(page, 'SectionHeader').some(node => node.props.title === 'Zegary ręczne'), true);
assert.equal(named(page, 'LimitCard').some(node => node.props.card.id === clocks[0].id), true, 'manual clock restored');
assert.deepEqual(store.get('providers'), preferences);
assert.deepEqual(store.get('clocks'), clocks);
assert.equal(store.get('display_mode'), 'used');
assert.equal(writes.every(key => key === 'view_modes'), true, 'toggle writes only its own plugin-local key');
assert.equal(run('viewModeFor("local", "default")'), 'all');
console.log('PASS Codex-only toggle: default/full view, effective fetch selection, Codex-only rows, manual hiding/restoration, persistence, connection/profile isolation, failed-write readback, untouched preferences/clocks/display mode. Offline SDK fixture only.');
