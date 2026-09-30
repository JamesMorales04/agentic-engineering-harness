import fs from "node:fs/promises";
import path from "node:path";
import { recordEvent } from "../telemetry/events.js";
import { resolveContextBudget } from "./budget.js";
import { canLossyCompress, classifyFragment, isRequired as isRequiredFragment } from "./classifier.js";
import { estimateBytes, estimateTokens } from "./estimator.js";
import { buildContextEnvelope, renderContextEnvelope } from "./envelope.js";
import { resolveContextPolicy } from "./policy.js";
import { sha256 } from "./provenance.js";
import { projectAudit, projectDiff, projectExplorer, projectOperation, projectPlanner, projectSource, projectValidation } from "./projectors/index.js";
import { HeadroomCompressionProvider } from "./compression/headroom.js";
import { recordContextMetrics } from "./telemetry.js";
export class ContextBudgetGateway {
    root;
    config;
    compressor;
    persist;
    telemetry;
    constructor(root, config, options = {}) {
        this.root = root;
        this.config = config;
        const provider = config.context?.compression?.provider ?? "headroom";
        this.compressor = options.compressor ?? (provider === "headroom" ? new HeadroomCompressionProvider(config.context?.compression?.command ? { command: config.context.compression.command } : {}) : undefined);
        this.persist = options.persist ?? true;
        this.telemetry = options.telemetry ?? true;
    }
    async prepare(request) {
        const policy = resolveContextPolicy(this.config);
        const role = request.role ?? request.logicalAgent;
        const budget = resolveContextBudget(this.config, role, request.phase);
        const durable = await Promise.all(request.fragments.map((fragment) => this.persistRawFragment(request.operationId, fragment)));
        const rawBytes = durable.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
        const rawTokens = durable.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0);
        const candidates = [];
        for (const fragment of durable) {
            classifyFragment(fragment);
            const optimized = await this.optimizeFragment(fragment, request.operationId, policy.compression.minTokens, request.capabilities?.authorizedRetrieval !== false, policy.compression.reversible, policy.compression.required, role);
            candidates.push({ raw: fragment, optimized });
        }
        const enforced = policy.mode === "enforce";
        const delivered = enforced ? selectWithinBudget(candidates.map((candidate) => candidate.optimized), budget.maxTokens - budget.reserved.response) : durable.map(projectSource);
        const deliveredIds = new Set(delivered.map((fragment) => fragment.id));
        const discarded = durable.filter((fragment) => !deliveredIds.has(fragment.id));
        const retrievalAvailable = request.capabilities?.authorizedRetrieval !== false;
        const envelope = buildContextEnvelope({ version: 1, operationId: request.operationId, logicalAgent: request.logicalAgent, phase: request.phase, budget: { maximum: budget.maxTokens, estimatedDelivered: delivered.reduce((sum, fragment) => sum + fragment.estimatedTokens, 0) }, fragments: delivered, retrieval: { available: retrievalAvailable, allowedFragmentIds: retrievalAvailable ? delivered.map((fragment) => fragment.id) : [] } });
        if (this.persist)
            await this.persistEnvelope(request.operationId, request.logicalAgent, request.phase, envelope);
        const rendered = renderContextEnvelope(envelope);
        const metrics = metricsFor(durable, candidates.map((candidate) => candidate.optimized), delivered, discarded);
        if (this.telemetry && this.config.telemetry?.enabled !== false)
            await this.emitTelemetry(request, metrics, envelope);
        return { envelope, rendered, metrics, retrieval: { root: this.root, operationId: request.operationId, logicalAgent: request.logicalAgent, allowedFragmentIds: [...envelope.retrieval.allowedFragmentIds] } };
    }
    async optimizeFragment(fragment, operationId, minCompressionTokens, authorizedRetrieval, reversibleRequired, compressionRequired, role) {
        const originalTokens = estimateTokens(fragment.content);
        if (isRequiredFragment(fragment))
            return projectSource(fragment);
        if (fragment.preservation === "DISCARDABLE")
            return { ...fragment, content: "", estimatedTokens: 0, originalTokens, projected: true };
        if (fragment.preservation === "RETRIEVABLE" && authorizedRetrieval) {
            const content = `[Retrievable ${fragment.kind} '${fragment.id}' (${originalTokens} tokens); use aeh_context_retrieve for the authorized raw artifact.]`;
            return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens, projected: true };
        }
        // Direct Codex and hardened Podman do not necessarily expose the AEH MCP
        // retrieval server. Deliver an equivalent bounded projection instead of
        // advertising a tool the transport cannot call.
        if (fragment.preservation === "RETRIEVABLE")
            return genericProjection(fragment);
        let projected;
        if (fragment.preservation === "COMPRESSIBLE")
            projected = genericProjection(fragment);
        else
            switch (fragment.kind) {
                case "validation":
                    projected = projectValidation(fragment);
                    break;
                case "audit":
                    projected = projectAudit(fragment);
                    break;
                case "operation":
                    projected = projectOperation(fragment);
                    break;
                case "diff":
                    projected = projectDiff(fragment);
                    break;
                case "source":
                    projected = projectSource(fragment);
                    break;
                case "repository-map":
                    projected = projectSource(fragment);
                    break;
                case "tool-output":
                    projected = genericProjection(fragment);
                    break;
                case "memory":
                    projected = genericProjection(fragment);
                    break;
                case "handoff":
                    projected = projectHandoff(role, fragment);
                    break;
                case "instruction":
                case "execution-envelope":
                case "agent-charter":
                case "skill":
                case "delivery":
                case "normative":
                    projected = projectSource(fragment);
                    break;
                case "raw-evidence":
                    projected = genericProjection(fragment);
                    break;
                default: projected = projectSource(fragment);
            }
        if (this.compressor && canLossyCompress(fragment) && originalTokens >= minCompressionTokens) {
            if (reversibleRequired && !authorizedRetrieval) {
                if (compressionRequired)
                    throw new Error(`CONTEXT_COMPRESSION_REVERSIBILITY_UNAVAILABLE: fragment '${fragment.id}' cannot be compressed without an authorized AEH recovery surface.`);
                return projected;
            }
            try {
                const sourceSha256 = fragment.source?.sha256 ?? sha256(fragment.content);
                const compression = await this.compressor.compress(this.root, { operationId, fragment, maxTokens: Math.max(1, Math.floor(originalTokens * 0.7)), sourceSha256, reversible: reversibleRequired });
                if (compression.compressedTokens < projected.estimatedTokens) {
                    const handle = reversibleRequired ? recoveryHandle(operationId, fragment.id, sourceSha256) : undefined;
                    return { ...projected, content: compression.content, estimatedTokens: compression.compressedTokens, compressed: true, compression: { provider: compression.provider, providerVersion: compression.providerVersion, reversible: Boolean(handle), handle } };
                }
            }
            catch (error) {
                if (this.config.context?.compression?.required !== false)
                    throw error;
                // Optional compression failure falls back to deterministic projection.
            }
        }
        return projected;
    }
    async persistRawFragment(operationId, fragment) {
        if (!this.persist)
            return { ...fragment, source: { ...fragment.source, sha256: fragment.source?.sha256 ?? sha256(fragment.content) } };
        const requested = fragment.source?.artifact ?? path.posix.join(".harness", "context", safeSegment(operationId), `${safeSegment(fragment.id)}.raw`);
        const contentSha256 = sha256(fragment.content);
        if (fragment.source?.sha256 && fragment.source.sha256 !== contentSha256)
            throw new Error(`Context source hash mismatch for '${requested}'.`);
        let relative = requested;
        let absolute = safePath(this.root, relative);
        await assertNoSymlinkEscape(this.root, absolute);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        const existing = await readArtifact(absolute);
        if (existing) {
            const actual = sha256(existing);
            if (fragment.source?.sha256 && fragment.source.sha256 !== actual)
                throw new Error(`Context source hash mismatch for '${relative}'.`);
            if (actual !== contentSha256) {
                // Fragment IDs are stable semantic labels, but their content is agent- and
                // phase-specific. Keep the legacy path for the first writer and derive a
                // deterministic content-addressed sibling for later implicit collisions.
                if (fragment.source?.sha256)
                    throw new Error(`Context source hash mismatch for '${relative}'.`);
                relative = disambiguatedArtifactPath(requested, contentSha256);
                absolute = safePath(this.root, relative);
                await assertNoSymlinkEscape(this.root, absolute);
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                const sibling = await readArtifact(absolute);
                if (sibling && sha256(sibling) !== contentSha256)
                    throw new Error(`Context source artifact collision for '${relative}'.`);
                if (!sibling && !(await writeArtifactIfAbsent(absolute, fragment.content)))
                    throw new Error(`Context source artifact collision for '${relative}'.`);
            }
        }
        else if (!(await writeArtifactIfAbsent(absolute, fragment.content))) {
            // Another writer won the legacy path between read and write. Re-read it and
            // use the same deterministic sibling path if its bytes differ.
            const winner = await readArtifact(absolute);
            if (winner && sha256(winner) === contentSha256)
                return { ...fragment, source: { ...fragment.source, artifact: relative, sha256: contentSha256 } };
            if (fragment.source?.sha256)
                throw new Error(`Context source hash mismatch for '${relative}'.`);
            relative = disambiguatedArtifactPath(requested, contentSha256);
            absolute = safePath(this.root, relative);
            await assertNoSymlinkEscape(this.root, absolute);
            await fs.mkdir(path.dirname(absolute), { recursive: true });
            const sibling = await readArtifact(absolute);
            if (sibling && sha256(sibling) !== contentSha256)
                throw new Error(`Context source artifact collision for '${relative}'.`);
            if (!sibling && !(await writeArtifactIfAbsent(absolute, fragment.content)))
                throw new Error(`Context source artifact collision for '${relative}'.`);
        }
        return { ...fragment, source: { ...fragment.source, artifact: relative, sha256: contentSha256 } };
    }
    async persistEnvelope(operationId, logicalAgent, phase, envelope) {
        const scoped = contextEnvelopePath(this.root, operationId, logicalAgent, phase);
        await fs.mkdir(path.dirname(scoped), { recursive: true });
        await fs.writeFile(scoped, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
        // Keep the historical path for offline consumers. Runtime retrieval is always
        // scoped by logical agent and phase through contextEnvelopePath.
        const legacy = safePath(this.root, path.posix.join(".harness", "context", safeSegment(operationId), "envelope.json"));
        await fs.mkdir(path.dirname(legacy), { recursive: true });
        await fs.writeFile(legacy, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    }
    async emitTelemetry(request, metrics, envelope) {
        const attributes = { operationId: request.operationId, logicalAgent: request.logicalAgent, phase: request.phase, envelopeSha256: envelope.provenance.sha256, rawBytes: metrics.rawBytes, projectedBytes: metrics.projectedBytes, deliveredBytes: metrics.deliveredBytes, estimatedRawTokens: metrics.estimatedRawTokens, estimatedDeliveredTokens: metrics.estimatedDeliveredTokens, deliveredFragments: metrics.deliveredFragments, compressedFragments: metrics.compressedFragments, discardedFragments: metrics.discardedFragments, projectionRatio: metrics.projectionRatio ?? 0, compressionRatio: metrics.compressionRatio ?? 0 };
        await recordEvent(this.root, this.config, "harness.context.prepare", attributes);
        await recordContextMetrics(this.root, this.config, envelope, metrics);
        await recordEvent(this.root, this.config, "harness.context.deliver", { ...attributes, retrievalAvailable: envelope.retrieval.available });
    }
}
export async function prepareContext(root, config, request, options = {}) {
    return new ContextBudgetGateway(root, config, options).prepare(request);
}
function selectWithinBudget(fragments, maxTokens) {
    const ordered = [...fragments].filter((fragment) => fragment.estimatedTokens > 0).sort((a, b) => Number(isRequiredProjection(b)) - Number(isRequiredProjection(a)) || b.priority - a.priority || a.id.localeCompare(b.id));
    const selected = [];
    let used = 0;
    for (const fragment of ordered) {
        if (used + fragment.estimatedTokens <= maxTokens) {
            selected.push(fragment);
            used += fragment.estimatedTokens;
            continue;
        }
        if (isRequiredProjection(fragment))
            throw new Error(`CONTEXT_BUDGET_EXCEEDED: required fragment '${fragment.id}' cannot be delivered without loss.`);
    }
    return selected;
}
function projectHandoff(role, fragment) {
    const normalized = role.trim().toLowerCase();
    if (normalized === "planner")
        return projectPlanner(fragment);
    if (normalized === "explorer")
        return projectExplorer(fragment);
    return projectSource(fragment);
}
function genericProjection(fragment) {
    const lines = fragment.content.split(/\r?\n/);
    const selected = lines.length <= 64 ? lines : [...lines.slice(0, 16), ...lines.filter((line) => /error|fail|warn|diagnostic|exception|stack/i.test(line)).slice(0, 32), ...lines.slice(-16)];
    const content = [...new Set(selected)].join("\n") + (lines.length > selected.length ? "\n[non-authoritative repetitive lines projected; raw artifact is retrievable]" : "");
    return { ...fragment, content, estimatedTokens: estimateTokens(content), originalTokens: estimateTokens(fragment.content), projected: lines.length > selected.length };
}
function metricsFor(raw, optimized, delivered, discarded) {
    const rawTokens = raw.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0);
    const projectedTokens = optimized.reduce((sum, fragment) => sum + estimateTokens(fragment.content), 0);
    const deliveredTokens = delivered.reduce((sum, fragment) => sum + fragment.estimatedTokens, 0);
    const rawBytes = raw.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
    const projectedBytes = optimized.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
    const deliveredBytes = delivered.reduce((sum, fragment) => sum + estimateBytes(fragment.content), 0);
    const compressed = optimized.filter((fragment) => fragment.compressed).length;
    return { rawBytes, projectedBytes, deliveredBytes, estimatedRawTokens: rawTokens, estimatedDeliveredTokens: deliveredTokens, retrievedFragments: 0, deliveredFragments: delivered.length, compressedFragments: compressed, discardedFragments: discarded.length, retrievalRequests: 0, retrievalRetries: 0, retrievalEscapes: 0, compressionRatio: rawTokens ? deliveredTokens / rawTokens : undefined, projectionRatio: rawTokens ? projectedTokens / rawTokens : undefined };
}
function safeSegment(value) { const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); return sanitized || "fragment"; }
function disambiguatedArtifactPath(relative, contentSha256) {
    const extension = path.posix.extname(relative);
    const stem = extension ? relative.slice(0, -extension.length) : relative;
    return `${stem}.${contentSha256.slice(0, 16)}${extension}`;
}
async function readArtifact(absolute) {
    try {
        return await fs.readFile(absolute);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function writeArtifactIfAbsent(absolute, content) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await fs.writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
            return true;
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const winner = await readArtifact(absolute);
            if (winner)
                return sha256(winner) === sha256(content);
        }
    }
    throw new Error(`Context source artifact could not be established at '${absolute}'.`);
}
function safePath(root, relative) { if (path.isAbsolute(relative))
    throw new Error("Context artifact paths must be relative to the project root."); const absoluteRoot = path.resolve(root); const absolute = path.resolve(absoluteRoot, relative); if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`))
    throw new Error("Context artifact path escapes the project root."); return absolute; }
async function assertNoSymlinkEscape(root, absolute) {
    const absoluteRoot = path.resolve(root);
    let cursor = absolute;
    while (cursor !== absoluteRoot && cursor.startsWith(`${absoluteRoot}${path.sep}`)) {
        try {
            if ((await fs.lstat(cursor)).isSymbolicLink())
                throw new Error("Context artifact path cannot traverse a symbolic link.");
        }
        catch (error) {
            if (error instanceof Error && error.message.includes("cannot traverse"))
                throw error;
            if (error.code !== "ENOENT")
                throw error;
        }
        cursor = path.dirname(cursor);
    }
    if (cursor !== absoluteRoot)
        throw new Error("Context artifact path escapes the project root.");
}
function isRequiredProjection(fragment) { return fragment.preservation === "VERBATIM" || fragment.kind === "normative"; }
export function recoveryHandle(operationId, fragmentId, sourceSha256) {
    return `aeh-context://${encodeURIComponent(operationId)}/${encodeURIComponent(fragmentId)}/${sourceSha256}`;
}
export function contextEnvelopePath(root, operationId, logicalAgent, phase) {
    return safePath(root, path.posix.join(".harness", "context", safeSegment(operationId), safeSegment(logicalAgent), safeSegment(phase), "envelope.json"));
}
//# sourceMappingURL=gateway.js.map