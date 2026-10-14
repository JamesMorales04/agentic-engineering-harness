# Phase D complete — L1 + wire merged — 2026-10-14B

## Deliveries

| PR | Branch head | Reviewer path | CI | Merge |
| --- | --- | --- | --- | --- |
| #173 L1 preflight gate | `2051138` | R3 REJECT(2H+3M) → repair → R4 REJECT(3H+3M) → repair → R5 REJECT(1M layer-schema) → repair → R6 ACCEPT, no findings | 14/14 SUCCESS | `9fdb753` MERGED |
| #174 wire schema parity | `fd8de96` | R1 REJECT(P1 strict) → repair → R2 REJECT(P1 root-anyOf + round-trip) → P1b fix + P1a decision → R3 REJECT(P1 unwired fallback + P2 infers) → repair → R4 REJECT(P1 Paseo leak) → repair → R5 REJECT(P2 stale record) → doc fix → R6 ACCEPT | 14/14 SUCCESS | `a59a664` MERGED |

`origin/main` = `a59a664` (v0.26.0 release `f7e1c99` sits between the two merges).

## Family status changes

- FAM-WIRE: CLOSED (strict-required coverage 100%, round-trips proven, strict-channel
  projection on Codex + all Paseo sinks, Zod authoritative receipt, documented
  root-anyOf deviation with pin test). Residual: NONE open — deviation is explicit,
  reviewed, Owner-visible in REVIEW_ROUNDS_R4_R5_P1A_2026-10-14.md.
- FAM-SKILLREF core: CLOSED (compiler accepts seed IDs + filesystem; L1 C1/C2/A2 genuine
  PASS on real tree). Residual checker-parity: L1 and compiler must stay aligned as both
  evolve — L1 is now the preventive control, no separate repair open.
- FAM-PROMPT / FAM-REACH / FAM-ROUTE: CLOSED via #171 (Phase C record).
- FAM-CEIL + specialization: CLOSED via #172 (Phase C record).
- FAM-EVID / FAM-HERMETIC: CLOSED via #169/#170 (prior session).
- OPEN → Phase E: FAM-WAVE (parallel-writer FS isolation), FAM-LIVE (participant
  deadlines/liveness incl. Paseo permission-wait), FAM-MERGE (merge authority/audit).

## L1 gate is now the preventive control

`scripts/preflightL1.mjs` (12 checks) runs in main. Phase E repairs must keep it green
and extend it where new families yield static-detectable invariants (e.g. WAVE
single-writer plan markers, MERGE human-effect enumeration, skill checker parity).

## Next (Phase E)

Re-scope WAVE/LIVE/MERGE against new main (`a59a664`: planning coherence, assurance
gates, strict projections all change the touched code). Read-only bounded Explorer first,
then one repair family at a time with the established worker→Luna→CI→merge loop.
L5 Home experiment stays blocked pending L1–L4 + Owner self-hosting charter.
