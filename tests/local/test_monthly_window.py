import importlib.util
from pathlib import Path
import subprocess
import shutil
import unittest

ROOT = Path(__file__).resolve().parents[2]

class MonthlyWindow(unittest.TestCase):
    def test_monthly_parser_and_ui_status(self):
        spec = importlib.util.spec_from_file_location('monthly_probe', ROOT / 'resetwatch-local/probe.py')
        assert spec and spec.loader
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        self.assertEqual(probe._codex_window_label({'limit_window_seconds':2592000}, 'Session'), '30 days')
        self.assertEqual(probe._codex_window_label({'limit_window_seconds':604800}, 'Session'), 'Weekly')
        self.assertEqual(probe._codex_window_label({'limit_window_seconds':18000}, 'Session'), 'Session')
        s = (ROOT / 'resetwatch-local/plugin.js').read_text()
        helpers = s[s.index('function mainQuotaWindows('):s.index('const LOCAL_TEXT') ] if 'const LOCAL_TEXT' in s else ''
        start = s.index('function deriveAccountStatus(')
        end = s.index('\n}',start)+2
        function = s[start:end]
        main = s[s.index('function mainQuotaWindows('):s.index('function resetRefreshPlan(')]
        script = 'const assert=require("node:assert/strict");const providerKey=x=>x,observedMillis=x=>x*1000,clampPercent=x=>x,POLL_MS=300000,REFRESH_COOLDOWN_MS=60000;' + main + function
        script += ';const now=Date.now();const r=deriveAccountStatus({provider:"openai-codex",account_status:"verified",credential_status:"ready",fetched_at:now/1000,allowed:false,limit_reached:true,windows:[{label:"30 days",used_percent:100,remaining_percent:0,reset_at:new Date(now+100000).toISOString()}]},now);assert.equal(r.blockScope,"30 days");assert.equal(r.availability,"limit_reached");assert.equal(r.recoveryAt,now+100000);'
        node=shutil.which('node');assert node
        subprocess.run([node,'-e',script],check=True)

if __name__ == '__main__': unittest.main()
