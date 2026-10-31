// Subfixture of the ONE focused Python regression; no Electron/login/network.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../resetwatch-local/plugin.js'), 'utf8');
const code = source.slice(source.indexOf('async function prepareBankedReset('), source.indexOf('function AccountOverviewRow('));
const build = /const LOCAL_BUILD = '([^']+)'/.exec(source)[1], key = 'a'.repeat(20);
const states = [], calls = []; let cursor = 0, mode = 'success', refreshed = 0, applicable = 1;
const windows = [{label:'Session',used_percent:80,reset_at:'2033-01-01T00:00:00Z'},{label:'Weekly',used_percent:100,reset_at:'2033-01-02T00:00:00Z'}];
const send = async (method, params) => {
  if (method === 'config.show') return {};
  calls.push(params.command);
  if (params.command.includes('--reset-prepare=')) return {code:0,stdout:JSON.stringify({local_build:build,account_key:key,identity:'fi**@example.invalid',plan_token:applicable ? 'b'.repeat(64) : null,expires_at:Date.now()/1000+120,observed_at:Date.now()/1000,available_count:2,applicable_available_count:applicable,windows,credits:[{id:'earliest',title:'First',expires_at:'2099-01-01T00:00:00Z'},{id:'later',title:'Second',expires_at:'2099-02-01T00:00:00Z'}],reason:applicable ? '' : 'OpenAI zgłasza 0 resetów do użycia teraz.'})};
  if (mode === 'timeout') throw new Error('timeout');
  return {code:0,stdout:JSON.stringify({local_build:build,ok:true,uncertain:false,reason:mode==='read_failure'?'reset_confirmed_refresh_unavailable':'reset_confirmed',message:mode==='read_failure'?'Reset potwierdzony przez OpenAI: serwer potwierdził zużycie resetu. Odświeżenie limitów niedostępne.':'Reset potwierdzony przez OpenAI: 2 okna. Zużycie resetu potwierdzone odpowiedzią serwera.',windows_reset:2,after:mode==='read_failure'?null:{available_count:1,applicable_available_count:0,observed_at:Date.now()/1000,windows}})};
};
const context = {LOCAL_BUILD:build, SmallButton:'button', text:{primary:'inherit'},
  jsx:(type,props)=>({type,props}), jsxs:(type,props)=>({type,props}),
  useState:value=>{const i=cursor++; if (!(i in states)) states[i]=value; return [states[i], next=>{states[i]=typeof next==='function'?next(states[i]):next}];},
  useRef:value=>{const i=cursor++; if (!(i in states)) states[i]={current:value}; return states[i];}, useEffect:()=>{},
  hermesHomeFromConfig:()=>'/synthetic/home',hermesHomeCandidates:()=>['/synthetic/home'],shellSafe:()=>true,probePythonCandidates:()=>['python3'],quoteShell:JSON.stringify,
  profileRequester:async()=>({profile:'default',request:send,requestOnce:send})};
vm.createContext(context); vm.runInContext(code,context);
const props={accountKey:`openai-codex:${key}`,alias:'Synthetic work',removalContext:{connectionId:'fixture',profile:'default',sessionId:'synthetic',onRefresh:async()=>refreshed++}};
const render=()=>{cursor=0;return context.BankedResetAction(props)};
const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&n.props.children===label);
const final='Potwierdzam — nieodwracalnie użyj wybranego resetu';
(async()=>{
 let tree=render(); assert.equal(calls.length,0,'render/poll never prepares or mutates');
 await button(tree,'Użyj banked reset').props.onClick(); tree=render();
 assert.equal(calls.filter(c=>c.includes('--reset-redeem=')).length,0);
 assert.equal(nodes(tree).find(n=>n.type==='select').props.value,0);
 assert.equal(button(tree,final).props.disabled,true);
 const content=JSON.stringify(tree); for (const text of ['Synthetic work','fi**@example.invalid','Session:','Weekly:','nieodwracalne','7 dni','earliest']) assert.ok(content.includes(text),text);
 button(tree,'Anuluj').props.onClick(); tree=render(); assert.equal(calls.filter(c=>c.includes('--reset-redeem=')).length,0);
 await button(tree,'Użyj banked reset').props.onClick(); tree=render();
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}}); tree=render();
 nodes(tree).find(n=>n.type==='select').props.onChange({target:{value:'1'}}); tree=render(); assert.equal(button(tree,final).props.disabled,true,'changing exact credit clears consent');
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}}); tree=render();
 const submit=button(tree,final).props.onClick; await Promise.all([submit(),submit()]); tree=render();
 const posts=calls.filter(c=>c.includes('--reset-redeem=')); assert.equal(posts.length,1); assert.match(posts[0],/--reset-choice=1 --confirm-irreversible/); assert.equal(refreshed,1); assert.match(JSON.stringify(tree),/Reset potwierdzony/); assert.ok(nodes(tree).some(n=>n.props?.['data-reset-readback']));
 assert.doesNotMatch(JSON.stringify(tree),/status redeemed w GET/);
 mode='read_failure'; await button(tree,'Przygotuj ponownie (tylko odczyt)').props.onClick(); tree=render();
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}}); tree=render(); await button(tree,final).props.onClick(); tree=render();
 assert.match(JSON.stringify(tree),/Reset potwierdzony/); assert.match(JSON.stringify(tree),/Odświeżenie limitów niedostępne/); assert.doesNotMatch(JSON.stringify(tree),/Wynik niepewny/); assert.ok(!nodes(tree).some(n=>n.props?.['data-reset-readback']));
 mode='timeout'; await button(tree,'Przygotuj ponownie (tylko odczyt)').props.onClick(); tree=render();
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}}); tree=render(); await button(tree,final).props.onClick(); tree=render();
 assert.match(JSON.stringify(tree),/Wynik niepewny/); assert.equal(button(tree,final),undefined); assert.equal(calls.filter(c=>c.includes('--reset-redeem=')).length,3);
 applicable=0; await button(tree,'Przygotuj ponownie (tylko odczyt)').props.onClick(); tree=render(); assert.equal(button(tree,final),undefined); assert.match(JSON.stringify(tree),/0 resetów/);
 // The real routing adapter must not retry even a schema rejection for requestOnce.
 let tries=0;
 const routeContext={host:{request:async()=>{tries++;throw new Error('session_id extra inputs are not permitted')}}};
 vm.createContext(routeContext); vm.runInContext(source.slice(source.indexOf('async function profileRequester('),source.indexOf('// shell.exec returns only')),routeContext);
 const routed=await routeContext.profileRequester('', 'default','synthetic');
 await assert.rejects(routed.requestOnce('shell.exec',{command:'synthetic-no-execution'})); assert.equal(tries,1);
 console.log('UI subfixture PASS: read-only prepare/cancel, masked account, earliest default, exact selection, consent, single execute, no retry, timeout lockout, fresh 0 disabled');
})().catch(error=>{console.error(error);process.exitCode=1});
