"""One bounded offline regression: no real homes, credentials or vendor I/O."""
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which('node')  # Resolve before fixture isolation clears PATH.
assert NODE is not None, 'Node is required for the offline UI fixture'
spec = importlib.util.spec_from_file_location('reset_refresh_probe', ROOT / 'resetwatch-local/probe.py')
assert spec is not None and spec.loader is not None
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)

class ResetRefresh(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        guards = [patch.dict(os.environ, {}, clear=True),
                  patch.object(rw, '_resetwatch_cache_dir', return_value=self.home),
                  patch.object(rw, '_user_home', return_value=self.home),
                  patch.object(rw, '_hermes_homes', return_value=[self.home]),
                  patch.object(rw, '_codex_home', return_value=self.home),
                  patch.object(rw, '_S6_ENV_DIR', self.home / 'container'),
                  patch.object(rw, '_inventory_fingerprint', return_value='fixture-inventory'),
                  patch.object(rw, '_seconds_left', return_value=30),
                  patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden'))]
        for guard in guards:
            guard.start()
            self.addCleanup(guard.stop)
        self.accounts = [dict(key=c*20, label='fixture.invalid', account_id=c,
                              source_host='fixture.invalid', base_url=None,
                              credential_status='ready', grant_states={'ready':1},
                              candidates=[{'token':'synthetic-'+c, 'state':'ready', 'entry':{}}]) for c in 'ab']
        guard = patch.object(rw, '_codex_pool_accounts', return_value=self.accounts)
        guard.start()
        self.addCleanup(guard.stop)

    def test_exact_target_preserves_neighbors_and_floor_across_full_fetch(self):
        now = time.time()
        old = [dict(provider='openai-codex', account_key=c*20, fetched_at=now-120,
                    inspected_at=now-130, last_attempt_at=now-120, windows=[], account_status='verified') for c in 'ab']
        rw._store_probe_result_cache(old, cli_only=False)
        before = rw._read_json_file(rw._probe_result_cache_path(cli_only=False))
        def fetched(token, *args, **kwargs):
            return dict(provider='openai-codex', account_key=kwargs['account_key'], fetched_at=now, windows=[], details=[])
        with patch.object(rw, '_fetch_codex_usage', side_effect=fetched) as fetch:
            result = rw._refresh_codex_account('a'*20, cli_only=False)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(fetch.call_args.args[0], 'synthetic-a')
            self.assertEqual(len(result), 1)
            after = rw._read_json_file(rw._probe_result_cache_path(cli_only=False))
            self.assertEqual(after['snapshots'][1], before['snapshots'][1])
            self.assertEqual(after['fetched_at'], before['fetched_at'])
            self.assertEqual(after['inventory_fingerprint'], before['inventory_fingerprint'])
            again = rw._refresh_codex_account('a'*20, cli_only=False)[0]
            rw._codex_pool_fetcher(self.accounts[0])()
            self.assertEqual(fetch.call_count, 1, 'targeted and full refresh share a 60s account floor')
            self.assertEqual(again['fetched_at'], result[0]['fetched_at'])
            self.assertEqual(again['last_attempt_at'], result[0]['last_attempt_at'])

    def test_missing_invalid_and_status_only_are_explicit_without_fetch(self):
        with patch.object(rw, '_fetch_codex_usage', side_effect=AssertionError('must not fetch')):
            unknown = rw._refresh_codex_account('f'*20, cli_only=False)[0]
            self.assertEqual(unknown['account_status'], 'unknown')
            self.assertIsNone(unknown['fetched_at'])
            for key in ['bad', 'a'*20+';touch /bad', 'A'*20]:
                with self.assertRaises(ValueError):
                    rw._refresh_codex_account(key, cli_only=False)
            self.accounts[0]['credential_status'] = 'missing'
            self.accounts[0]['grant_states'] = {'missing':1}
            candidates = self.accounts[0]['candidates']
            assert isinstance(candidates, list)
            candidates[0]['state'] = 'missing'
            snap = rw._refresh_codex_account('a'*20, cli_only=False)[0]
            self.assertEqual(snap['account_status'], 'missing')
            self.assertIsNone(snap['fetched_at'])

    def test_cli_target_never_uses_bulk_collector(self):
        class Exit(Exception): pass
        output = io.StringIO()
        with patch.object(rw.sys, 'argv', ['probe.py','--account-key='+'a'*20,'--fresh']), \
             patch.object(rw.sys, 'stdout', output), \
             patch.object(rw.os, '_exit', side_effect=Exit), \
             patch.object(rw, '_collect_cli', side_effect=AssertionError('bulk forbidden')), \
             patch.object(rw, '_collect_hermes', side_effect=AssertionError('bulk forbidden')), \
             patch.object(rw, '_refresh_codex_account', return_value=[{'account_key':'a'*20}]) as fetch:
            with self.assertRaises(Exit): rw._main_inner()
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(json.loads(output.getvalue()), [{'account_key':'a'*20}])

    def test_ui_reset_planning_scope_and_target_merge(self):
        script = r"""
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const atom = value => ({get:()=>value,set:next=>{value=next}});
const sdk = {host:{state:{}},atom};
const context = vm.createContext({sdk, console, Date, setTimeout, clearTimeout,
  Fragment:'fragment', jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})});
const src = fs.readFileSync(process.argv[1], 'utf8').replace(/^import .*$/gm,'').replace('export default {','const plugin = {');
vm.runInContext(src+';globalThis.api={deriveAccountStatus,resetRefreshPlan,mergeAccountRefresh,fetchLiveCards};',context);
const {deriveAccountStatus:status, resetRefreshPlan:plan, mergeAccountRefresh:merge,fetchLiveCards:fetch} = context.api;
const now=1700000000000, iso=ms=>new Date(ms).toISOString();
const snap={provider:'openai-codex',account_key:'a'.repeat(20),account_status:'verified',credential_status:'ready',fetched_at:(now-10000)/1000,allowed:false,limit_reached:true,
windows:[{label:'Session',used_percent:100,reset_at:iso(now+120000)},{label:'Weekly',used_percent:100,reset_at:iso(now+240000)},{label:'Spark Weekly',used_percent:100,reset_at:iso(now+990000)}]};
let s=status(snap,now); assert.equal(s.blockScope,'both'); assert.equal(s.recoveryAt,now+240000);
s=status({...snap,windows:[snap.windows[0]]},now); assert.equal(s.blockScope,'session'); assert.equal(s.recoveryAt,now+120000);
s=status({...snap,windows:[snap.windows[1]]},now); assert.equal(s.blockScope,'weekly');
s=status({...snap,windows:[]},now); assert.equal(s.blockScope,'unknown'); assert.equal(s.recoveryAt,null);
s=status({...snap,windows:[{label:'Spark Weekly',used_percent:100,reset_at:iso(now+990000)}],limit_reached:false,allowed:true},now);assert.equal(s.availability,'available');assert.equal(s.recoveryAt,null);
s=status({...snap,windows:[snap.windows[0],{label:'Weekly',used_percent:100}]},now);assert.equal(s.recoveryAt,null);
const past={...snap,fetched_at:(now-120000)/1000,last_attempt_at:(now-10000)/1000,windows:[{label:'Session',used_percent:100,reset_at:iso(now-1000)}]};
const cards=[{snapshot:past,accountKey:'openai-codex:'+past.account_key}];
const attempted=new Set();let p=plan(cards,now,attempted,0);assert.equal(p.at,now+50000);assert.equal(p.keys.length,1);
p=plan([...cards,...cards],now+60000,attempted,0);assert.equal(p.keys.length,1);p.keys.forEach(k=>attempted.add(k));assert.equal(plan(cards,now+60000,attempted,0),null);
assert.equal(plan([{snapshot:{...past,fetched_at:(now+1000)/1000}}],now+60000,new Set(),0),null,'observation after reset never loops');
assert.equal(plan(cards,now,new Set(),now+90000).at,now+90000);
const other={id:'other',accountKey:'openai-codex:'+'b'.repeat(20),snapshot:{fetched_at:123,inspected_at:124}};
const key=cards[0].accountKey, next={cards:[{id:'new',accountKey:key,snapshot:snap}],errors:[]};
const merged=merge({cards:[...cards,other],errors:[]},next,key);assert.equal(merged.cards[1],other);assert.equal(merged.cards[1].snapshot.fetched_at,123);
(async()=>{const calls=[];sdk.host.request=async(method,params)=>{calls.push([method,params]); if(method==='config.show')return {sections:[{rows:[['Config File','/fixture/config.yaml']]}]};if(method==='shell.exec')return {code:0,stdout:JSON.stringify([{...snap}])};throw Error('unrelated RPC '+method)};
const data=await fetch('',{accountKey:key,fresh:true},'', '');assert.equal(data.cards[0].accountKey,key);assert.equal(calls.filter(c=>c[0]==='shell.exec').length,1);assert.ok(calls.find(c=>c[0]==='shell.exec')[1].command.includes('--account-key='+snap.account_key));
const before=calls.length;const bad=await fetch('',{accountKey:key+';evil'},'','');assert.ok(bad.errors.length);assert.equal(calls.length,before);
console.log('JS fixtures: reset floor/coalescing/no-loop; Session/Weekly/both/unknown; target command and neighbor identity preserved');})().catch(e=>{console.error(e);process.exitCode=1});
"""
        assert NODE is not None
        result = subprocess.run([NODE,'-e',script,str(ROOT / 'resetwatch-local/plugin.js')], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        print(result.stdout.strip())

if __name__ == '__main__':
    started = time.perf_counter()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ResetRefresh))
    print(f'Targeted offline result: {result.testsRun} tests; {time.perf_counter()-started:.3f}s')
    raise SystemExit(0 if result.wasSuccessful() else 1)
