# Context efficiency

AEH reduces context cost through a deterministic pipeline:

```text
RETRIEVE -> SELECT -> PROJECT -> BUDGET -> COMPRESS -> DELIVER -> RETRIEVE ORIGINAL ON DEMAND
```

The `ContextBudgetGateway` is the preparation authority at the controller-to-agent boundary. It is transport-independent and runs before Paseo, direct or Podman dispatch. `StructuredResultGateway` remains the separate authority for accepted structured output leaving an agent.

The production prompt path creates typed fragments before rendering: execution
envelope, agent charter, frozen skills, normative contract/seal/source,
assignment, operation projection, RepoMap, advisory memory and evidence
references. Normative fragments remain byte-for-byte `VERBATIM`; the charter is
not used as a single catch-all fragment. RepoMap construction is skipped when
the selected execution contract forbids it. Transport capabilities are carried
into preparation so a direct Codex or hardened Podman turn never advertises a
retrieval tool it cannot expose.

Context requirements are explicit per agent: `REQUIRED`, `OPTIONAL` or
`FORBIDDEN` for repository-map, semantic retrieval, raw retrieval and
compression. Project-level `semanticRetrieval.required: true` is therefore
scoped by the routed execution contract. Coordinators/supervisors default to
`FORBIDDEN` for repository and raw semantic context; reviewers and workers may
require Serena when their runtime/transport can actually project it. The same
resolved capability result controls readiness, MCP injection, prompt policy
and degradation diagnostics.

## Preservation classes

- `VERBATIM`: exact normative requirements, contracts, schemas, hashes, anchors and critical diagnostics. It cannot be lossy-compressed.
- `PROJECTABLE`: typed deterministic summaries of validation, audit, operation and structured-agent artifacts. The raw artifact and SHA-256 remain available.
- `COMPRESSIBLE`: non-authoritative logs, repetitive tool output and generated metadata eligible for local Headroom compression.
- `RETRIEVABLE`: compact references to source bodies, complete logs and other material that can be fetched through an authorized artifact ID.
- `DISCARDABLE`: passing noise and duplicated progress detail.

Unknown classes fail validation; they do not default to lossy compression.

## Providers and authority

Serena is the configured local semantic repository provider when enabled. It is used for symbol lookup, overviews, references and targeted retrieval. Graphify remains the macro topology provider, and Engram remains historical memory authority. Serena memory features and editing are not used as AEH authority.

Headroom is the mandatory local compression provider. AEH starts and configures it where runtime integration is needed, but Paseo continues to own bounded agent lifecycle. AEH never uses `headroom wrap` as a second process manager. Headroom cannot mutate control-plane files, learn rules, rewrite structured JSON or compress normative fragments.

Both tools are free/local OSS dependencies pinned in `templates/toolchain.yaml`: Serena `1.6.1` (`serena-agent`) and Headroom `0.28.0`, using the managed Python/uv toolchain. Serena's documented `start-mcp-server` command is used; no paid hosted service is required.

## Budgets and retrieval

Budgets are role- and phase-aware. New projects default to `enforce`; `observe` computes the same decisions and metrics while delivering the unoptimized baseline for evaluation. Retrieval is bounded by request, per-request token and per-turn token limits. `aeh_context_retrieve` accepts only an already-authorized fragment ID; absolute paths, traversal and cross-operation access are rejected, and source hashes are verified.

Envelopes carry operation, agent, phase, budget, fragment projections, allowed retrieval IDs and a provenance hash. Large bodies are persisted as `.harness/context/<operation>/...raw`; envelopes contain references and compact content, not lifecycle authority.

### Informational fast path

Repository-grounded explanations use the same separation without creating an
engineering operation. `aeh_informational_context` selects a bounded set of
repository files and returns claims, summaries, direct repository-relative
source refs, provenance and payload estimates. It does not write evidence,
telemetry, operations, contracts or other `.harness` artifacts. Source bodies
are not placed in `structuredContent` or replayed in `human`. The lead can call
`aeh_informational_evidence` for one explicit
`repo://...#sha256=<chunk>&file-sha256=<file>&range=<start>-<end>` reference
when a summary is insufficient. A later bounded range can be requested by
adding `&read=<start>-<end>` while retaining the original selected chunk and
file identity. Retrieval verifies the whole file with a streaming hash and
the selected chunk, retains only bounded returned bytes, and carries the
requested excerpt once while structured metadata remains compact. Stale,
forged, traversal and repository-escape references fail explicitly. Legacy
range-only refs remain readable but cannot authorize a later range.

Informational defaults are centralized at an 8K target, 12K soft limit and 15K
exceptional limit, with eight source candidates, a 4KB per-source initial read
limit and a 20KB total initial read limit. Projection and deduplication run
before injection. Telemetry names the quantities it can actually measure:
`rawEvidenceTokens`, `legacyPayloadTokens`, `projectedPayloadTokens`,
`informationalPayloadTokens` and `duplicatePayloadTokensAvoided`. These are
deterministic estimates of repository evidence and serialized payloads; they
are not claims about actual lead-provider token usage. Source-code strings such
as PASS/FAIL/WARN/security/uncertainty are summarized as implementation text,
not promoted to verified runtime findings. Typed validation artifacts retain
their separate authoritative evidence path.

## Runtime and troubleshooting

Run `aeh doctor` after `aeh init --setup`. Doctor reports the gateway,
estimator, retrieval gateway, Serena and Headroom independently. Operation
readiness is evaluated again after routing, against the concrete runtime and
transport; a project-level required provider does not block a role whose
contract forbids or does not require that capability. A required capability
for a selected worker/reviewer fails closed before materialization; an
optional capability records an explicit bounded fallback. `--help`,
`--version` and status inspection do not install tools.

Context telemetry emits numeric/hash-only events including `harness.context.prepare`, `project`, `compress`, `deliver` and `operation_summary`. It intentionally does not emit prompt bodies. Evaluation should compare baseline/observe and optimized/enforce with the same task, repository, model and provider, and report cost per successful operation rather than tokens removed alone.
