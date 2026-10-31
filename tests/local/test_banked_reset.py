"""ONE focused offline regression, including mocked UI. Never reads real auth."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class BankedResetRegression(unittest.TestCase):
    def test_explicit_exact_credit_once_and_verified_readback(self):
        spec = importlib.util.spec_from_file_location('reset_manage', ROOT / 'resetwatch-local/manage.py')
        assert spec is not None and spec.loader is not None
        manage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(manage)
        key = 'a' * 20
        token = 'synthetic-secret-do-not-print'
        account = dict(key=key, account_id='account-a', source_host='chatgpt.com', base_url=None,
                       label='Work', candidates=[dict(token=token, state='ready', entry={})])
        usage = dict(account_id='account-a', user_id='user-a', rate_limit_reset_credits=dict(available_count=2, applicable_available_count=1), rate_limit={
            'primary_window': dict(used_percent=80, reset_at=2000000000, limit_window_seconds=18000),
            'secondary_window': dict(used_percent=100, reset_at=2000000001, limit_window_seconds=604800)})
        credits = dict(available_count=2, credits=[dict(id='later', status='available', reset_type='codex_rate_limits', expires_at='2099-02-01T00:00:00Z', title='Later'), dict(id='earlier', status='available', reset_type='codex_rate_limits', expires_at='2099-01-01T00:00:00Z', title='First')])
        calls = []
        state = {'post': False, 'mode': 'success'}
        def request(ctx, method, path, payload=None):
            calls.append((method, path, payload))
            if method == 'POST':
                state['post'] = True
                if state['mode'] == 'timeout':
                    raise TimeoutError(token)
                if state['mode'] == 'empty':
                    return {}
                return dict(code='reset', windows_reset=2)
            if path == '/usage':
                result = copy.deepcopy(usage)
                if state['post']:
                    result['rate_limit_reset_credits']['available_count'] = 1
                    result['rate_limit']['secondary_window']['used_percent'] = 0
                return result
            result = copy.deepcopy(credits)
            if state['post']:
                result['available_count'] = 1
                result['credits'][1]['status'] = 'redeemed'
            return result
        with tempfile.TemporaryDirectory(prefix='resetwatch-reset-') as tmp:
            probe = SimpleNamespace(_profile_home=Path(tmp), LOCAL_BUILD='fixture', CODEX_DEFAULT_BASE_URL='https://chatgpt.com/backend-api/codex',
                _codex_pool_accounts=lambda: [account], _codex_usage_url=lambda _: 'https://chatgpt.com/backend-api/wham/usage',
                _jwt_claims=lambda _: {'sub': 'subject-a'}, _codex_account_id_from_token=lambda _: 'account-a',
                _codex_token_expiring=lambda _: False, _codex_name_from_token=lambda _: 'fixture@example.invalid',
                _mask_email_label=lambda _: 'fi**@example.invalid', _resetwatch_cache_dir=lambda: Path(tmp),
                _parse_dt=lambda v: __import__('datetime').datetime.fromisoformat(v.replace('Z', '+00:00')) if isinstance(v, str) else None,
                _codex_windows_from_payload=lambda p: [dict(label='Session', used_percent=p['rate_limit']['primary_window']['used_percent'], reset_at='2033-05-18T03:33:20+00:00'), dict(label='Weekly', used_percent=p['rate_limit']['secondary_window']['used_percent'], reset_at='2033-05-18T03:33:21+00:00')])
            with patch.object(manage, '_reset_request', side_effect=request):
                prepared = manage.prepare_reset(probe, key)
                self.assertEqual([c['id'] for c in prepared['credits']], ['earlier', 'later'])
                self.assertEqual([c[0] for c in calls], ['GET', 'GET'])
                self.assertNotIn(token, json.dumps(prepared))
                self.assertEqual(prepared['identity'], 'fi**@example.invalid')
                bad = manage.redeem_reset(probe, 'b' * 20, prepared['plan_token'], 0, True)
                self.assertFalse(bad['ok']); self.assertFalse(any(c[0] == 'POST' for c in calls))
                prepared = manage.prepare_reset(probe, key)
                account['candidates'][0]['token'] = 'changed-secret'
                self.assertFalse(manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)['ok'])
                self.assertFalse(any(c[0] == 'POST' for c in calls))
                account['candidates'][0]['token'] = token
                usage['rate_limit_reset_credits']['applicable_available_count'] = 0
                blocked = manage.prepare_reset(probe, key)
                self.assertFalse(blocked.get('plan_token')); self.assertIn('0', blocked['reason'])
                usage['rate_limit_reset_credits']['applicable_available_count'] = 1
                prepared = manage.prepare_reset(probe, key)
                with patch.object(manage.time, 'time', return_value=prepared['expires_at'] + 1):
                    self.assertFalse(manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)['ok'])
                self.assertFalse(any(c[0] == 'POST' for c in calls), 'expired confirmation must not send')
                prepared = manage.prepare_reset(probe, key)
                credits['credits'][1]['status'] = 'redeemed'
                self.assertFalse(manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)['ok'])
                self.assertFalse(any(c[0] == 'POST' for c in calls), 'fresh inventory must still contain exact available credit')
                credits['credits'][1]['status'] = 'available'
                prepared = manage.prepare_reset(probe, key)
                result = manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['after']['available_count'], 1)
                posts = [c for c in calls if c[0] == 'POST']
                self.assertEqual(len(posts), 1)
                self.assertEqual(posts[0][1], '/rate-limit-reset-credits/consume')
                self.assertEqual(posts[0][2]['credit_id'], 'earlier')
                self.assertRegex(posts[0][2]['redeem_request_id'], r'^[0-9a-f-]{36}$')
                self.assertFalse(manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)['ok'])
                self.assertEqual(len([c for c in calls if c[0] == 'POST']), 1)
                for mode in ('timeout', 'empty'):
                    credits['credits'][1]['id'] = 'earlier-' + mode
                    state.update(post=False, mode=mode)
                    prepared = manage.prepare_reset(probe, key)
                    start = len(calls)
                    result = manage.redeem_reset(probe, key, prepared['plan_token'], 0, True)
                    self.assertFalse(result['ok']); self.assertTrue(result['uncertain'])
                    self.assertEqual([c[0] for c in calls[start:]], ['GET', 'GET', 'POST', 'GET', 'GET'])
                    self.assertEqual(result['after']['available_count'], 1)
                    self.assertNotIn(token, json.dumps(result))
                    state['post'] = False  # Simulate stale inventory after an ambiguous attempt.
                    blocked = manage.prepare_reset(probe, key)
                    self.assertNotIn('earlier-' + mode, [c['id'] for c in blocked['credits']])
                state.update(post=False, mode='success')
                prepared = manage.prepare_reset(probe, key)
                self.assertFalse(manage.redeem_reset(probe, key, prepared['plan_token'], 0, False)['ok'])
                account['source_host'] = 'evil.invalid'
                with self.assertRaises(ValueError):
                    manage.prepare_reset(probe, key)
        # Real HTTP constructor against a fake transport: redirects/retries disabled.
        class Response:
            status_code = 302
            def raise_for_status(self): raise ValueError('redirect')
        client = SimpleNamespace(__enter__=lambda s: s, __exit__=lambda *a: None)
        class Client:
            def __init__(self, **kw): self.kw = kw; self.__class__.options = kw
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def request(self, *a, **kw): return Response()
        import sys
        with patch.dict(sys.modules, {'httpx': SimpleNamespace(Client=Client)}):
            with self.assertRaises(ValueError):
                manage._reset_request(dict(url='https://chatgpt.com/backend-api/wham/usage', token=token, account_id='account-a'), 'GET', '/usage')
            self.assertIs(Client.options['follow_redirects'], False)
        ui = subprocess.run(['node', str(ROOT / 'tests/local/banked-reset-ui.cjs')], capture_output=True, text=True)
        self.assertEqual(ui.returncode, 0, ui.stdout + ui.stderr)
        print(ui.stdout.strip())


if __name__ == '__main__':
    unittest.main()
