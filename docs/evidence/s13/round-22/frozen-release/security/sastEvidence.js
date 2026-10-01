import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256Canonical, sha256Utf8 } from "../core/digest.js";
import { assertWorkspaceMatchesCandidate } from "../candidates/identity.js";
export const SAST_EVIDENCE_VERSION = 1;
export const SAST_EVIDENCE_REQUIRED = "SAST_EVIDENCE_REQUIRED";
export const SAST_EVIDENCE_STALE = "SAST_EVIDENCE_STALE";
export const SAST_EVIDENCE_TAMPERED = "SAST_EVIDENCE_TAMPERED";
export const SAST_PROVIDER_UNAVAILABLE = "SAST_PROVIDER_UNAVAILABLE";
export const SAST_CANDIDATE_BINDING_REQUIRED = "SAST_CANDIDATE_BINDING_REQUIRED";
export const SAST_ADAPTERS = ["opengrep", "trivy"];
const candidateBindingSchema = z.object({
    candidateId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    identityDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
const workspaceSchema = z.object({
    version: z.literal(1),
    candidateId: z.string().min(1),
    candidateRevision: z.number().int().nonnegative(),
    candidateIdentityDigest: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    observedSourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.literal("MATCH")
});
const isolationSchema = z.object({
    version: z.literal(1),
    provider: z.literal("bwrap"),
    providerVersion: z.string().min(1),
    rootless: z.literal(true),
    namespaces: z.object({ user: z.literal(true), mount: z.literal(true), pid: z.literal(true), uts: z.literal(true), ipc: z.literal(true), network: z.boolean() }),
    networkAccess: z.enum(["host", "none"]),
    readOnlyRoot: z.literal(true),
    visibleReadOnlyPaths: z.array(z.string()),
    maskedHostPaths: z.array(z.string()),
    writablePaths: z.array(z.string()),
    environmentAllowlist: z.array(z.string()),
    noNewPrivileges: z.literal(true),
    seccomp: z.literal("not-applied"),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/)
});
const findingSchema = z.object({
    fingerprint: z.string().min(1),
    tool: z.string(),
    kind: z.string(),
    rule: z.string().optional(),
    severity: z.string().optional(),
    file: z.string().optional(),
    line: z.number().optional(),
    endLine: z.number().optional(),
    column: z.number().optional(),
    endColumn: z.number().optional(),
    message: z.string().optional(),
    category: z.string().optional(),
    cwe: z.array(z.string()).optional(),
    package: z.string().optional(),
    installedVersion: z.string().optional(),
    fixedVersion: z.string().optional(),
    target: z.string().optional(),
    artifact: z.string().optional(),
    durationMs: z.number().optional(),
    status: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
});
const evidenceSchema = z.object({
    version: z.literal(SAST_EVIDENCE_VERSION),
    checkId: z.string().min(1),
    adapter: z.enum(["opengrep", "trivy"]),
    candidate: candidateBindingSchema,
    workspace: workspaceSchema,
    tool: z.object({ name: z.string().min(1), version: z.string().min(1), executable: z.string().optional() }),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
    isolation: isolationSchema.optional(),
    status: z.enum(["PASS", "FAIL", "WARN"]),
    findingCount: z.number().int().nonnegative(),
    findings: z.array(findingSchema),
    rawArtifact: z.string().min(1),
    rawArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    blockers: z.array(z.string()),
    artifact: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/)
});
function sanitizeSegment(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, "-");
}
export function sastEvidenceDirectory(root, config, candidate) {
    const outputDir = config.evidence?.outputDir ?? ".harness/evidence";
    return path.resolve(root, outputDir, "sast", sanitizeSegment(`${candidate.candidateId}-r${candidate.revision}-${candidate.identityDigest.slice(0, 12)}`));
}
export function sastEvidenceArtifactPath(root, config, candidate, checkId) {
    return path.join(sastEvidenceDirectory(root, config, candidate), `${sanitizeSegment(checkId)}.json`);
}
export async function persistSastEvidenceV1(input) {
    const directory = sastEvidenceDirectory(input.root, input.config, input.candidate);
    let workspace;
    try {
        workspace = await assertWorkspaceMatchesCandidate(input.root, input.candidate);
    }
    catch (error) {
        throw new Error(`${SAST_EVIDENCE_STALE}: scanned workspace does not match candidate ${input.candidate.candidateId} r${input.candidate.revision}: ${String(error)}`);
    }
    const safeCheckId = sanitizeSegment(input.checkId);
    const rawPath = path.join(directory, `${safeCheckId}.raw`);
    const artifactPath = path.join(directory, `${safeCheckId}.json`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(rawPath, input.rawArtifactText, "utf8");
    const payload = {
        version: SAST_EVIDENCE_VERSION,
        checkId: input.checkId,
        adapter: input.adapter,
        candidate: { candidateId: input.candidate.candidateId, revision: input.candidate.revision, identityDigest: input.candidate.identityDigest },
        workspace,
        tool: input.tool,
        commandDigest: sha256Utf8(input.command),
        ...(input.isolation ? { isolation: input.isolation } : {}),
        status: input.status,
        findingCount: input.findings.length,
        findings: input.findings,
        rawArtifact: path.relative(input.root, rawPath).replaceAll("\\", "/"),
        rawArtifactDigest: sha256Utf8(input.rawArtifactText),
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        blockers: [...(input.blockers ?? [])],
        artifact: path.relative(input.root, artifactPath).replaceAll("\\", "/")
    };
    const evidence = { ...payload, digest: sha256Canonical(payload) };
    await fs.writeFile(artifactPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
}
export async function loadSastEvidenceV1(root, config, candidate, checkId) {
    const artifactPath = sastEvidenceArtifactPath(root, config, candidate, checkId);
    let text;
    try {
        text = await fs.readFile(artifactPath, "utf8");
    }
    catch {
        return undefined;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        throw new Error(`${SAST_EVIDENCE_TAMPERED}: ${path.relative(root, artifactPath)} is not readable JSON.`);
    }
    const parsed = evidenceSchema.safeParse(value);
    if (!parsed.success)
        throw new Error(`${SAST_EVIDENCE_TAMPERED}: ${path.relative(root, artifactPath)} is not a valid SastEvidence v1 document.`);
    return parsed.data;
}
export async function verifySastEvidenceV1(root, config, evidence, expected) {
    const blockers = [];
    const { digest, ...payload } = evidence;
    if (sha256Canonical(payload) !== digest)
        blockers.push(`${SAST_EVIDENCE_TAMPERED}: evidence digest does not match its content.`);
    if (evidence.candidate.candidateId !== expected.candidateId || evidence.candidate.revision !== expected.revision || evidence.candidate.identityDigest !== expected.identityDigest) {
        blockers.push(`${SAST_EVIDENCE_STALE}: evidence is bound to ${evidence.candidate.candidateId} r${evidence.candidate.revision} (${evidence.candidate.identityDigest.slice(0, 12)}) but the current candidate is ${expected.candidateId} r${expected.revision} (${expected.identityDigest.slice(0, 12)}).`);
    }
    const artifactPath = path.resolve(root, evidence.artifact);
    if (artifactPath !== path.join(sastEvidenceDirectory(root, config, expected), `${sanitizeSegment(evidence.checkId)}.json`))
        blockers.push(`${SAST_EVIDENCE_TAMPERED}: evidence artifact path '${evidence.artifact}' is not the candidate-scoped path for '${evidence.checkId}'.`);
    try {
        const raw = await fs.readFile(path.resolve(root, evidence.rawArtifact));
        if (sha256Utf8(raw) !== evidence.rawArtifactDigest)
            blockers.push(`${SAST_EVIDENCE_TAMPERED}: raw SAST artifact digest does not match the recorded digest.`);
    }
    catch {
        blockers.push(`${SAST_EVIDENCE_TAMPERED}: raw SAST artifact '${evidence.rawArtifact}' is missing.`);
    }
    return blockers.length ? { ok: false, blockers: [...new Set(blockers)].sort() } : { ok: true, blockers: [], evidence };
}
export async function requireSastEvidenceV1(root, config, candidate, checkId) {
    const evidence = await loadSastEvidenceV1(root, config, candidate, checkId);
    if (!evidence)
        throw new Error(`${SAST_EVIDENCE_REQUIRED}: required candidate-bound SAST evidence '${checkId}' is absent for ${candidate.candidateId} r${candidate.revision}.`);
    const verification = await verifySastEvidenceV1(root, config, evidence, candidate);
    if (!verification.ok)
        throw new Error(verification.blockers.join("; "));
    return evidence;
}
export function extractSastToolVersion(adapter, output) {
    try {
        const parsed = JSON.parse(output);
        if (adapter === "trivy") {
            const trivy = parsed.Trivy;
            if (trivy && typeof trivy.Version === "string" && trivy.Version.trim())
                return trivy.Version.trim();
            const metadata = parsed.Metadata;
            if (metadata && typeof metadata.Version === "string" && metadata.Version.trim())
                return metadata.Version.trim();
        }
        if (typeof parsed.version === "string" && parsed.version.trim())
            return parsed.version.trim();
    }
    catch { /* non-JSON output is handled by the caller as malformed evidence */ }
    return "unknown";
}
//# sourceMappingURL=sastEvidence.js.map