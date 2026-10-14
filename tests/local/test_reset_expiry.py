"""Single offline test for optional banked reset expiry reads."""
import importlib.util
from pathlib import Path
import json
import shutil
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('expiry_probe', ROOT / 'resetwatch-local/probe.py')
assert spec and spec.loader
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)

class Expiry(unittest.TestCase):
    def test_expiries_and_graceful_failure(self):
        import httpx
        payload = {'credits': [
            {'status': 'available', 'expires_at': '2030-11-06T22:01:00Z'},
            {'status': 'redeemed', 'expires_at': '2030-10-01T00:00:00Z'},
            {'status': 'available', 'expires_at': '2030-10-29T18:03:00Z'}]}
        with patch.object(httpx, 'Client') as client:
            response = client.return_value.__enter__.return_value.get.return_value
            response.json.return_value = payload
            result = rw._read_reset_expiries('synthetic', {}, 'https://fixture.invalid/wham/usage')
            self.assertEqual(client.return_value.__enter__.return_value.get.call_count, 1)
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(len(result['credits']), 2)
        self.assertTrue(result['credits'][0]['expires_at'].startswith('2030-10-29'))
        with patch.object(httpx, 'Client', side_effect=RuntimeError('offline')):
            failed = rw._read_reset_expiries('synthetic', {}, 'https://fixture.invalid/wham/usage')
        self.assertEqual(failed['status'], 'unknown')
        source = (ROOT / 'resetwatch-local/plugin.js').read_text()
        helper = source[source.index('function resetExpirySummary('):source.index('function resetBalanceLabel(')]
        node = shutil.which('node')
        assert node
        script = 'const assert=require("node:assert/strict");const POLL_MS=300000,REFRESH_COOLDOWN_MS=60000;const bankedResetCount=s=>s.rate_limit_reset_credits.available_count;' + helper
        script += '\nconst now=Date.parse("2030-10-20T12:00:00Z");const data=' + json.dumps(result) + ';data.observed_at=now/1000;const snap={banked_reset_details:data,rate_limit_reset_credits:{available_count:2}};assert.match(resetExpirySummary(snap,now).short,/29.10/);assert.match(resetExpirySummary(snap,now).full,/Reset 2/);assert.match(resetExpirySummary({},now).short,/nieznana/);assert.match(resetExpirySummary(snap,now+400000).short,/do sprawdzenia/);'
        subprocess.run([node, '-e', script], check=True)

if __name__ == '__main__':
    unittest.main()
