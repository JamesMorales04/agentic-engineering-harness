# Engineering evals

Each case lives in `evals/corpus/<case-id>/eval.yaml` and should describe a reproducible historical engineering task.

```yaml
version: 1
id: EVAL-001
taskId: CHANGE-142
baseRef: <frozen-git-commit>
fixtureDir: evals/corpus/EVAL-001/fixture
runCommand: aeh run {taskId}
variants:
  - name: workhorse-a
    env:
      WORKER_MODEL: provider/model-a
  - name: workhorse-b
    env:
      WORKER_MODEL: provider/model-b
expectations:
  status: PASS
  maxRepairs: 2
  maxHumanInterventions: 0
  maxCostUsd: 1.00
  requiredChecks:
    - acceptance
```

`aeh eval run EVAL-001 --variant workhorse-a` creates an isolated detached worktree at `baseRef`, overlays the fixture, executes the variant, reads deterministic run/report artifacts, scores the result, persists it, and removes the worktree. `aeh eval compare EVAL-001` ranks all stored runs.
