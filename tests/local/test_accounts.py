import importlib.util
import os
import unittest
from unittest.mock import patch
from pathlib import Path
import json, base64, time

PATH = Path(__file__).resolve().parents[2] / 'resetwatch-local' / 'probe.py'
spec = importlib.util.spec_from_file_location('rw', PATH)
assert spec is not None and spec.loader is not None
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)

def jwt(account, exp=None):
    claims = {'https://api.openai.com/auth': {'chatgpt_account_id': account}, 'email': 'tester@example.invalid', 'exp': exp or time.time()+3600}
    return 'eyJ.' + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=') + '.fixture'

class Accounts(unittest.TestCase):
    def setUp(self):
        import tempfile
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        home = Path(directory.name) / 'fixture-home'
        home.mkdir()
        import httpx, socket
        guards = [
            patch.dict(os.environ, {}, clear=True),
            patch.object(rw, '_resetwatch_cache_dir', return_value=home / 'cache'),
            patch.object(rw, '_user_home', return_value=home),
            patch.object(rw, '_hermes_homes', return_value=[home / '.hermes']),
            patch.object(rw, '_codex_home', return_value=home / '.codex'),
            patch.object(rw, '_S6_ENV_DIR', home / 'container-environment'),
            patch.object(httpx.Client, 'get', side_effect=AssertionError('unmocked vendor call')),
            patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')),
            patch.object(rw.subprocess, 'run', side_effect=AssertionError('subprocess forbidden')),
        ]
        for guard in guards:
            guard.start()
            self.addCleanup(guard.stop)

    def test_retains_dead_expired_missing_and_groups_by_account_host(self):
        rows = [
            {'id':'dead','access_token':jwt('one'),'last_status':'dead'},
            {'id':'live','access_token':jwt('one', time.time()+7200)},
            {'id':'expired','access_token':jwt('two', time.time()-1000)},
            {'id':'missing','account_id':'three'},
            {'id':'other-host','access_token':jwt('one'),'base_url':'https://different.invalid/backend-api/codex'}]
        with patch.object(rw, '_codex_pool_entries', return_value=rows), patch.object(rw, '_read_codex_cli_auth', return_value=None):
            accounts = rw._codex_pool_accounts()
        self.assertEqual(len(accounts),4, 'dead/expired/missing must not disappear; duplicate host must stay separate')
        one = next(a for a in accounts if a.get('account_id')=='one' and not a.get('base_url'))
        self.assertEqual(one['grant_states'], {'revoked':1, 'ready':1})
        self.assertEqual(one['credential_status'], 'ready')
        expired = next(a for a in accounts if a.get('account_id')=='two')
        with patch.object(rw, '_fetch_codex_usage', side_effect=AssertionError('expired must not contact vendor')):
            snap = rw._codex_pool_fetcher(expired)()
        self.assertEqual(snap['account_status'], 'expired')
        self.assertIsNone(snap['fetched_at'])

    def test_vendor_observation_and_cache_preserve_timestamp(self):
        import tempfile
        with patch.object(rw, '_codex_pool_entries', return_value=[{'id':'live','access_token':jwt('one')}]), patch.object(rw, '_read_codex_cli_auth', return_value=None):
            account = rw._codex_pool_accounts()[0]
        payload = {'rate_limit': {'allowed':False, 'limit_reached':True, 'primary_window': {'used_percent':100,'reset_at':time.time()+3600}, 'secondary_window': {'used_percent':20,'reset_at':time.time()+7200}}, 'plan_type':'plus'}
        import httpx
        response = httpx.Response(200, json=payload, request=httpx.Request('GET','https://test.invalid/usage'))
        with patch.object(httpx.Client, 'get', return_value=response):
            snap = rw._codex_pool_fetcher(account)()
        self.assertEqual(snap['quota_state'], 'limit_reached')
        self.assertEqual(len(snap['windows']), 2)
        self.assertIsInstance(snap['fetched_at'], float)
        self.assertEqual(snap['account_status'], 'verified')
        with tempfile.TemporaryDirectory() as d, patch.object(rw, '_resetwatch_cache_dir', return_value=Path(d)):
            rw._store_probe_result_cache([snap],cli_only=True)
            cached = rw._read_probe_result_cache(cli_only=True)
        self.assertEqual(cached[0]['fetched_at'], snap['fetched_at'])
        self.assertTrue(cached[0]['cache_hit'])

    def test_collection_checks_one_group_once_and_keeps_invalid(self):
        rows = [{'id':'healthy','access_token':jwt('one')}, {'id':'dead','account_id':'two','last_status':'dead'}, {'id':'missing','account_id':'three'}]
        loaded = (Path('fixture'), {}, {'access_token': jwt('one', time.time()+1000), 'account_id':'one'})
        with patch.object(rw, '_codex_pool_entries', return_value=rows), patch.object(rw, '_read_codex_cli_auth', return_value=loaded), patch.object(rw, '_disabled_providers', set(rw.LIVE_PROVIDERS)-{'openai-codex'}), patch.object(rw, '_fetch_codex_usage', return_value=rw._snapshot('openai-codex','Plus',[rw._win('Session',5)])) as fetch:
            snapshots, complete = rw._collect_cli()
        self.assertTrue(complete)
        self.assertEqual(len(snapshots),3)
        self.assertEqual(fetch.call_count,1, 'CLI duplicate must not start another vendor check')
        self.assertEqual({s['account_status'] for s in snapshots}, {'verified','revoked','missing'})

    def test_failed_check_keeps_last_success_and_tries_healthy_duplicate(self):
        import httpx, tempfile
        rows = [{'id':'a','access_token':jwt('one',time.time()+4000)}, {'id':'b','access_token':jwt('one',time.time()+3000)}]
        with patch.object(rw,'_codex_pool_entries',return_value=rows), patch.object(rw,'_read_codex_cli_auth',return_value=None):
            account=rw._codex_pool_accounts()[0]
        forbidden = httpx.HTTPStatusError('fixture',request=httpx.Request('GET','https://test.invalid'),response=httpx.Response(401,json={'error':{'code':'token_revoked'}}))
        with tempfile.TemporaryDirectory() as d, patch.object(rw,'_resetwatch_cache_dir',return_value=Path(d)):
            fresh=rw._snapshot('openai-codex','Plus',[rw._win('Session',10)],account_key=account['key'])
            with patch.object(rw,'_fetch_codex_usage',side_effect=[forbidden,fresh]) as fetch:
                good=rw._codex_pool_fetcher(account)()
            self.assertEqual(fetch.call_count,2)
            self.assertEqual(good['account_status'],'verified')
            self.assertEqual(good['grant_states']['revoked'],1)
            with patch.object(rw,'_fetch_codex_usage',side_effect=httpx.ConnectError('fixture')):
                failed=rw._codex_pool_fetcher(account)()
            self.assertEqual(failed['account_status'],'unknown')
            self.assertEqual(failed['fetched_at'],good['fetched_at'], 'failed check must not overwrite last successful observation')
            self.assertEqual(failed['windows'],good['windows'])
            self.assertTrue(failed['cache_hit'])

    def test_openrouter_uses_readonly_credentials_not_runtime_resolver(self):
        import httpx
        values={'OPENROUTER_API_KEY':'fixture', 'OPENROUTER_BASE_URL':'https://openrouter.ai/api/v1'}
        responses=[httpx.Response(200,json={'data':{'total_credits':20,'total_usage':5}},request=httpx.Request('GET','https://test.invalid')), httpx.Response(200,json={'data':{'limit':10,'limit_remaining':4,'usage':6}},request=httpx.Request('GET','https://test.invalid'))]
        with patch.object(rw,'_hermes_env_value',side_effect=values.get), patch.object(rw,'_pool_entries',return_value=[]), patch.object(httpx.Client,'get',side_effect=responses):
            snapshots=rw._collect_hermes_usage()
        self.assertEqual(len(snapshots),1)
        self.assertEqual(snapshots[0]['provider'],'openrouter')
        self.assertEqual(snapshots[0]['windows'][0]['used_percent'],60)
        self.assertIn('Credits balance: $15.00',snapshots[0]['details'])

    def test_cli_missing_token_stays_visible(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'auth.json'
            path.write_text(json.dumps({'tokens':{'account_id':'missing-account'}}))
            with patch.object(rw,'_codex_auth_path',return_value=path),patch.object(rw,'_codex_pool_entries',return_value=[]):
                accounts=rw._codex_pool_accounts()
        self.assertEqual(len(accounts),1)
        self.assertEqual(accounts[0]['credential_status'],'missing')

    def test_budget_expiry_is_unknown_not_ready(self):
        with patch.object(rw,'_codex_pool_entries',return_value=[{'id':'a','access_token':jwt('one')}]),patch.object(rw,'_read_codex_cli_auth',return_value=None):
            account=rw._codex_pool_accounts()[0]
        with patch.object(rw,'_seconds_left',return_value=0),patch.object(rw,'_fetch_codex_usage',side_effect=AssertionError('budget exhausted')):
            snap=rw._codex_pool_fetcher(account)()
        self.assertEqual(snap['account_status'],'unknown')
        self.assertIsNone(snap['last_attempt_at'])

    def test_same_account_different_port_is_not_merged(self):
        rows=[{'id':'a','access_token':jwt('one'),'base_url':'https://example.invalid:8000/codex'}, {'id':'b','access_token':jwt('one'),'base_url':'https://example.invalid:8001/codex'}]
        with patch.object(rw,'_codex_pool_entries',return_value=rows),patch.object(rw,'_read_codex_cli_auth',return_value=None):
            accounts=rw._codex_pool_accounts()
        self.assertEqual(len(accounts),2)

    def test_error_codes_do_not_conflate_auth_and_network(self):
        import httpx
        rows=[{'id':'a','access_token':jwt('one')}]
        with patch.object(rw,'_codex_pool_entries',return_value=rows),patch.object(rw,'_read_codex_cli_auth',return_value=None):
            account=rw._codex_pool_accounts()[0]
        for code,body,expected in [(401,{},'auth_required'),(401,{'error':{'code':'token_revoked'}},'revoked'),(403,{},'forbidden'),(429,{},'rate_limited'),(503,{},'unknown')]:
            error=httpx.HTTPStatusError('fixture',request=httpx.Request('GET','https://test.invalid'),response=httpx.Response(code,json=body))
            with patch.object(rw,'_fetch_codex_usage',side_effect=error):
                snapshot=rw._codex_pool_fetcher(account)()
            self.assertEqual(snapshot['account_status'],expected)
            self.assertIsNone(snapshot['fetched_at'])

    def test_roster_change_invalidates_cache(self):
        with patch.object(rw,'_inventory_fingerprint',return_value='first'):
            rw._store_probe_result_cache([rw._snapshot('openai-codex',None,[])],cli_only=True)
        with patch.object(rw,'_inventory_fingerprint',return_value='changed'):
            self.assertIsNone(rw._read_probe_result_cache(cli_only=True))

    def test_collection_timeout_retains_structured_account_status(self):
        with patch.object(rw,'_codex_pool_entries',return_value=[{'id':'a','access_token':jwt('one')}]),patch.object(rw,'_read_codex_cli_auth',return_value=None),patch.object(rw,'_disabled_providers',set(rw.LIVE_PROVIDERS)-{'openai-codex'}),patch.object(rw,'_seconds_left',return_value=0):
            snapshots,complete=rw._collect_cli()
        self.assertFalse(complete)
        self.assertEqual(len(snapshots),1)
        self.assertEqual(snapshots[0].get('account_status'),'unknown')
        self.assertEqual(snapshots[0].get('grant_count'),1)

if __name__ == '__main__': unittest.main()
