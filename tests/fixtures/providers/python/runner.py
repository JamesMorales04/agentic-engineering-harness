import json

print(json.dumps({
    "version": 1,
    "provider": "python-native-fixture",
    "status": "PASS",
    "summary": {"total": 2, "passed": 2, "failed": 0, "skipped": 0, "durationMs": 4},
    "tests": [{"id": "python:pass", "status": "passed"}, {"id": "python:second", "status": "passed"}],
}))
