"""One isolated per-provider fallback regression; no real home or network."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fallback_probe', ROOT / 'resetwatch-local/probe.py')
assert spec and spec.loader
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

class PoolFallback(unittest.TestCase):
    def test_fallback_and_profile_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            profile = base / 'profiles' / 'fixture'
            profile.mkdir(parents=True)
            (base / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [{'id': 'base'}]}}))
            with patch.object(probe, '_profile_home', profile), patch.object(probe, '_hermes_homes', return_value=[profile]):
                self.assertEqual(probe._pool_entries('openai-codex'), [{'id': 'base'}])
                (profile / 'auth.json').write_text(json.dumps({'credential_pool': {'other': [{'id': 'other'}]}}))
                self.assertEqual(probe._pool_entries('openai-codex'), [{'id': 'base'}])
                (profile / 'auth.json').write_text(json.dumps({'credential_pool': {'openai-codex': [{'id': 'own'}]}}))
                self.assertEqual(probe._pool_entries('openai-codex'), [{'id': 'own'}])
            isolated = base / 'isolated'
            isolated.mkdir()
            with patch.object(probe, '_profile_home', isolated), patch.object(probe, '_hermes_homes', return_value=[isolated]):
                self.assertEqual(probe._pool_entries('openai-codex'), [])

if __name__ == '__main__':
    unittest.main()
