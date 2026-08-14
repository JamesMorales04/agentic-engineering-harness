# Observability

The harness writes local NDJSON lifecycle events under `.harness/telemetry/`
and creates OpenTelemetry spans through the OTel API. Events belonging to one
operation share one trace ID; each phase/provider event is a child span with a
bounded parent span ID. Prompt bodies, source bodies and raw tool output are
never telemetry attributes. OTLP/HTTP export remains optional and local NDJSON
is retained when no collector is configured.

Recommended task metrics:

- deterministic success rate;
- first-pass success rate;
- repair attempts;
- human interventions;
- scope and architecture violations;
- lead/worker token consumption (when available from provider telemetry);
- wall-clock duration;
- validation duration;
- memory retrieval/usefulness;
- cost when available.

A later collector/exporter integration can forward OTel data to any compatible open-source or hosted backend without changing core logic.
