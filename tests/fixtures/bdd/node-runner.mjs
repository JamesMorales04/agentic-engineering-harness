console.log(JSON.stringify({
  version: 1,
  provider: "cucumber-js-fixture",
  scenarios: [{ feature: "greeting", scenario: "a greeting is returned", tags: ["@REQ-BDD"], status: "PASS", source: { file: "features/greeting.feature", line: 3 }, requirementIds: ["REQ-BDD"] }]
}));
