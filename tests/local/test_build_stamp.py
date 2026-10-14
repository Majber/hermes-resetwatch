"""One offline paired-build check; no credentials or network."""
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]

class BuildStamp(unittest.TestCase):
    def test_paired_stamp_and_warning(self):
        source = (ROOT / 'resetwatch-local/plugin.js').read_text()
        build = re.search(r"const LOCAL_BUILD = '([^']+)'", source).group(1)
        spec = importlib.util.spec_from_file_location('probe_build', ROOT / 'resetwatch-local/probe.py')
        probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(probe)
        self.assertEqual(probe.LOCAL_BUILD, build)
        output = io.StringIO()
        payload = {'snapshot_token': 'a' * 32, 'snapshots': [{'fetched_at': 123}]}
        probe._emit_json(payload, output)
        stamped = json.loads(output.getvalue())
        self.assertEqual(stamped['local_build'], build)
        self.assertEqual(stamped['snapshots'][0]['fetched_at'], 123)
        self.assertNotIn('local_build', payload)
        function = source[source.index('function probeBuildWarning('):source.index('function pinnedPage(')]
        script = 'const assert=require("node:assert/strict");const LOCAL_BUILD=' + json.dumps(build) + ';' + function + '\nassert.equal(probeBuildWarning({local_build:LOCAL_BUILD}),null);assert.match(probeBuildWarning({local_build:"older"}),/Niezgodne wersje/);assert.match(probeBuildWarning({}),/starszy probe/);'
        subprocess.run([shutil.which('node'), '-e', script], check=True)

if __name__ == '__main__':
    unittest.main()
