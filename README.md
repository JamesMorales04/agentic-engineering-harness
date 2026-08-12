# Agentic Engineering Harness

An **OSS-first, zero-mandatory-SaaS engineering control layer** for using coding agents without treating their output as trusted.

```text
Human -> Codex/lead -> SDD + Gherkin -> frozen TaskContract
      -> worker (Paseo -> OpenCode, or Podman -> OpenCode)
      -> deterministic validators -> finite repair loop -> lead review
```

The harness separates normative truth (Git/SDD), structural truth (Graphify), historical memory (Engram, advisory) and executable truth (tests/policies/security/contracts).

## Status: v0.2.5

Implemented:

- end-to-end requirement traceability across proposal/spec/design/tasks/Gherkin/TaskContract;
- automatic TaskContract generation and SHA-256 sealing;
- adapter-based deterministic validator registry;
- automatic Reqnroll/Gherkin execution for .NET projects;
- Paseo -> OpenCode worker execution with configurable provider/model;
- optional direct Podman/OpenCode executor with sealed artifacts read-only;
- finite structured repair loop;
- Graphify before/after snapshots, stale-graph detection and impact gates;
- Opengrep, Trivy, Playwright, OpenAPI and Pact/custom adapters;
- OPA supplied with real dependency/schema diff evidence;
- machine-readable reports, run artifacts and repair packets.

See [docs/V0.2.md](docs/V0.2.md).

## Development

```bash
npm install
npm run check
npm run build
```

## Consumer bootstrap

```bash
aeh init /path/to/repo
cd /path/to/repo
aeh doctor
```

## SDD

```bash
aeh sdd new CHANGE-142 --title "Location-scoped authorization"
aeh sdd validate CHANGE-142
```

`aeh sdd new` creates the five SDD artifacts plus `.harness/contracts/CHANGE-142.yaml`. `sdd validate` requires every canonical requirement ID to be present in proposal, spec, design, Gherkin, tasks, TaskContract and a known validator mapping.

## Verify only

```bash
aeh seal CHANGE-142
aeh verify CHANGE-142
```

The report is written to `.harness/reports/CHANGE-142.json`.

## Full run

```bash
aeh run CHANGE-142
```

Default orchestration:

```yaml
orchestration:
  provider: paseo
  worker:
    provider: opencode
    model: your-provider/your-workhorse-model
    maxRepairAttempts: 2
```

The harness launches the worker through Paseo, waits for it, validates the actual diff, converts FAIL checks into a structured repair packet, sends that evidence back to the same worker and stops after the configured repair budget.

For direct process isolation instead:

```yaml
orchestration:
  provider: podman
security:
  sandbox:
    provider: podman
    image: your-opencode-worker-image
```

Podman mounts the repository RW and overlays the TaskContract, seal and SDD sources RO. Credentials/environment are not copied implicitly; pass only what the worker actually needs through deliberate Podman arguments.

## Validators

| Adapter | Purpose |
|---|---|
| `gherkin` | Reqnroll/Gherkin acceptance or a custom Gherkin command |
| `graphify` | structural before/after diff and blast-radius constraints |
| `opengrep` | local SAST |
| `trivy` | vulnerability/misconfiguration/secret scanning |
| `playwright` | browser/E2E command |
| `openapi` | built-in JSON/YAML backward compatibility checks |
| `pact` | explicit consumer-contract command |
| `command` | arbitrary deterministic project command |

```yaml
validation:
  validators:
    - id: acceptance
      adapter: gherkin
      required: true
    - id: api-compat
      adapter: openapi
      required: true
      options:
        baseline: contracts/openapi-baseline.json
        current: artifacts/openapi-current.json
```

Missing optional external tools yield WARN; required tools that cannot run yield FAIL. If an installed tool reports defects, the result is FAIL regardless of whether its availability was optional.

## Graphify

The harness consumes `graphify-out/graph.json`; it does not invent a graph-building terminal command. Refresh the graph through Graphify's assistant skill or configure a valid project-specific `codeIntelligence.refreshCommand`. The harness then seals before/after snapshots and can detect a stale graph when source files changed but the graph hash did not.

## Trust model

- requirements/architecture belong to the lead agent and Git artifacts;
- TaskContract + SDD inputs are sealed before delegation;
- frozen files cannot be modified without failing validation;
- workers do not own the acceptance criteria;
- deterministic evidence outranks worker summaries;
- repair prompts are generated from failed checks, not free-form model criticism;
- final semantic acceptance remains with the lead/human.

## License

Apache-2.0.
