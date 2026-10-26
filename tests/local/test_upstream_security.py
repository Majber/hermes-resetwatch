"""One offline regression for the deliberately adopted upstream fixes."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class UpstreamSecurity(unittest.TestCase):
    def test_offline_security_and_identity_compatibility(self):
        # Node only evaluates plugin helpers; shell.exec is a recording mock.
        script = r'''
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync('resetwatch-local/plugin.js', 'utf8');
const code = source.slice(source.indexOf('function hermesHomeFromConfig('), source.indexOf('function go('));
const ctx = {host:{}, normalizeProviderPreferences:()=>({disabled:[]}), errorMessage:e=>e.message};
vm.createContext(ctx); vm.runInContext(code, ctx);
(async()=>{
 for (const home of ['/srv/$(touch pwned)/hermes', '/srv/`id`', '/srv/a"b', 'C:/100%HOME%', 'C:/x!PATH!', '/srv/$HOME', '/srv/a\nb', '/srv/a\rb', '$HERMES_PYTHON']) {
  const calls = [];
  const result = await ctx.probeStockAccountUsage(async(method, params)=>{
   calls.push(method); assert.equal(method, 'config.show', 'unsafe home must never run shell.exec');
   return {sections:[{rows:[['Config File', home+'/config.yaml']]}]};
  }, {});
  assert.match(result.error, /[Nn]iebezpieczna|would expand/); assert.deepEqual(calls,['config.show']);
 }
 for (const bad of ['/srv/a"b','/srv/`id`','/srv/$HOME','C:/100%HOME%','C:/x!PATH!']) assert.throws(()=>ctx.quoteShell(bad));
 for (const literal of [String.raw`C:\Users\me\Hermes Agent\.venv\Scripts\python.exe`, '/srv/Hermes Agent/python', '/srv/a;&(b)']) assert.equal(ctx.quoteShell(literal), '"'+literal+'"');
 for (const home of ['/srv/Hermes Agent', String.raw`C:\Users\me\Hermes Agent`]) {
  const commands=[];
  await ctx.probeStockAccountUsage(async(method,p)=>method==='config.show' ? {sections:[{rows:[['Config File',home+'/config.yaml']]}]} : (commands.push(p.command), {code:127,stderr:'not found'}), {});
  const runtime=home.startsWith('C:')?'%HERMES_PYTHON%':'$HERMES_PYTHON';
  assert.ok(commands.some(command=>command.startsWith('"'+runtime+'" "'+home+'/desktop-plugins/resetwatch-local/probe.py"')));
 }
 for (const message of ['invalid_params: session_id: extra_forbidden', 'invalid params: session_id: Extra inputs are not permitted', 'Invalid parameters: unexpected field session_id', 'invalid params: extra field session_id', 'extra field session_id']) {
  const calls=[]; ctx.host.request=async(m,p)=>{calls.push({...p});if ('session_id' in p) throw Error(message);return {code:0};};
  const runner=await ctx.profileRequester('','','fixture');
  await runner.request('shell.exec',{command:'fixture'}); await runner.request('shell.exec',{command:'page2'});
  assert.equal(calls.length,3); assert.equal(calls[0].session_id,'fixture'); assert.ok(!('session_id' in calls[1])); assert.ok(!('session_id' in calls[2]));
 }
 for (const message of ['timeout', 'permission denied', 'invalid parameters: model required', 'invalid params: session_id required', 'session_id: command timeout', 'session_id: extra field; timeout']) {
  let count=0; ctx.host.request=async()=>{count++;throw Error(message);};
  await assert.rejects((await ctx.profileRequester('','','fixture')).request('shell.exec',{command:'fixture'})); assert.equal(count,1,message);
 }
 for (const message of ['Invalid parameters: session_id required', 'extra field command']) {
  ctx.host.request=async()=>{throw Error(message);};
  const result=await ctx.probeStockAccountUsage(async(m,p)=>m==='config.show'?{sections:[{rows:[['Config File','/srv/hermes/config.yaml']]}]}:(await ctx.profileRequester('','','')).request(m,p),{});
  assert.match(result.error,/Odmowa shell.exec/);
 }
 console.log('shell fixtures OK: injection/no command, literals/runtime tokens, explicit schema only');
})().catch(e=>{console.error(e);process.exitCode=1;});
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        spec = importlib.util.spec_from_file_location('local_security_probe', ROOT / 'resetwatch-local/probe.py')
        assert spec is not None and spec.loader is not None
        rw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(rw)
        import httpx
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.dict(os.environ, {}, clear=True), \
                 patch.object(rw, '_user_home', return_value=home), \
                 patch.object(rw, '_hermes_homes', return_value=[home / '.hermes']), \
                 patch.object(rw, '_codex_home', return_value=home / '.codex'), \
                 patch.object(rw, '_resetwatch_cache_dir', return_value=home / 'cache'), \
                 patch.object(rw, '_S6_ENV_DIR', home / 'container-environment'), \
                 patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')), \
                 patch.object(subprocess, 'run', side_effect=AssertionError('subprocess forbidden')), \
                 patch.object(rw, '_grok_access_context', return_value=('synthetic-token', 'fixture-user')), \
                 patch.object(rw, '_grok_client_version', return_value='fixture'):
                rejected = ['https://attacker.invalid/v1', 'http://grok.com/v1', 'https://grok.com.attacker.invalid/v1', 'https://evilgrok.com/v1', 'https://user:pw@grok.com/v1', 'https://@grok.com/v1', 'https://grok.com:8443/v1', 'https://grok.com:bad/v1', 'https://[::1/v1']
                accepted = ['https://grok.com/v1', 'https://staging.grok.com/v1/', 'https://proxy.x.ai/v1', 'https://x.ai:443/v1']
                for override in rejected + accepted:
                    seen = []
                    def respond(request):
                        seen.append(request.url)
                        self.assertEqual(request.headers['Authorization'], 'Bearer synthetic-token')
                        return httpx.Response(200, json={})
                    client = httpx.Client(transport=httpx.MockTransport(respond))
                    self.addCleanup(client.close)
                    with patch.dict(os.environ, {'GROK_CLI_CHAT_PROXY_BASE_URL': override}), \
                         patch.object(httpx, 'Client', return_value=client):
                        rw._fetch_grok_account_usage()
                    expected = httpx.URL(override).host if override in accepted else 'cli-chat-proxy.grok.com'
                    self.assertTrue(seen)
                    self.assertEqual({url.host for url in seen}, {expected})
                    self.assertTrue(all(url.scheme == 'https' and url.port in (None, 443) for url in seen))
                def grant(subject, suffix):
                    claims = {'sub':subject, 'exp':4102444800, 'https://api.openai.com/auth':{'chatgpt_account_id':'workspace'}, 'email':'fixture@example.invalid'}
                    token = 'eyJ.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.' + suffix
                    return {'id':suffix, 'access_token':token}
                a, a2, b = grant('member-a','a'), grant('member-a','a2'), grant('member-b','b')
                with patch.object(rw, '_read_codex_cli_auth', return_value=None), patch.object(rw, '_codex_pool_entries', return_value=[a,a2]) as inventory:
                    single = rw._codex_pool_accounts()
                    legacy = hashlib.sha256(('chatgpt.com\0workspace').encode()).hexdigest()[:20]
                    self.assertEqual(len(single),1)
                    self.assertEqual(single[0]['key'],legacy,'unique subject retains every existing alias/cache key')
                    self.assertEqual(len(single[0]['candidates']),2)
                    inventory.return_value=[a,a2,b]
                    split=rw._codex_pool_accounts()
                    self.assertEqual(len(split),2,'distinct workspace members must not share quota')
                    keys={item['key'] for item in split}
                    self.assertEqual(len(keys),2)
                    self.assertNotIn(legacy,keys,'ambiguous historical quota/alias must not be assigned to another member')
                    inventory.return_value=[b,a2,a]
                    self.assertEqual({item['key'] for item in rw._codex_pool_accounts()},keys,'collision identities are independent of inventory order')
        print('PASS one offline regression: shell safety/schema, Grok destinations, stable noncollision identities and subject separation')


if __name__ == '__main__':
    unittest.main()
