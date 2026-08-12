# Memory benchmark corpus

Add YAML cases here to compare memory providers against the same retrieval questions.

```yaml
version: 1
id: architecture-decision-001
query: Why was the current persistence boundary chosen?
expectedTerms:
  - decision identifier
  - expected rationale token
forbiddenTerms:
  - known stale answer
```

Configure providers in `.harness/project.yaml`. Each provider receives the exact same query through `{query}`. This lets Engram, Cognee, Graphiti or another backend compete on the same corpus without making any backend authoritative.
