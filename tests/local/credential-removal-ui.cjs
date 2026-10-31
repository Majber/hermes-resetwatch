// Subfixture of the ONE Python regression. Actual component/transport, mocked SDK.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../resetwatch-local/plugin.js'), 'utf8');
const code = source.slice(source.indexOf('async function prepareCredentialRemoval('), source.indexOf('function AccountOverviewRow('));
const key = 'a'.repeat(20), revision = 'b'.repeat(64);
const build = /const LOCAL_BUILD = '([^']+)'/.exec(source)[1];
const entries = [{id:'ab12cd34',source:'manual',state:'ready'},{id:'bc23de45',source:'manual',state:'expired'}];
const calls = [], states = [];
let cursor = 0, refreshed = 0, partial = false;
const context = {
  LOCAL_BUILD: build, text: {primary:'inherit',red:'var(--ui-red)'}, SmallButton: 'button',
  jsx: (type, props) => ({type,props}), jsxs: (type, props) => ({type,props}),
  useState: value => { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => {states[i] = typeof next === 'function' ? next(states[i]) : next}]; },
  useRef: value => { const i = cursor++; if (!(i in states)) states[i] = {current:value}; return states[i]; },
  snapshotAccountLabel: snap => snap.account_label,
  hermesHomeFromConfig: () => '/synthetic/home', hermesHomeCandidates: () => ['/synthetic/home'],
  shellSafe: () => true, probePythonCandidates: () => ['python3'], quoteShell: value => JSON.stringify(value),
  host: {notify: () => {}},
  profileRequester: async () => ({profile:'default',request:async (method, params) => {
    if (method === 'config.show') return {};
    calls.push(params.command);
    return {code:0,stdout:JSON.stringify(params.command.includes('--credential-plan=')
      ? {local_build:build,account_key:key,revision,entries,all_allowed:true}
      : {local_build:build,ok:!partial,partial,removed_ids:partial ? ['ab12cd34'] : ['ab12cd34','bc23de45']})};
  }})
};
vm.createContext(context); vm.runInContext(code, context);
const props = {accountKey:`openai-codex:${key}`,alias:'Synthetic work',snap:{account_label:'fixture@example.invalid'},removalContext:{connectionId:'fixture',profile:'default',sessionId:'synthetic',onRefresh:async()=>refreshed++}};
const render = () => { cursor=0; return context.CredentialRemoval(props); };
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];
const button = (tree,label) => nodes(tree).find(n=>n.type==='button' && n.props.children===label);
(async()=>{
 let tree=render(); assert.equal(calls.length,0,'poll/render is read-only');
 await button(tree,'Usuń z puli Hermesa').props.onClick(); tree=render();
 assert.ok(nodes(tree).some(n=>n.props?.role==='alertdialog'));
 const content=JSON.stringify(tree); assert.match(content,/Synthetic work/); assert.match(content,/fixture@example.invalid/); assert.match(content,/NIE usuwa konta OpenAI ani subskrypcji/); assert.match(content,/nieodwracalne/);
 assert.ok(nodes(tree).some(n=>n.type==='li'&&n.props.children.includes('ab12cd34')));
 button(tree,'Anuluj').props.onClick(); tree=render();
 assert.ok(!nodes(tree).some(n=>n.props?.role==='alertdialog'));
 assert.equal(calls.filter(c=>c.includes('--credential-remove=')).length,0); assert.equal(refreshed,0);
 await button(tree,'Usuń z puli Hermesa').props.onClick(); tree=render();
 nodes(tree).find(n=>n.type==='select').props.onChange({target:{value:'all'}}); tree=render();
 assert.equal(nodes(tree).filter(n=>n.type==='li').length,2,'confirmation lists exact selected rows');
 await button(tree,'Potwierdzam — usuń zapisane poświadczenia').props.onClick(); tree=render();
 const mutations=calls.filter(c=>c.includes('--credential-remove='));
 assert.equal(mutations.length,1); assert.ok(mutations[0].includes('--credential-ids=ab12cd34,bc23de45')); assert.ok(mutations[0].includes(`--credential-revision=${revision}`));
 assert.equal(refreshed,1); assert.match(JSON.stringify(tree),/potwierdzono odczytem/);
 partial=true; await button(tree,'Usuń z puli Hermesa').props.onClick(); tree=render();
 nodes(tree).find(n=>n.type==='select').props.onChange({target:{value:'all'}}); tree=render();
 await button(tree,'Potwierdzam — usuń zapisane poświadczenia').props.onClick(); tree=render();
 assert.match(JSON.stringify(tree),/Częściowe usunięcie: 1\/2/); assert.equal(refreshed,2);
 console.log('UI subfixture PASS: confirmation, cancel/no mutation, exact IDs, all selector, partial failure, roster refresh');
})().catch(error=>{console.error(error);process.exitCode=1});
