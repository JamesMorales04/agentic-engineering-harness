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

## Efficiency observations (V2)

When `telemetry.enabled` is true, AEH writes versioned participant, context,
tool-call, and operation-summary JSON/NDJSON records under
`.harness/telemetry/efficiency/`. This remains local and works with
`telemetry.exporter: none`; no collector, hosted service, or paid dependency is
required. Consumers may leave telemetry disabled.

`ParticipantUsageObservationV1` prefers per-turn structured provider usage,
then Paseo's structured agent usage snapshot/adapter data, then the existing
AEH usage extractor. Missing fields remain `null`. `usageKnown` and
`usageCoverage` distinguish a complete participant total from a partial
snapshot or extracted fragment. Paseo currently exposes input, cached input,
output and cost on completed turns, but does not expose reasoning tokens or a
provider-reported total-token field; AEH records reasoning as unknown and marks
`totalTokensBasis: INPUT_PLUS_OUTPUT` when it derives that sum. A context-window
snapshot is never treated as provider billing usage. Text extraction is
explicitly tagged and is not described as provider-native.

The operation summary deduplicates repeated per-turn history by provider turn
identity. When only aggregate snapshot/adapter observations are available for
the same participant generation and runtime session, it keeps the latest value
and marks coverage partial because the provider does not identify whether each
snapshot is cumulative or incremental. `usage.byParticipant` retains the
participant-level totals needed for token-share KPIs.

`ContextAccountingObservationV1` joins the operation and participant identity
to `rawContextTokens`, `projectedContextTokens`, `deliveredContextTokens`, and
retrieval receipts. These are deterministic AEH estimator values. They are
useful for comparison with provider input tokens, but the two measures are not
equivalent. Cross-participant repeated-fragment tokens are derived from
fragment IDs, content digests, and AEH-delivered token estimates; no fragment
body is copied into the efficiency records. Retrieved fragments contribute
their own content identity and estimator count; multiple fragments returned by
one retrieval request count as one request.

The Paseo adapter reads its structured timeline subscription and canonical
timeline projection. The normalizer accepts `tool_call` items with optional
call ID, name, status, detail, provider, turn ID, timestamp, and sequence, plus
`turn_completed` usage events. AEH captures these structured events and stores
only tool identity, normalized-argument digest/byte length, times, result byte
length, error fingerprint, outcome, and a proven retry link. Raw arguments,
tool output, prompts, and error text are not persisted. A retry is linked only
when an earlier equivalent call failed in the same session, phase, and known
provider turn with a call ID. Calls without IDs or known turn identity retain
`UNKNOWN` retry causality.

`retryAssociatedInputTokens`, `retryAssociatedOutputTokens`, and
`retryAssociatedTotalTokens` summarize provider usage observed on turns that
contain a proven retry call. They do not claim tokens were caused exclusively
by the tool. A tool failure without a proven retry does not attribute usage to
later turns. If per-turn provider usage is unavailable, these fields remain
unknown.

`OperationEfficiencySummaryV1` is derived from these local observations after
terminalization. It has no callers in routing, assurance, validation,
acceptance, delivery, `ToolActionGate`, or `ObjectiveCompletion`. Recording or
forging an observation cannot pass a gate or grant an effect. The Control
Center's operation detail may expose this summary read-only; it adds no action
surface. KPI denominators should use the explicit known-usage/causality coverage
and leave cost-per-accepted-operation unavailable when provider cost is unknown.

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
