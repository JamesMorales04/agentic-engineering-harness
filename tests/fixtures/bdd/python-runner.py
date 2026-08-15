import json
import pathlib
import re
import sys

feature = pathlib.Path(__file__).with_name("greeting.feature").read_text()
feature_name = re.search(r"^Feature:\s*(.+)$", feature, re.MULTILINE)
scenario = re.search(r"^\s*Scenario:\s*(.+)$", feature, re.MULTILINE)
tags = [f"@{match.group(1)}" for match in re.finditer(r"^@(\S+)$", feature, re.MULTILINE)]
steps = re.findall(r"^\s*(Given|When|Then|And|But)\b", feature, re.MULTILINE)
passed = bool(feature_name and scenario and feature_name.group(1) == "greeting" and scenario.group(1) == "a greeting is returned" and len(steps) == 3)

print(json.dumps({
    "version": 1,
    "provider": "python-gherkin-fixture",
    "scenarios": [{"feature": feature_name.group(1) if feature_name else "unknown", "scenario": scenario.group(1) if scenario else "unknown", "tags": tags, "status": "PASS" if passed else "FAIL", "source": {"file": "tests/fixtures/bdd/greeting.feature", "line": 4}, "requirementIds": ["REQ-BDD"], **({} if passed else {"error": "feature parsing or step execution failed"})}],
}))
sys.exit(0 if passed else 1)
