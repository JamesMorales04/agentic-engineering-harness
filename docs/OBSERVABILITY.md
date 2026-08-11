# Observability

The harness writes local NDJSON lifecycle events under `.harness/telemetry/` and creates OpenTelemetry spans through the OTel API.

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
