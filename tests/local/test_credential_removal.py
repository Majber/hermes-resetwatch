"""One offline removal regression; synthetic inventory, no auth/network/model I/O."""
import importlib.util
import json
from pathlib import Path
import subprocess
import hashlib
import os
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


class RemovalRegression(unittest.TestCase):
    def test_confirmed_stable_id_removal(self):
        helper = ROOT / 'resetwatch-local/manage.py'
        self.assertTrue(helper.is_file(), 'explicit credential management helper missing')
        spec = importlib.util.spec_from_file_location('removal_fixture', helper)
        assert spec is not None and spec.loader is not None
        manage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(manage)
        key = 'a' * 20
        rows = [dict(id='ab12cd34', source='manual', account_id='synthetic-a', access_token='never-output-a'),
                dict(id='bc23de45', source='manual', account_id='synthetic-a', access_token='never-output-b'),
                dict(id='cd34ef56', source='manual', account_id='synthetic-b', access_token='never-output-c')]
        def accounts():
            return [dict(key=key, account_id='synthetic-a', label='fixture@example.invalid', candidates=[dict(entry=r, state='ready') for r in rows if r['account_id'] == 'synthetic-a'])]
        probe = SimpleNamespace(_profile_home=Path('/synthetic/home'), _read_auth_store=lambda _: {'credential_pool': {'openai-codex': rows}}, _codex_pool_accounts=accounts)
        calls = []
        def run(home, entry_id):
            calls.append(entry_id)
            rows[:] = [r for r in rows if r['id'] != entry_id]
            return 0
        plan = manage.plan(probe, key)
        self.assertEqual([r['id'] for r in plan['entries']], ['ab12cd34', 'bc23de45'])
        self.assertNotIn('never-output', json.dumps(plan))
        with patch.object(manage, '_run_remove', side_effect=run):
            bad = manage.remove(probe, 'b' * 20, ['ab12cd34'], plan['revision'])
            self.assertFalse(bad['ok']); self.assertEqual(calls, [])
            rows[0]['account_id'] = 'synthetic-b'
            bad = manage.remove(probe, key, ['ab12cd34'], plan['revision'])
            self.assertFalse(bad['ok']); self.assertEqual(calls, [])
            rows[0]['account_id'] = 'synthetic-a'
            result = manage.remove(probe, key, ['ab12cd34'], plan['revision'])
            self.assertTrue(result['ok']); self.assertEqual(calls, ['ab12cd34'])
            self.assertEqual([r['id'] for r in rows], ['bc23de45', 'cd34ef56'])
            with patch.object(manage, '_run_remove', return_value=0):
                result = manage.remove(probe, key, ['bc23de45'], manage.plan(probe, key)['revision'])
                self.assertFalse(result['ok'], 'CLI exit zero is not removal proof')
        with patch.object(manage.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as cli, patch.object(manage, '_cli_path', return_value='/synthetic/hermes'):
            manage._run_remove(Path('/synthetic/home'), 'bc23de45')
            self.assertEqual(cli.call_args.args[0], ['/synthetic/hermes', '--profile', 'default', 'auth', 'remove', 'openai-codex', 'bc23de45'])
            self.assertFalse(cli.call_args.kwargs.get('shell', False))
            self.assertEqual(cli.call_args.kwargs['env']['HERMES_HOME'], '/synthetic/home')
        # Exercise the real probe dispatch against an isolated synthetic install.
        # No --credential-remove invocation, real CLI, network or user-home reads.
        with tempfile.TemporaryDirectory(prefix='resetwatch-removal-') as tmp:
            home = Path(tmp)
            install = home / 'desktop-plugins/resetwatch-local'
            install.mkdir(parents=True)
            for name in ('probe.py', 'manage.py'):
                shutil.copyfile(ROOT / 'resetwatch-local' / name, install / name)
            (home / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [dict(id='a1b2c3',source='manual',account_id='synthetic-a',access_token='never-output')]}}))
            target = hashlib.sha256(b'chatgpt.com\x00synthetic-a').hexdigest()[:20]
            env = {**os.environ, 'HERMES_HOME': str(home), 'HOME': str(home), 'USERPROFILE': str(home), 'CODEX_HOME': str(home / '.codex'), 'PYTHONDONTWRITEBYTECODE': '1'}
            planned = subprocess.run([sys.executable, '-B', str(install / 'probe.py'), '--profile', 'default', '--credential-plan=' + target], capture_output=True, text=True, env=env, timeout=10)
            self.assertEqual(planned.returncode, 0, planned.stderr)
            payload = json.loads(planned.stdout)
            self.assertEqual(payload['entries'][0]['id'], 'a1b2c3')
            self.assertIn('local_build', payload)
            self.assertNotIn('never-output', planned.stdout)
        # Multiple selected entries: preserve siblings and surface a partial CLI failure.
        rows[:] = [dict(id='ab12cd34', source='manual', account_id='synthetic-a'), dict(id='bc23de45', source='manual', account_id='synthetic-a'), dict(id='cd34ef56', source='manual', account_id='synthetic-b')]
        def partial(home, entry_id):
            if entry_id == 'ab12cd34':
                rows[:] = [r for r in rows if r['id'] != entry_id]
                return 0
            return 1
        with patch.object(manage, '_run_remove', side_effect=partial):
            result = manage.remove(probe, key, ['ab12cd34', 'bc23de45'], manage.plan(probe, key)['revision'])
        self.assertTrue(result['partial']); self.assertFalse(result['ok'])
        self.assertEqual(result['removed_ids'], ['ab12cd34'])
        self.assertEqual([r['id'] for r in rows], ['bc23de45', 'cd34ef56'])
        ui = subprocess.run(['node', str(ROOT / 'tests/local/credential-removal-ui.cjs')], capture_output=True, text=True, check=False)
        self.assertEqual(ui.returncode, 0, ui.stdout + ui.stderr)


if __name__ == '__main__':
    unittest.main()
