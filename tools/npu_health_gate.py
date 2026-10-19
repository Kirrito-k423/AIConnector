"""NPU health-only gate for fixed experiment entries; no SSH/reset or scheduling.

Import evaluate_health with the existing parsed per-device records, or supply a
JSON array on stdin. Occupancy, HBM, SDK, correctness and rank gates stay separate.
"""
import argparse
import json
import os
import sys


def evaluate_health(devices, policy=None):
    policy = policy or os.environ.get('AICONNECTOR_NPU_HEALTH_POLICY', 'allow-warning-alarm')
    if policy not in ('strict', 'allow-warning-alarm'):
        raise ValueError('INVALID_NPU_HEALTH_POLICY')
    if not isinstance(devices, list) or not devices or len(devices) > 128:
        raise ValueError('INVALID_NPU_HEALTH_DEVICES')
    normalized = []
    for record in devices:
        if not isinstance(record, dict) or not isinstance(record.get('device'), (int, str)):
            raise ValueError('INVALID_NPU_HEALTH_DEVICE')
        device = str(record['device'])
        if not device.isdigit() or len(device) > 8:
            raise ValueError('INVALID_NPU_HEALTH_DEVICE')
        health = record.get('health')
        normalized.append(dict(device=device, health=health if health in ('OK', 'Warning', 'Alarm') else 'unknown'))
    if len({d['device'] for d in normalized}) != len(normalized):
        raise ValueError('DUPLICATE_NPU_HEALTH_DEVICE')
    accepted = ('OK',) if policy == 'strict' else ('OK', 'Warning', 'Alarm')
    return dict(schema='aiconnector.npu-health-gate.v1', policy=policy,
                allowed=all(d['health'] in accepted for d in normalized),
                devices=normalized,
                warnings=[d for d in normalized if d['health'] in ('Warning', 'Alarm')],
                scope='Health only; does not prove free capacity, compute, communication or correctness.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--policy', choices=('strict', 'allow-warning-alarm'))
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError('NPU_HEALTH_INPUT_TOO_LARGE')
        result = evaluate_health(json.loads(data), args.policy)
    except (ValueError, TypeError, KeyError):
        result = dict(schema='aiconnector.npu-health-gate.v1', allowed=False, error='INVALID_NPU_HEALTH_INPUT')
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['allowed'] else 86


if __name__ == '__main__':
    sys.exit(main())
