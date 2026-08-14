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

External security and browser validators emit normalized findings with stable
fingerprints (rule, severity, location, package/resource and artifact details)
while their complete stdout/stderr is retained as a retrievable evidence
artifact. OPA receives the effective logical agent, role, profile, domains,
risk, runtime, model alias, permissions, changed files and deterministic
evidence; it does not receive a fabricated fixed worker identity.

Provenance manifests hash the control-plane snapshot, TaskContract/seal,
OpenSpec source references, operation/report/evidence artifacts, final output
and SBOM when present. Generated Cosign bundles have an explicit verification
step; a bundle that cannot be verified is not accepted as provenance.
