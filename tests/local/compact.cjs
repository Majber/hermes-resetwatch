const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const sourcePath = path.resolve(__dirname, '../../resetwatch-local/plugin.js');
const probePath = path.resolve(__dirname, '../../resetwatch-local/probe.py');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {');
const atom = value => ({ get: () => value, set: next => value = next });
const jsx = (type, props, key) => ({ type, props, key });
const now = Date.now();
const fixtures = Array.from({ length: 7 }, (_, index) => ({
  provider: 'openai-codex', plan: 'Plus', account_key: `${(index+1).toString(16).padStart(8,'0')}-fixture-key`, account_label: `fixture${index}@example.invalid`,
  ...(index === 2 ? {error:'token_revoked'} : {}),
  account_status: ['verified','verified','revoked','expired','missing','verified','verified'][index],
  quota_state: index === 1 ? 'limit_reached' : 'available', allowed: index !== 1,
  fetched_at: index === 4 ? null : (now - (index === 5 ? 900000 : 60000)) / 1000,
  inspected_at: now / 1000, last_attempt_at: now / 1000, cache_hit: true,
  source_host: 'https://diagnostic-host.invalid', grant_count: 2, grant_states: { ready: 1, revoked: 1 },
  details: ['Diagnostic fixture only'],
  windows: index === 4 ? [] : [
    {label:'Session',used_percent:index===1?100:20,remaining_percent:index===1?0:80,reset_at:new Date(now+(index===6?-1000:3600000)).toISOString()},
    {label:'Weekly',used_percent:40,remaining_percent:60,reset_at:new Date(now+86400000).toISOString()},
    {label:'Extra model',used_percent:10,remaining_percent:90,reset_at:new Date(now+86400000).toISOString()}
  ]
}));
let localeBundle;
const writes = [];
const preferences = {disabled:['nous','openrouter'],order:['openai-codex']};
const store = new Map([['providers',structuredClone(preferences)],['display_mode','remaining']]);
const host = {state:{gateway:atom('open'),focusedSessionId:atom(''),profile:atom('default')},request:async()=>({})};
let liveData = {cards:[],errors:[]};
const sdk = {atom,host,useValue:a=>a.get(),useQuery:()=>({data:liveData,isFetching:false}),ROUTES_AREA:'routes',SIDEBAR_NAV_AREA:'nav',PALETTE_AREA:'palette',usePluginI18n:()=>({t:key=>localeBundle?.pl[key]||localeBundle?.en[key]||key})};
const context = vm.createContext({console,Date,Math,Set,Map,JSON,Number,String,Boolean,Promise,Error,RegExp,sdk,Fragment:'fragment',jsx,jsxs:jsx,useEffect:()=>{},useMemo:f=>f(),useRef:v=>({current:v}),useState:v=>[typeof v==='function'?v():v,()=>{}],setInterval:()=>0,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{}});
vm.runInContext(source,context);
const run = expression => vm.runInContext(expression,context);
context.ctx={storage:{get:(key,fallback)=>store.has(key)?store.get(key):fallback,set:(key,value)=>{writes.push(key);store.set(key,value)}},i18n:{register:value=>localeBundle=value},registerMany:()=>{},onDispose:()=>{}};
run('plugin.register(ctx)');
context.fixtures=fixtures; context.now=now;
liveData.cards=run('cardsFromAccountSnapshots(fixtures)');
function resolve(element) {
  if (element == null || typeof element === 'boolean') return null;
  if (Array.isArray(element)) return element.flatMap(item=>[resolve(item)]).filter(Boolean);
  if (typeof element !== 'object') return String(element);
  if (typeof element.type==='function') return resolve(element.type(element.props));
  return {...element,props:{...element.props,children:resolve(element.props?.children)}};
}
function nodes(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(item=>nodes(item,predicate));
  if (!element || typeof element !== 'object') return [];
  return [...(predicate(element)?[element]:[]),...nodes(element.props?.children,predicate)];
}
function textOf(element) {
  if (Array.isArray(element)) return element.map(textOf).join(' ');
  if (!element || typeof element !== 'object') return element || '';
  return textOf(element.props.children);
}
const page=resolve(run('Page()'));
const tables=nodes(page,n=>n.type==='table');
assert.equal(tables.length,1,'Codex must render one compact overview table, not stacked diagnostic cards');
const rows=nodes(page,n=>n.type==='tr' && n.props['data-account-row']);
assert.equal(rows.length,7,'all seven accounts appear once');
assert.equal(nodes(page,n=>n.props['data-account-details']).length,0,'diagnostics are not rendered before expansion');
assert.equal(nodes(page,n=>n.type==='button' && n.props['aria-expanded']===false && n.props['data-account-toggle']).length,7,'each account has a collapsed details control');
assert.equal(nodes(page,n=>n.type==='details' && n.props.open).length,0,'help/provider controls are initially collapsed');
assert.doesNotMatch(textOf(page),/diagnostic-host|Credential entries|Wpisy danych logowania|Sprawdzono lokalne|Live rows are plans/,'diagnostics and marketing copy stay out of overview');
assert.match(textOf(page),/Sesja/); assert.match(textOf(page),/Tydzień/); assert.match(textOf(page),/Dostępność \/ odczyt/);
assert.equal(nodes(page,n=>n.props.role==='meter').length,12,'two main quota bars per account with observations, no duplicate cards');
assert.match(textOf(rows[0]),/80%/);
assert.match(textOf(rows[2]),/hist\./,'revoked account quota is explicitly historical');
assert.match(textOf(rows[6]),/Do sprawdzenia/,'elapsed reset must not imply renewed quota');
assert.deepEqual(store.get('providers'),preferences);
assert.deepEqual(writes,[],'mounting/overview rendering must not rewrite stored preferences');
run('saveDisplayMode("used")');
run('plugin.register(ctx)');
const usedPage=resolve(run('Page()'));
assert.match(textOf(nodes(usedPage,n=>n.type==='tr'&&n.props['data-account-row'])[0]),/20%/);
assert.equal(store.get('display_mode'),'used');
assert.deepEqual(store.get('providers'),preferences);
let expandedState = false;
context.useState = value => [expandedState,next=>expandedState=typeof next==='function'?next(expandedState):next];
const collapsed=resolve(run('AccountOverviewRow({snap:fixtures[0],nowMs:now})'));
nodes(collapsed,n=>n.props['data-account-toggle'])[0].props.onClick();
const expanded=resolve(run('AccountOverviewRow({snap:fixtures[0],nowMs:now})'));
assert.equal(nodes(expanded,n=>n.props['data-account-details']).length,1);
assert.match(textOf(expanded),/diagnostic-host|Wpisy danych logowania/);
assert.match(textOf(expanded),/Extra model/,'additional buckets remain available in expanded details');
assert.ok(textOf(expanded).includes(new Date(fixtures[0].windows[0].reset_at).toLocaleString()),'expanded details retain exact Session reset timestamp');
nodes(expanded,n=>n.props['data-account-toggle'])[0].props.onClick();
assert.equal(nodes(resolve(run('AccountOverviewRow({snap:fixtures[0],nowMs:now})')),n=>n.props['data-account-details']).length,0,'details collapse again');
context.useState = value => [typeof value==='function'?value():value,()=>{}];
run('saveDisplayMode("remaining")');
const crypto=require('node:crypto');
assert.equal(run('plugin.defaultEnabled'),true);
const probeBefore=crypto.createHash('sha256').update(fs.readFileSync(probePath)).digest('hex');
console.log('PASS compact overview: 7 rows; 7 collapsed toggles; 12 quota bars; historical/pending labels; expanded diagnostics/extra buckets; Polish strings; remaining/used reload; provider preferences preserved; standalone default preserved');
function html(element) {
  if (Array.isArray(element)) return element.map(html).join('');
  if (!element || typeof element !== 'object') return String(element||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const props=element.props||{};
  if(element.type==='fragment') return html(props.children);
  const attrs=Object.entries(props).filter(([key,value])=>key!=='children'&&key!=='style'&& !key.startsWith('on') && value!==undefined&&value!==null && (value!==false||key.startsWith('aria-')||key.startsWith('data-'))).map(([key,value])=>` ${key==='className'?'class':key}="${String(value).replaceAll('&','&amp;').replaceAll('"','&quot;')}"`).join('');
  const units=new Set(['fontWeight','opacity','flex','flexShrink','order']);
  const style=Object.entries(props.style||{}).map(([key,value])=>`${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}:${typeof value==='number'&&value!==0&&!units.has(key)?value+'px':value}`).join(';');
  return `<${element.type}${attrs}${style?` style="${style}"`:''}>${html(props.children)}</${element.type}>`;
}
if (process.env.RESETWATCH_FIXTURE_HTML) fs.writeFileSync(process.env.RESETWATCH_FIXTURE_HTML,`<!doctype html><html lang="pl"><meta charset="utf-8"><style>:root {--ui-text-primary:#eee;--ui-text-secondary:#ccc;--ui-text-tertiary:#aaa;--ui-text-quaternary:#888;--ui-stroke-secondary:#444;--ui-red:#f88;--ui-yellow:#fc8;--ui-green:#8e9;--ui-bg-primary:#222;--ui-accent:#9af}body {margin:0;background:var(--ui-bg-primary);color:var(--ui-text-primary);font-family:Arial;font-size:14px;height:700px}button,select {font:inherit}</style>${html(page)}</html>`);
if (process.env.RESETWATCH_FIXTURE_HTML) console.log('Fixture HTML generated');
context.otherCards=[{id:'account:anthropic:other:Session',provider:'Claude',label:'Session',remaining:80,used:20,resetAt:null,detail:''}];
assert.equal(nodes(resolve(run('ProviderBlock({title:"Claude",cards:otherCards,nowMs:now})')),n=>n.props.role==='meter').length,1,'other provider quota cards are preserved');
(async()=>{
 const calls=[];
 host.request=async(method,params)=>{
  calls.push({method,params});
  if(method==='account.usage'||method==='slash.exec') throw new Error('unsafe OAuth resolver');
  if(method==='config.show') return {sections:[{rows:[['Config File','/fixture/hermes/config.yaml']]}]};
  if(method==='shell.exec') return {code:0,stdout:JSON.stringify(fixtures)};
  return {};
 };
 const result=await run('fetchLiveCards("",{disabled:["nous","openrouter"]},"","default")');
 const keys=new Set(result.cards.map(card=>card.accountKey));
 assert.equal(keys.size,7);
 assert.equal(calls.some(call=>['account.usage','slash.exec','usage.bars','subscription.state'].includes(call.method)),false);
 assert.ok(calls.filter(call=>call.method==='shell.exec').every(call=>call.params.command.includes('desktop-plugins/resetwatch-local/probe.py')&&call.params.command.includes('--disabled-providers=nous,openrouter')));
 assert.deepEqual(store.get('providers'),preferences);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(probePath)).digest('hex'),probeBefore);
 console.log('PASS provider isolation + read-only RPC: seven account identities retained; Nous/OpenRouter disabled; local probe only; no unsafe token resolver; other-provider rendering preserved');
})().catch(error=>{console.error(error);process.exitCode=1});
