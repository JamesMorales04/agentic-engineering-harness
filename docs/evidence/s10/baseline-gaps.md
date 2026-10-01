# S10 Baseline Gap Reproduction (pre-S10)

- Repository: `agentic-engineering-harness`, commit `0afebcd` (`core-v2: complete S9 runtime supervision and control center`), branch `core-architecture-v2`.
- Worktree: `/home/james/.paseo/worktrees/0jx5pvzi/s10-baseline-gaps` (isolated, clean).
- Host: Linux `6.18.52-1-cachyos-lts`, user `james` (uid 1000, supplementary group `docker`).
- Scope: read-only probes. The only repository change is this file.
- Environment caveat: this worktree has no `node_modules`, so `./node_modules/.bin/vitest ...` exits 127. The vitest run was therefore repeated in a `/tmp` mirror of this exact commit with the main checkout's `node_modules` symlinked in (note: the main checkout is also at `0afebcd` and its `package-lock.json` sha256 prefix `865923e4711aa763` is identical). The worktree itself was not written to.

## Findings

| # | Item | Command | Decisive output | Verdict |
|---|------|---------|-----------------|---------|
| 1 | Provider availability | `command -v bwrap opa podman buildah crun runc opengrep semgrep trivy unshare newuidmap; bwrap --version; podman --version; opa version; uname -r; sysctl kernel.unprivileged_userns_clone; sysctl kernel.apparmor_restrict_unprivileged_userns; ls /proc/sys/kernel/seccomp/; id` | present: `/usr/bin/bwrap`, `/usr/bin/runc`, `/usr/bin/unshare`, `/usr/bin/newuidmap`; missing: `opa`, `podman`, `buildah`, `crun`, `opengrep`, `semgrep`, `trivy`; `bubblewrap 0.13.0`; `kernel.unprivileged_userns_clone = 1`; apparmor userns sysctl file absent; seccomp `actions_avail`, `actions_logged`; `uid=1000(james) ... 954(docker)` | Userns/bwrap available; no OCI engine, no OPA, no SAST tools installed |
| 2 | Rootless sandbox wiring | `rg -n "podman\|bwrap" src/security src/workers` | `src/security/sandbox.ts:27` default provider `podman`; `sandbox.ts:32` forces `transport: "podman"`; `src/workers/agentPrompt.ts:768` `["podman","run", ...]`; `agentPrompt.ts:782` `runExecutable(args[0]!)`; `src/workers/podman.ts:13` `commandExists("podman")` only in `doctor()`. `rg -n "bwrap\|unshare\|namespace" src/` matches only an Engram `--namespace` (no sandbox use) | No. The only execution path shells out to `podman run`; with Podman absent the spawn fails (ENOENT). No bwrap/rootless fallback and the `commandExists("podman")` probe is used only by diagnostics, not execution |
| 3 | Isolation test exercised? | `./node_modules/.bin/vitest run tests/architecture-close.test.ts --reporter=dot` | `./node_modules/.bin/vitest: No existe el fichero o el directorio` (exit 127); mirror run: `Test Files 1 passed (1)`, `Tests 5 passed (5)`, `Duration 1.63s`; `rg -n "spawn\|exec\|runExecutable\|runShell\|commandExists" tests/architecture-close.test.ts` returns nothing | Only policy decisions and `hardenedPodmanArgs` argument arrays are asserted; no isolation provider is ever started |
| 4 | Validator isolation | `rg -n "runShell\(\|spawn\(\|runExecutable\(" src/validators src/providers/validation` | `toolCommand.ts:9`, `external.ts:27`, `opa.ts:32`, `commands.ts:7`, `providerUtils.ts:29` all call `runShell`; `process.ts:40-44` `runShell` -> `spawn(command, [], { shell: true, ... })`; `rg -n "bwrap\|sandbox\|namespace\|unshare" src/validators src/providers/validation` returns nothing | Validator commands run as host child processes via `spawn` with `shell: true`; no namespace/sandbox boundary is applied |
| 5 | SAST evidence candidate-bound? | `rg -n "sast\|SastEvidence\|candidate" src/validators/types.ts src/validators/external.ts`; `rg -n "candidate" src/validators/` | `ValidationContext` (`src/validators/types.ts:3-11`) has only `root/config/contract/spec/providerSpec/baseRef/changedFiles`; `src/validators/` matches only a local variable `candidates` in `toolEvidence.ts:73`; `external.ts:32` `rawPath = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence", `${context.spec.id.replace(/[^A-Za-z0-9._-]/g, "-")}.raw`)` | No candidate identity input and no candidate-scoped artifact; the raw SAST artifact is named only by validator `spec.id` (e.g. `.harness/evidence/<specId>.raw`) |
| 6 | Missing required tool probe | `/home/james/Desarrollo/agentic-engineering-harness/node_modules/.bin/tsx /tmp/opencode/s10-missing-tool-probe.ts` (imports `runExternalToolValidator` from this worktree; adapter `opengrep`, `required: true`, no command, temp root) | `{"status":"FAIL","message":"opengrep is not installed; the required validator cannot run."}` | Behavior report only (per task): a missing required external tool yields a deterministic `FAIL` check |
| 7 | OPA executable evaluation | `ls -la policies/core/trust-boundary.rego`; `if command -v opa; then opa eval ...; fi` | `policies/core/trust-boundary.rego` exists (27 lines, `package harness.trust_boundary`, three `deny` rules); `SKIP: command -v opa failed (opa not installed)` | OPA cannot be evaluated at this commit in this environment; `src/validators/opa.ts:26` would deterministically return `FAIL` if OPA were enabled |

## Raw evidence excerpts

### 2) Only Podman, never executed through a provider abstraction

```
src/security/sandbox.ts:27:  const provider = sandbox?.provider ?? "podman";
src/security/sandbox.ts:32:  ... selection: { ...selection, transport: provider === "podman" ? "podman" : selection.transport } };
src/workers/agentPrompt.ts:768:  const args: string[] = ["podman", "run", ...hardenedPodmanArgs(...)];
src/workers/agentPrompt.ts:782:  const result = await runExecutable(args[0]!, args.slice(1), ...);
src/workers/podman.ts:13:    const ok = await commandExists("podman", root);
```

`rg -n "bwrap|unshare|namespace" src/` has no bwrap/namespace sandbox usage at all (only `src/providers/engram.ts:48` `--namespace`).

### 3) Test file inspection

`tests/architecture-close.test.ts` is 73 lines. The only sandbox test asserts:

```
const decision = enforceSandboxPolicy(selection, config, "high");
expect(decision.selection.transport).toBe("podman");
const args = hardenedPodmanArgs(config, decision.selection, true);
expect(args).toContain("--read-only");
expect(args).toContain("--cap-drop=ALL");
...
expect(() => hardenedPodmanArgs(config, selection, true)).toThrow("extraArgs is disabled");
```

No `spawn`/`exec`/`runExecutable`/`runShell`/`commandExists` appears in the file; nothing launches `podman`, `bwrap` or any other provider.

### 4) Validator execution sites

```
src/validators/toolCommand.ts:9:  const result = await runShell(rendered, { cwd, timeoutMs: ... });
src/validators/external.ts:27:    const result = await runShell(rendered, { cwd, timeoutMs: ... });
src/validators/opa.ts:32:         const result = await runShell(command, { cwd: root, timeoutMs: 30_000 });
src/validators/commands.ts:7:        const result = await runShell(command.command, { ... });
src/providers/validation/providerUtils.ts:29:  const result = await runShell(plan.command, { cwd: plan.cwd, ... });
```

`runShell` delegates to `runChild(command, [], true, options)` and `spawn(command, args, { shell: true, env: inherited, detached: true, ... })` in `src/utils/process.ts:47-79` with only `AEH_*` variables stripped. No mount/user/net namespace, no seccomp, no container boundary is configured.

### 5) Raw artifact path expression (`src/validators/external.ts:32`)

```
const rawPath = path.resolve(context.root, context.config.evidence?.outputDir ?? ".harness/evidence", `${context.spec.id.replace(/[^A-Za-z0-9._-]/g, "-")}.raw`);
```

Note: `src/core/types.ts:230` allows `candidate?` / `candidateWorkspaceIdentity?` on the aggregate `ValidationReport`, but neither is an input to `ValidationContext` nor used by `runExternalToolValidator`.

## S10 baseline gap summary

Unmet at this commit (`0afebcd`):

1. **No rootless sandbox execution provider is wired.** The single hardened path is `podman run`; `podman` is absent and there is no bwrap/other-provider fallback (items 1, 2).
2. **Isolation is asserted, never exercised.** The only sandbox test checks policy decisions and Podman argument arrays; no isolation provider is executed (item 3).
3. **Validator commands are not isolated.** All validator/adapter commands execute via `runShell` -> host `spawn` with `shell: true`; no namespace or sandbox boundary (item 4).
4. **SAST/external evidence is not candidate-bound.** `ValidationContext` has no candidate identity and `rawPath` is scoped only by validator `spec.id` (item 5).
5. **OPA executable evaluation is unavailable.** `policies/core/trust-boundary.rego` exists, but `opa` is not installed, so `opa eval` is skipped; `src/validators/opa.ts:26` is the deterministic fail-closed path (item 7).

Verified at baseline (not a gap): a missing required external tool produces a deterministic `FAIL` check with the message `opengrep is not installed; the required validator cannot run.` (item 6). The environment also lacks `opengrep`, `semgrep` and `trivy`, so real SAST evidence cannot be produced here regardless.

### Commands that failed for environment reasons

- `./node_modules/.bin/vitest run tests/architecture-close.test.ts --reporter=dot` -> exit 127 (worktree has no `node_modules`).
- `podman --version` -> `podman: orden no encontrada`.
- `opa version` / `opa eval` probe -> `opa` not installed; `opa eval` intentionally skipped.
- `sysctl kernel.apparmor_restrict_unprivileged_userns` -> sysctl file does not exist.
