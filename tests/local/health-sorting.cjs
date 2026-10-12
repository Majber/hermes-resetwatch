// Synthetic SDK fixture checks only: no browser, network or real credentials.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../../resetwatch-local/plugin.js'), 'utf8').replace(/^import .*$/gm, '').replace('export default {', 'globalThis.plugin = {');
const atom = value => ({ get: () => value, set: next => value = next });
const jsx = (type, props, key) => ({ type, props, key });
const store = new Map([['providers', {disabled:['nous','openrouter'],order:['openai-codex']}], ['display_mode','used'], ['account_aliases', {'openai-codex:high':'My alias'}]]);
let rejectWrites = false;
const writes = [];
const host = {state:{gateway:atom('idle'),focusedSessionId:atom(''),connectionId:atom('local'),profile:atom('default')}, request:()=>{throw Error('network forbidden')}};
const context = vm.createContext({console,Date,Math,Set,Map,JSON,Number,String,Boolean,Promise,Error,RegExp,sdk:{atom,host,useValue:a=>a.get(),useQuery:()=>({data:{cards:[],errors:[]}}),ROUTES_AREA:'routes',SIDEBAR_NAV_AREA:'nav',PALETTE_AREA:'palette'},Fragment:'fragment',jsx,jsxs:jsx,useEffect:()=>{},useMemo:f=>f(),useRef:v=>({current:v}),useState:v=>[typeof v==='function'?v():v,()=>{}],setInterval:()=>0,clearInterval:()=>{},setTimeout:()=>0,clearTimeout:()=>{}});
vm.runInContext(source,context);
const run = expression => vm.runInContext(expression,context);
context.ctx = {storage:{get:(key,fallback)=>store.has(key)?structuredClone(store.get(key)):fallback,set:(key,value)=>{writes.push(key);if(!rejectWrites)store.set(key,structuredClone(value));}},registerMany:()=>{},onDispose:()=>{}};
run('plugin.register(ctx)');
const now = Date.parse('2026-10-12T12:00:00Z');
const fixture = (key, remaining, overrides={}) => ({provider:'openai-codex', account_key:key, account_label:`${key}@example.invalid`, account_status:'verified', credential_status:'ready', quota_state:'available', allowed:true, fetched_at:(now-60000)/1000, windows:[{label:'Session',remaining_percent:remaining,used_percent:100-remaining,reset_at:new Date(now+3600000).toISOString()},{label:'Weekly',remaining_percent:50,used_percent:50,reset_at:new Date(now+7200000).toISOString()}],...overrides});
context.now=now;
context.snap=fixture('stale',90,{fetched_at:(now-900000)/1000});
assert.equal(run('deriveAccountStatus(snap,now).auth'),'verified','stale quota must not obscure a previously accepted credential');
assert.equal(run('deriveAccountStatus(snap,now).freshness'),'stale');
assert.equal(run('deriveAccountStatus(snap,now).availability'),'unknown');
for (const [auth, freshness, overrides] of [
 ['expired','historical',{account_status:'expired',credential_status:'expired'}],
 ['auth_required','historical',{account_status:'auth_required'}],
 ['rate_limited','historical',{account_status:'rate_limited'}],
 ['verified','pending',{windows:[{label:'Session',remaining_percent:0,used_percent:100,reset_at:new Date(now-1).toISOString()}]}],
 ['verified','unknown',{fetched_at:null}],
 ['verified','unknown',{fetched_at:(now+120000)/1000}],
 ['verified','fresh',{cache_hit:true}],
 ['unknown','historical',{account_status:'unknown'}]
]) {
 context.snap=fixture('case',80,overrides);
 assert.equal(run('deriveAccountStatus(snap,now).auth'),auth);
 assert.equal(run('deriveAccountStatus(snap,now).freshness'),freshness);
 if(freshness!=='fresh') assert.equal(run('deriveAccountStatus(snap,now).availability'),'unknown');
}
context.snap=fixture('extra',80,{windows:[{label:'Session',used_percent:20,reset_at:new Date(now+3600000).toISOString()},{label:'Spark Weekly',used_percent:100,reset_at:new Date(now-1).toISOString()}]});
assert.equal(run('deriveAccountStatus(snap,now).availability'),'available','model-specific buckets never block main quota');
console.log('PASS separate auth, freshness and live availability; expiry/401/429/history/cache/future timestamp/extra buckets');
function resolve(element) {
 if(element==null||typeof element==='boolean') return null;
 if(Array.isArray(element)) return element.map(resolve);
 if(typeof element!=='object') return String(element);
 if(typeof element.type==='function') return resolve(element.type(element.props));
 return {...element,props:{...element.props,children:resolve(element.props?.children)}};
}
function nodes(element,predicate) {
 if(Array.isArray(element)) return element.flatMap(item=>nodes(item,predicate));
 if(!element||typeof element!=='object') return [];
 return [...(predicate(element)?[element]:[]),...nodes(element.props.children,predicate)];
}
function textOf(element) { return Array.isArray(element)?element.map(textOf).join(' '):element&&typeof element==='object'?textOf(element.props.children):element||''; }
context.snap=fixture('high',90,{fetched_at:(now-900000)/1000});
let row=resolve(run('AccountOverviewRow({snap,nowMs:now,accountKey:"openai-codex:high"})'));
assert.match(textOf(nodes(row,n=>n.props['data-auth-health'])[0]),/Auth: API accepted/);
assert.match(textOf(nodes(row,n=>n.props['data-quota-freshness'])[0]),/Quota: Stale/);
assert.equal(nodes(row,n=>n.type==='td').length,4,'no additional columns');
assert.match(textOf(row),/My alias/);
context.entries=[fixture('low',10),fixture('high',90),fixture('tie',90),fixture('old',100,{fetched_at:(now-900000)/1000}),fixture('unknown',99,{quota_state:'unknown',allowed:null}),fixture('invalid',80,{windows:[]})].map(s=>[s.account_key,{snap:s}]);
const ids = (key,direction='desc') => Array.from(run(`sortAccounts(entries,{key:${JSON.stringify(key)},direction:${JSON.stringify(direction)}},now)`),e=>e[0]);
assert.deepEqual(ids('default'),['low','high','tie','old','unknown','invalid']);
assert.deepEqual(ids('session'),['high','tie','low','old','unknown','invalid']);
assert.deepEqual(ids('session','asc'),['low','high','tie','old','unknown','invalid']);
assert.deepEqual(ids('weekly'),['low','high','tie','old','unknown','invalid']);
assert.deepEqual(ids('state','asc'),['low','high','tie','invalid','old','unknown']);
assert.deepEqual(ids('state','desc'),['unknown','old','low','high','tie','invalid']);
context.entries[0][1].snap.windows[0].reset_at=new Date(now+500000).toISOString();
context.entries[1][1].snap.windows.push({label:'Spark Session',reset_at:new Date(now+1000).toISOString()});
context.entries[2][1].snap.windows[0].reset_at='invalid';
assert.deepEqual(ids('reset','asc'),['low','high','tie','old','unknown','invalid']);
assert.deepEqual(ids('reset','desc'),['tie','high','low','old','unknown','invalid']);
context.entries[0][1].snap.windows[0].reset_at=new Date(now-1).toISOString();
assert.equal(ids('session').indexOf('low')>ids('session').indexOf('tie'),true,'elapsed quota becomes unknown, never replenished');
assert.equal(new Set(ids('reset')).size,6,'sorting never hides accounts');
const sortedTable=resolve(run('AccountOverviewTable({accounts:new Map(entries),nowMs:now,accountSort:{key:"session",direction:"desc"}})'));
assert.deepEqual(nodes(sortedTable,n=>n.props['data-account-row']).map(n=>n.props['data-account-row']),ids('session'),'visible row order follows the selected sort');
assert.equal(nodes(sortedTable,n=>n.type==='th').length,4);
context.snap=fixture('limited',0,{quota_state:'limit_reached',allowed:false});
row=resolve(run('AccountOverviewRow({snap,nowMs:now,accountKey:"limited"})'));
assert.match(textOf(nodes(row,n=>n.props['data-auth-health'])[0]),/API accepted/,'exhaustion must not appear as an auth failure');
assert.match(textOf(nodes(row,n=>n.props['data-quota-freshness'])[0]),/Fresh.*Limit reached/);
context.snap=fixture('banked',90,{account_status:'expired',credential_status:'expired',rate_limit_reset_credits:{available_count:5,applicable_available_count:2}});
row=resolve(run('AccountOverviewRow({snap,nowMs:now,accountKey:"banked"})'));
assert.match(textOf(row),/Banked: 5.*usable now: 2.*hist\./,'banked/applicable counts and historical marker survive the new health labels');
assert.doesNotMatch(textOf(nodes(row,n=>n.props['data-auth-health'])[0]),/grant|Sign in again/,'access-token expiry does not imply revoked grant');
console.log('PASS local sort: default source order, remaining independent of used mode, stable ties, history/unknown last, future main resets only');
assert.deepEqual(writes,[],'read/render do not write preferences');
assert.equal(run('saveAccountSort("local","default",{key:"session",direction:"desc"})'),true);
run('plugin.register(ctx)');
assert.equal(run('accountSortFor("local","default").key'),'session');
assert.equal(run('accountSortFor("remote","default").key'),'default');
assert.equal(run('accountSortFor("local","other").key'),'default');
assert.equal(run('saveAccountSort("local","other",{key:"reset",direction:"asc"})'),true);
assert.equal(run('accountSortFor("local","default").key'),'session');
rejectWrites=true;
assert.equal(run('saveAccountSort("local","default",{key:"weekly",direction:"asc"})'),false);
assert.equal(run('accountSortFor("local","default").key'),'session');
assert.equal(run('saveAccountSort(null,"default",{key:"state"})'),false,'unresolved owner cannot persist');
assert.equal(run('normalizeAccountSort({key:"invalid",direction:"bad"}).key'),'default');
assert.deepEqual(store.get('providers'),{disabled:['nous','openrouter'],order:['openai-codex']});
assert.equal(store.get('display_mode'),'used');
assert.equal(store.get('account_aliases')['openai-codex:high'],'My alias');
rejectWrites=false;
const controls=resolve(run('AccountSortControls({connectionId:"local",profile:"default"})'));
nodes(controls,n=>n.type==='select')[0].props.onChange({target:{value:'weekly'}});
assert.equal(run('accountSortFor("local","default").key'),'weekly');
const controls2=resolve(run('AccountSortControls({connectionId:"local",profile:"default"})'));
nodes(controls2,n=>n.type==='button')[0].props.onClick();
assert.equal(run('accountSortFor("local","default").direction'),'asc');
console.log('PASS select/direction handlers, reload, connection/profile isolation, failed-write readback, preserved aliases/providers/mode');
