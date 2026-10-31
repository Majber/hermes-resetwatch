// ONE focused offline regression: real plugin component, synthetic SDK only.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../../resetwatch-local/plugin.js'), 'utf8');
assert.ok(source.includes('function assistedCodexCommand('), 'assisted add flow is missing');
assert.match(source, /jsx\(AssistedCodexAdd, \{/,'form must be mounted by the page');
const code = source.slice(source.indexOf('function assistedCodexCommand('), source.indexOf('async function prepareCredentialRemoval('));
const states = [], effects = [], calls = [], copied = [];
let cursor = 0, refreshed = 0, clipboardOK = true, deferResolve = null;
const owner = {connectionId:'fixture',profile:'worker'};
const get = value => ({get:()=>value});
const context = {
  text:{primary:'inherit',secondary:'inherit',tertiary:'inherit',red:'inherit'},
  SmallButton:'button', ALIAS_MAX_LENGTH:80, nativeSelectStyle:{}, nativeOptionStyle:{},
  jsx:(type,props)=>({type,props}), jsxs:(type,props)=>({type,props}),
  useState:value=>{const i=cursor++; if(!(i in states))states[i]=value; return [states[i],next=>{states[i]=typeof next==='function'?next(states[i]):next}];},
  useRef:value=>{const i=cursor++; if(!(i in states))states[i]={current:value};return states[i];},
  useEffect:fn=>{if(!effects.length)effects.push(fn());},
  host:{state:{focusedSessionOwner:{get:()=>owner}, focusedSessionId:get('session'),connectionId:get('fixture'),profile:get('worker')}},
  profileRequester:async (...args)=>{calls.push(args); if(deferResolve)await new Promise(resolve=>{deferResolve=resolve});return {profile:'target-worker'};},
  os:{writeClipboard:async text=>{copied.push(text);return clipboardOK;}}
};
vm.createContext(context);vm.runInContext(code,context);
const props={connectionId:'fixture',profile:'worker',sessionId:'session',blocked:false,onRefresh:async()=>refreshed++};
const render=()=>{cursor=0;return context.AssistedCodexAdd(props)};
const nodes=t=>!t||typeof t!=='object'?[]:[t,...[t.props?.children].flat(Infinity).flatMap(nodes)];
const button=(t,label)=>{const found=nodes(t).find(n=>n.type==='button'&&n.props.children===label);assert.ok(found,`button ${label}`);return found};
const field=(t,label)=>nodes(t).find(n=>n.props?.['aria-label']===label);
(async()=>{
 assert.throws(()=>context.assistedCodexCommand({profile:'../other',label:'',shell:'sh'}));
 assert.throws(()=>context.assistedCodexCommand({profile:'worker',label:'bad\ncommand',shell:'sh'}));
 assert.throws(()=>context.assistedCodexCommand({profile:'worker',label:'x',shell:'cmd'}));
 const label="-- praca ' $(printf unsafe); `id` %PATH% & < >";
 const cmd=context.assistedCodexCommand({profile:'worker',label,shell:'sh'});
 // Parse only with a dummy shell function: NEVER invoke Hermes or any login.
 const parsed=spawnSync('sh',['-c',`hermes() { printf '%s\\n' "$@"; }; ${cmd}`],{encoding:'utf8'});
 assert.equal(parsed.status,0);assert.deepEqual(parsed.stdout.trimEnd().split('\n'),['--profile','worker','auth','add','openai-codex','--type','oauth',`--label=${label}`]);
 assert.match(context.assistedCodexCommand({profile:'worker',label:"O'Brien",shell:'powershell'}),/--label='O''Brien'/);
 assert.ok(!context.assistedCodexCommand({profile:'worker',label:' ',shell:'sh'}).includes('--label'));
 let tree=render();assert.equal(calls.length,0);assert.equal(copied.length,0);assert.equal(refreshed,0);
 assert.ok(!tree.props.open,'collapsed by default');
 assert.match(JSON.stringify(tree),/Tryb wspomagany/);assert.match(JSON.stringify(tree),/nie potwierdza/);
 field(tree,'Nazwa konta Codex (opcjonalna)').props.onChange({target:{value:label}});tree=render();
 const form=nodes(tree).find(n=>n.type==='form');await form.props.onSubmit({preventDefault(){}});tree=render();
 assert.equal(calls.length,1);const command=field(tree,'Polecenie logowania Codex').props.value;
 assert.match(command,/target-worker/);assert.match(command,/auth add openai-codex --type oauth/);
 assert.equal(copied.length,0,'preparation does not copy or launch');
 assert.equal(context.os.openExternal,undefined,'no hidden browser flow');
 await button(tree,'Kopiuj polecenie').props.onClick();tree=render();assert.equal(copied[0],command);
 assert.match(JSON.stringify(tree),/Nie uruchomiono logowania/);
 clipboardOK=false;await button(tree,'Kopiuj polecenie').props.onClick();tree=render();assert.match(JSON.stringify(tree),/Schowek niedostępny/);
 await button(tree,'Odśwież listę po logowaniu').props.onClick();tree=render();assert.equal(refreshed,1);assert.match(JSON.stringify(tree),/Nie potwierdza dodania konta/);
 owner.profile='other';await button(tree,'Kopiuj polecenie').props.onClick();await button(tree,'Odśwież listę po logowaniu').props.onClick();assert.equal(copied.length,2);assert.equal(refreshed,1);owner.profile='worker';
 // Closing invalidates pending preparation, and a second submit is guarded.
 deferResolve=true;const first=nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 await nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.equal(calls.length,2);
 const close=render();close.props.onToggle({currentTarget:{open:false}});deferResolve();await first;tree=render();assert.equal(field(tree,'Polecenie logowania Codex'),undefined);
 assert.ok(source.includes('function CredentialRemoval('));assert.ok(source.includes('function AccountAliasEditor('));
 assert.ok(!code.includes('shell.exec')&&!code.includes('storage.set')&&!code.includes('host.notify')&&!code.includes('setInterval'));
 console.log('PASS: assisted Codex add; exact shell-safe argv, optional label, scoped profile, copy/failure, refresh, focus guard, close/race, no auth/network/storage calls');
})().catch(error=>{console.error(error);process.exitCode=1});
