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

## Semantic routing corpus

`evals/corpus/intent-routing.json` is a separate lead-semantic evaluation
corpus. It includes Spanish and English prompts, negation, mixed requests,
finding referents, constrained follow-ups, status/cancel, prepared-run
continuation and adversarial policy wording. Each case records an expected
semantic route and a compact scripted `IntentDecisionV1` fixture. The mandatory
`tests/intentRoutingCorpus.test.ts` validates the structured route/effect
contract without invoking the heuristic classifier. A model-backed eval lane
may compare a configured lead's decision against the prompt labels without
making external inference a requirement of ordinary pull-request CI.
