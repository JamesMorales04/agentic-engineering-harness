# Observability

The harness writes local NDJSON lifecycle events under `.harness/telemetry/`
and creates OpenTelemetry spans through the OTel API. Events belonging to one
operation share one trace ID; each phase/provider event is a child span with a
bounded parent span ID. Prompt bodies, source bodies and raw tool output are
never telemetry attributes. OTLP/HTTP export remains optional and local NDJSON
is retained when no collector is configured.

Memory, telemetry, logs, and evals are **observations, not learning or
authority**. No policy, authority, acceptance, permission, or routing decision
consumes telemetry or eval output; the deterministic guard
`src/evals/advisoryInvariant.ts` and `tests/evals/advisoryInvariant.test.ts`
prove the boundary.

## Correlation identity (S12)

Every operation-bound event, span, and metric point carries the canonical
`TelemetryCorrelationV1` identity from `src/telemetry/identity.ts`:

- `aeh.operation.id`, `aeh.candidate.id`, `aeh.candidate.revision`,
  `aeh.candidate.source_digest`, `aeh.candidate.identity_digest`,
  `aeh.execution.revision`, `aeh.policy.digest`, `aeh.controller.epoch`,
  `aeh.participant.id` / `generation` / `role`, `aeh.runtime.name` /
  `aeh.runtime.session.id`, and `aeh.build.release.id` / `aeh.build.digest`.
- `aeh.telemetry.correlation.digest` is a domain-separated SHA-256 over the
  defined fields. The same digest appears on the local NDJSON record, the OTLP
  span attributes, and the local metric point attributes, so joins are stable
  and identity-bound.
- `recordEvent` resolves the current durable operation identity at emission
  time. A caller-supplied identity that does not match current durable truth is
  recorded with an explicit `TELEMETRY_IDENTITY_MISMATCH` violation instead of
  being silently re-attributed; an unresolvable identity is recorded as
  `TELEMETRY_IDENTITY_UNRESOLVED`. Stale candidate, revision, execution
  revision, policy, epoch, participant, and session attribution are all
  detectable with `verifyTelemetryCorrelation`.

## Metrics

`src/telemetry/metrics.ts` uses real OpenTelemetry counters and histograms:

- `aeh.operation.count`, `aeh.operation.duration`
- `aeh.participant.launch.count`, `aeh.participant.result.count`,
  `aeh.participant.turn.duration`
- `aeh.runtime.session.count` (materialized / reused / rotated)
- `aeh.validation.run.count`, `aeh.validation.duration`

Instruments are wired at the production run finish, participant lifecycle,
Paseo session binding, and validation finish. The local exporter serializes
canonical, sorted snapshots to `.harness/telemetry/metrics.ndjson`; export
needs no hosted credential and a fixed scenario with a fixed candidate identity
produces reproducible values (`metricsSnapshotDigest`).

Metric recording verifies a caller-supplied correlation against current durable
operation truth before recording: a mismatch records nothing, so a stale
correlation cannot be silently attributed (`tests/telemetry/metrics.test.ts`
covers both the rejected stale and the accepted current correlation). A
detached observation with no resolvable durable operation keeps the supplied
identity and is explicitly unverified; production call sites always derive the
correlation from the current durable operation and record nothing when it is
unresolvable.

## Export lanes

- **Local file/NDJSON (default):** `.harness/telemetry/events.ndjson` and
  `.harness/telemetry/metrics.ndjson`. Always available, credential-free.
- **Local OTLP/HTTP (verified):** when `telemetry.exporter: otlp-http-json`
  and an endpoint are configured, the official OTel exporter sends OTLP/HTTP
  JSON. `tests/helpers/otlpReceiver.ts` starts an in-process loopback receiver
  and verifies payload path, content type, resource identity, trace-ID
  correlation, and the correlation digest. This is local loopback evidence, not
  a hosted collector and not REAL_PROVIDER certification.
- A collector may forward OTel data to any compatible open-source or hosted
  backend without changing core logic; `aeh init` installs a minimal OSS
  collector configuration at `.harness/otel-collector.yaml`.

## Advisory engineering evals

The versioned corpus lives in `evals/corpus/` (manifest `corpus.json`, one
`eval.yaml` per case) with fixed fixtures in `evals/fixtures/` and deterministic
scenario harnesses in `evals/scenarios/`. Cases cover deterministic validation
(pass and fail-closed), work-decomposition/scope governance, progressive
context projection, and review-convergence thresholds. The runner records the
corpus identity (`corpusId`, `corpusVersion`, `digest`, per-case `caseDigest`)
on every result, and scoring is deterministic for a fixed scenario. Eval output
is advisory: it never mutates policy, authority, acceptance, permissions, or
routing, and no acceptance gate consumes it.

Recommended task metrics remain: deterministic success rate; first-pass
success rate; repair attempts; human interventions; scope and architecture
violations; lead/worker token consumption (when available from provider
telemetry); wall-clock duration; validation duration; memory retrieval
usefulness; and cost when available.
