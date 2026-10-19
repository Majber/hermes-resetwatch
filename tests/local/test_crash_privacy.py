"""Crash output must not expose exception payloads; no auth/files/network."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('crash_probe', ROOT / 'resetwatch-local/probe.py')
assert spec and spec.loader
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CrashPrivacy(unittest.TestCase):
    def test_crash_keeps_json_contract_without_exception_payload(self):
        # Synthetic credential-bearing URL/body, not a real credential.
        payload = 'https://fixture.invalid/?access_token=synthetic-private-value'
        for error in (ValueError(payload), RuntimeError(payload), KeyError(payload)):
            with self.subTest(error=type(error).__name__):
                output = io.StringIO()
                with patch.object(probe, '_main_inner', side_effect=error), contextlib.redirect_stdout(output):
                    self.assertEqual(probe.main(), 0)
                snapshots = json.loads(output.getvalue())
                self.assertEqual(snapshots[0]['provider'], 'resetwatch')
                self.assertEqual(snapshots[0]['details'], [f'probe failed: {type(error).__name__}'])
                self.assertNotIn('synthetic-private-value', output.getvalue())
                self.assertNotIn('fixture.invalid', output.getvalue())


if __name__ == '__main__':
    unittest.main()
