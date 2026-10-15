import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'tools/npu_health_gate.py'
spec = importlib.util.spec_from_file_location('npu_health_gate', SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class HealthGateTests(unittest.TestCase):
    def test_warning_alarm_are_recorded_and_allowed(self):
        result = gate.evaluate_health([dict(device=0, health='Warning'), dict(device=1, health='Alarm')], 'allow-warning-alarm')
        self.assertTrue(result['allowed'])
        self.assertEqual(len(result['warnings']), 2)

    def test_strict_and_unknown_remain_distinct(self):
        for health in ('Warning', 'Alarm', 'unknown', None):
            self.assertFalse(gate.evaluate_health([dict(device=0, health=health)], 'strict')['allowed'])
        self.assertFalse(gate.evaluate_health([dict(device=0, health='NA')], 'allow-warning-alarm')['allowed'])

    def test_fixed_entry_cli_exit_and_evidence(self):
        for health, code in [('OK', 0), ('Alarm', 0), ('NA', 86)]:
            result = subprocess.run([sys.executable, str(SCRIPT), '--policy', 'allow-warning-alarm'], input=json.dumps([dict(device=0, health=health)]), capture_output=True, text=True)
            self.assertEqual(result.returncode, code)
            self.assertEqual(json.loads(result.stdout)['allowed'], code == 0)

    def test_duplicate_device_and_bad_input_do_not_pass(self):
        with self.assertRaises(ValueError):
            gate.evaluate_health([dict(device=0, health='OK'), dict(device=0, health='OK')])
        result = subprocess.run([sys.executable, str(SCRIPT)], input='invalid', capture_output=True, text=True)
        self.assertEqual(result.returncode, 86)


if __name__ == '__main__':
    unittest.main()
