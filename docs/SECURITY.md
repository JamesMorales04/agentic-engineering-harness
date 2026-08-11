# Security and Isolation

A Git worktree is not a security sandbox.

The target model is an ephemeral rootless container per worker:

- repository workspace writable;
- frozen contracts/acceptance validators read-only;
- no host SSH keys;
- no production credentials;
- network denied or allow-listed where possible;
- CPU/RAM/time limits;
- extract resulting diff, then destroy sandbox.

Recommended OSS tools:

- Podman rootless for worker isolation;
- Opengrep for deterministic pattern/dataflow checks;
- Trivy for vulnerabilities, secrets, IaC and SBOM scanning;
- OPA for policy-as-code;
- Cosign/in-toto for later provenance/attestations.
