console.log(JSON.stringify({
  version: 1,
  provider: "node-native-fixture",
  status: "PASS",
  summary: { total: 2, passed: 2, failed: 0, skipped: 0, durationMs: 3 },
  tests: [{ id: "node:pass", status: "passed" }, { id: "node:second", status: "passed" }]
}));
