# Engineering Evals

The harness itself must be evaluated.

Each historical task can become a frozen eval case containing:

```text
evals/corpus/EVAL-001/
├── metadata.yaml
├── task.md
├── base-commit.txt
├── expected-invariants.yaml
└── frozen-tests/
```

Compare harness/model/config variants on identical base commits and tasks.

Primary metrics:

- deterministic task success;
- first-pass pass rate;
- repair count;
- human intervention rate;
- scope/architecture/security violation rate;
- lead-model and worker-model usage;
- elapsed time.

Production bugs should be converted into permanent regression/eval cases when practical.
