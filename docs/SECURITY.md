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

## Executed isolation provider (S10)

`security.isolation.required: true` selects the deterministic rootless isolation
provider (`bwrap`) for validator and external-tool commands. The provider runs
each command in real user, mount, PID, UTS, IPC and network namespaces over a
minimal read-only host root (`/usr`, `/etc`, `/bin`, `/lib*`, `/sbin`, plus
explicit toolchain binds derived from `PATH` and the running Node executable).
The repository is read-only; only declared writable paths (the evidence
directory, or the workspace for project test commands) are bound read-write.
The host home, root, run, tmp, var/tmp, mnt, media and srv paths are not
projected; the environment is cleared and rebuilt from an allowlist with
`HOME`/`TMPDIR` pointing at sandbox scratch. Network is denied unless
`security.isolation.network: true`.

Missing or unsupported providers fail closed with an explicit
`ISOLATION_PROVIDER_UNAVAILABLE` or `ISOLATION_PROVIDER_UNSUPPORTED` blocker;
a required validator is never executed outside the boundary and never reported
as a silent SKIP or PASS. Rootless Podman/OCI execution remains a separate
provider lane and is not provisioned in every environment; when it is absent
the hardened Podman worker path fails its `doctor` check rather than degrading.

Security validators (`opengrep`, `trivy`) additionally persist candidate-bound
`SastEvidenceV1` when a current CandidateRevision is available: the artifact
binds the exact candidate identity and workspace source digest, tool version,
command digest, raw-output digest, normalized findings, and the isolation
evidence, and it is verified by digest before the S4 security impact path
accepts it. Stale, tampered, missing, or workspace-drifted evidence blocks.

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
