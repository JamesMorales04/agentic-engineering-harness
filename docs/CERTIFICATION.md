# AEH Certification Core

AEH certification is a runtime-agnostic quality boundary. `CertificationCore` accepts a `CandidateRevision`, a frozen `CertificationPolicy`, and an independent deterministic `CertificationOracle`. It emits one of:

```text
ACCEPTED
REPAIR_REQUIRED
HUMAN_REQUIRED
PARTIAL
BLOCKED
NOT_TESTED
```

Capability reports contain separate `contract` and `modelE2E` lanes. A deterministic contract PASS with a blocked or untested model lane is `PARTIAL`, never a full PASS. A campaign requiring model execution is accepted only when the provider receipt proves startup and the oracle verifies model-produced journey evidence.

External actors can propose or repair a candidate, but their claimed verdicts never become acceptance evidence. Provider execution is behind `AgentProvider`; the initial `CodexAgentProvider` is a bootstrap adapter and is not part of certification policy or oracle semantics.

The bootstrap lane packs the current checkout, installs that pack into a disposable fixture with lifecycle scripts disabled, and evaluates it with an argv-based deterministic command oracle:

```bash
aeh certification self-dogfood <fixture> \
  --check node \
  --check-args '["-e","process.exit(0)"]' \
  --prompt "Run the fixture task"
```

The Codex adapter resolves installed CLI capabilities from `codex exec --help`, uses `-c model_reasoning_effort="high"` when the CLI does not expose a reasoning flag, and records requested/effective configuration plus the Codex thread identifier. It uses a temporary controlled `HOME`/`CODEX_HOME` containing only the copied Codex auth file and generated model configuration; the fixture does not receive the host HOME tree.

The provider boundary filters ambient environment variables, rejects recursive certification, bounds output and time, and terminates process groups on timeout or output overflow. Direct execution does not enforce OS-level network isolation. Reports therefore record `networkPolicy.requested`, `networkPolicy.enforced`, and `networkPolicy.enforcement`; a policy requiring isolation blocks when the direct transport cannot enforce it.

Reports from the CLI are persisted under `.aeh-test-results/certification/<certification-id>.json` with the packed candidate SHA-256 and package identity. Temporary candidate paths remain diagnostic only.
