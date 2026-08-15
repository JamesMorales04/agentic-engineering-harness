import json

print(json.dumps({
    "version": 1,
    "provider": "behave-fixture",
    "scenarios": [{"feature": "greeting", "scenario": "a greeting is returned", "tags": ["@REQ-BDD"], "status": "PASS", "source": {"file": "features/greeting.feature", "line": 3}, "requirementIds": ["REQ-BDD"]}],
}))
