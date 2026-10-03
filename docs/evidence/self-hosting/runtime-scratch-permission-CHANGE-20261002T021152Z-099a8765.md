# Self-hosting temporary-path permission diagnosis

**Operation:** `CHANGE-20261002T021152Z-099a8765`

**Operation result:** `FAILED` at `2026-10-02T02:56:59.926Z`

**Repair base:** `853998fb55463d0d0974e1a5fd7323b263e1bf73`
**Core Architecture V2 SHA-256:** `4954b62bfb3a820fc6e5d0369b2d37bc35a94988d19e485f00d30675aafa555a`

## Root cause

**Classification: MODEL-selected path; deterministic provider policy correctly denied it.** The Implementer independently selected `/tmp/aeh-consumer-probe` while debugging a failed browser-test fixture. Its OpenCode `bash` call was:

```sh
rm -rf /tmp/aeh-consumer-probe && npm run aeh -- init /tmp/aeh-consumer-probe 2>&1 | tail -25
```

The request was issued by OpenCode session `ses_f058f558dfferbBFIIa1vaVgxI`, Paseo agent `409ae066-9d85-4bc9-a3fc-8703a1c2cb89`, AEH participant `participant:home-content`, role `Implementer`, during `implementation`. The call requested shell write/delete access to the unrelated path `/tmp/aeh-consumer-probe`; the subsequent `init` would also create files there. The OpenCode transcript records `Tool execution aborted` at `02:41:22.458Z`; AEH/Paseo recorded an unapproved `external_directory` permission for `/tmp/*` and terminated the session at `02:41:24.505Z`.

The participant had current `read`, `write`, and `execute` leases for candidate `r3` (`243c11544c237e3fb0e7ade2abef469ab7877c68a58cac4c9571764102763788`), expiring at `02:57:54.896Z`. Those leases did not authorize arbitrary host temporary paths and carried no scratch-path scope. The provider's external-directory projection was restricted to the participant launch root and its Git metadata roots. `/tmp/aeh-consumer-probe` was a sibling outside that envelope, so it was not pre-authorized. No tool requirement or sealed product requirement called for that specific directory. A private participant scratch directory would have supported the optional probe without granting access to unrelated `/tmp` entries.

The OpenCode launch record contained no `TMPDIR`, `TEMP`, or `TMP` override. It did set `auto_accept=true` because the compiled permission decisions contained no `ask`; this did not grant the unprojected external directory, and the provider still stopped. No blanket permission was approved.

## Planner and causal timeline

| Time (UTC) | Evidence |
|---|---|
| 02:22:33–02:24:56 | Planner Codex session `01a0fa6b-a4e0-7283-9185-ae684f64a9df` completed. Its recorded calls were context retrieval and structured-result submission; no `/tmp` access appears in its transcript. |
| 02:25:18–02:27:52 | Second Planner Codex session `01a0fa6e-2750-7801-981c-e4ab23004ba2` completed with structured-result calls and no `/tmp` access. Both ran with `approval_policy=never`, `sandbox_mode=read-only`. |
| 02:28:04 | Implementer OpenCode session started in `/tmp/aeh-CHANGE-20261002T021152Z-099a8765-home-content-DD5wHN`; its launch had no participant-owned scratch or temp environment projection. |
| 02:40:43–02:41:07 | Browser E2E ran and failed during disposable consumer initialization. This was before the blocked probe. |
| 02:41:18–02:41:24 | The Implementer independently chose `/tmp/aeh-consumer-probe`; provider permission failed closed. |
| 02:41:24.802 | The operation's `planning` stage recorded the same normalized permission error at the Implementer failure timestamp. `src/core/run.ts` marks this broad stage failed from the aggregate `executePlannerWaves` result, which also includes work-unit execution. The two actual Planner sessions had already completed, and no third Planner session or Planner `/tmp` call is present in the durable participant/session records. The stage label is therefore not evidence of a separate Planner permission request. |
| 02:56:59 | AcceptanceOracle rejected insufficient browser/visual evidence; the operation terminalized `FAILED`. Delivery did not occur. |

The browser output directory `/tmp/aeh-s9-playwright-output` still exists, but it is a fixed, non-operation-scoped test-output path absent from the operation resource ledger. It is classified `UNKNOWN_OR_UNOWNED` for this operation and was left untouched. The persisted AcceptanceOracle disposition is `REJECTED`; browser and visual validation evidence is `FAIL`/missing, as are required independent Reviewer and Lead evidence. The operation remained `FAILED`; no delivery action occurred.

## Resource census

The operation reconciliation receipt reports 22 terminal-owned resources, zero live-owned resources, zero remaining terminal orphans, zero unknown resources, `cleanupComplete=true`, and no errors. It archived the operation workspace and participant/supervisor sessions, terminated the managed controller process, and removed both registered `aeh-direct-*` staging roots. The original operation branch `aeh/op-change-20261002t021152z-099a8765` remains at the base commit `13f76b6fe110330af05f8b8221ff4b1759f319d5`; the original user request explicitly prohibited branch deletion, so it was preserved. No original-operation Git worktree remains registered.

## Required repair direction

Compile a controller-owned, participant-scoped scratch resource for roles whose frozen tool/authority profile requires writable temporary storage. Bind its exact identity to the operation, candidate, controller epoch, participant, and execution generation; issue path-scoped authority; project only that resource into the runtime; set `TMPDIR`, `TEMP`, and `TMP`; and register it for terminal reconciliation. Keep unrelated `/tmp` paths outside the provider sandbox. This is an implementation of the existing frozen-blueprint, bounded-authority, resource-ownership, and fail-closed invariants; the normative architecture document remains unchanged.
