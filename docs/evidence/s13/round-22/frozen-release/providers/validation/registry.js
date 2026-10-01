import fs from "node:fs/promises";
import path from "node:path";
import { sha256Canonical } from "../../core/digest.js";
import { GenericBddExecutionProvider, runBddExecution } from "./bddExecution.js";
import { IntegrationEnvironmentProvider } from "./integrationEnvironment.js";
import { PactContractTestingProvider, runPactVerification } from "./pact.js";
import { ReqnrollBddProvider } from "./reqnroll.js";
import { resultCheck } from "./protocol.js";
import { ProjectNativeTestExecutionProvider, runTestExecution } from "./testExecution.js";
import { persistProviderLaneEvidenceV1, providerLaneUnavailableBlocker } from "../../validation/laneEvidence.js";
export class ValidationCapabilityRegistry {
    providers = [];
    constructor() {
        this.register(new ProjectNativeTestExecutionProvider());
        this.register(new GenericBddExecutionProvider());
        this.register(new IntegrationEnvironmentProvider());
        this.register(new PactContractTestingProvider());
    }
    register(provider) { this.providers.push(provider); }
    list(capability) { return this.providers.filter((provider) => !capability || provider.capabilities.includes(capability)).map((provider) => provider.id); }
    async resolve(context) {
        const candidates = this.providers.filter((candidate) => candidate.capabilities.includes(context.capability));
        const provider = (context.providerSpec?.provider ? candidates.find((candidate) => candidate.id === context.providerSpec?.provider) : undefined) ?? candidates[0];
        if (!provider)
            return undefined;
        const detection = await provider.detect(context);
        if (!detection)
            return undefined;
        return { capability: context.capability, provider: detection.provider, source: context.providerSpec || context.spec?.command ? "explicit" : "detected", command: detection.command };
    }
}
export const validationCapabilityRegistry = new ValidationCapabilityRegistry();
export async function runCapabilityValidator(context, id, capability, required) {
    const effective = { ...context, capability };
    if (capability === "bdd") {
        const execution = await runBddExecution(effective, effective.spec?.options?.provider === "reqnroll" ? new ReqnrollBddProvider() : undefined);
        if (execution.result.status === "SKIP")
            return providerUnavailableCheck(id, "bdd", "CONTRACT", required, { command: execution.result.command, provider: execution.result.provider, reason: "No approved BDD provider or runner was detected." });
        return finalizeLaneCheck(effective, "CONTRACT", resultCheck(id, "bdd", execution.result, required), {
            provider: { name: execution.result.provider, version: "unknown", runtime: execution.result.runtime },
            command: execution.result.command,
            summary: `BDD ${execution.result.status}: ${execution.result.summary.passed}/${execution.result.summary.total} scenario(s) passed.`,
            findings: execution.result.scenarios.filter((scenario) => scenario.status === "FAIL").map((scenario) => failureFinding("bdd", "failed-scenario", `${scenario.feature} :: ${scenario.scenario}`, scenario.error)),
            rawArtifact: execution.result.rawArtifact
        });
    }
    if (capability === "contract-test") {
        const execution = await runPactVerification(effective);
        if (execution.result.status === "SKIP")
            return providerUnavailableCheck(id, "contract", "CONTRACT", required, { command: execution.result.verifierCommand, provider: execution.result.provider, reason: execution.result.failures[0]?.message ?? "No approved Pact verifier was detected." });
        return finalizeLaneCheck(effective, "CONTRACT", resultCheck(id, "contract", execution.result, required), {
            provider: { name: execution.result.provider, version: "unknown", runtime: "pact-ffi" },
            command: execution.result.verifierCommand,
            summary: `Pact ${execution.result.status}: ${execution.result.summary.passed}/${execution.result.summary.total} interaction(s) verified.`,
            findings: execution.result.failures.map((failure) => failureFinding("pact", "contract-failure", failure.id, failure.message)),
            rawArtifact: execution.result.rawArtifact
        });
    }
    if (effective.spec?.adapter === "integration-environment" || ["integration-environment", "oci", "docker", "podman"].includes(effective.providerSpec?.provider ?? "") || typeof (effective.spec?.options ?? effective.providerSpec?.options)?.provisionCommand === "string") {
        const provider = new IntegrationEnvironmentProvider();
        const doctor = await provider.doctor(effective);
        if (!doctor.available)
            return providerUnavailableCheck(id, "integration-environment", "INTEGRATION", required, { provider: doctor.provider, reason: doctor.message, securityFailures: doctor.details?.securityFailures });
        const detection = await provider.detect(effective);
        if (!detection)
            return providerUnavailableCheck(id, "integration-environment", "INTEGRATION", required, { provider: provider.id, reason: "No integration environment provider was configured." });
        const plan = await provider.plan(effective, detection);
        const execution = await provider.execute(effective, plan);
        const normalized = await provider.normalize(effective, execution);
        return finalizeLaneCheck(effective, "INTEGRATION", resultCheck(id, "integration-environment", normalized, required), {
            provider: { name: normalized.provider, version: "unknown", runtime: "oci-or-project" },
            command: execution.plan.command,
            summary: `Integration lifecycle provisioned=${normalized.lifecycle.provisioned} ready=${normalized.lifecycle.ready} tested=${normalized.lifecycle.tested} cleaned=${normalized.lifecycle.cleaned}.`,
            findings: [],
            rawArtifact: normalized.rawArtifact,
            blockers: normalized.blockers
        });
    }
    return resultCheck(id, capability, (await runTestExecution(effective)).result, required);
}
async function finalizeLaneCheck(context, lane, check, input) {
    const candidate = context.candidate;
    if (!candidate || check.status === "SKIP")
        return check;
    const startedAt = new Date(Date.now() - (check.durationMs ?? 0)).toISOString();
    const finishedAt = new Date().toISOString();
    const rawArtifactText = await readArtifactText(context.root, input.rawArtifact) ?? JSON.stringify({ lane, check: { id: check.id, status: check.status, message: check.message }, findings: input.findings });
    try {
        const evidence = await persistProviderLaneEvidenceV1({
            root: context.root,
            config: context.config,
            lane,
            checkId: check.id,
            candidate,
            provider: input.provider,
            command: input.command,
            status: check.status === "PASS" ? "PASS" : check.status === "WARN" ? "WARN" : "FAIL",
            summary: input.summary,
            findings: input.findings,
            rawArtifactText,
            startedAt,
            finishedAt,
            blockers: input.blockers
        });
        return { ...check, details: { ...check.details, lane, laneEvidence: { artifact: evidence.artifact, digest: evidence.digest, candidate: evidence.candidate } } };
    }
    catch (error) {
        return {
            id: check.id,
            category: check.category,
            status: context.spec?.required === false ? "WARN" : "FAIL",
            message: `${lane} candidate-bound evidence could not be persisted: ${String(error)}`,
            details: { ...check.details, lane, blocker: "PROVIDER_LANE_EVIDENCE_PERSIST_FAILED" }
        };
    }
}
function providerUnavailableCheck(id, category, lane, required, details) {
    const blocker = providerLaneUnavailableBlocker(lane);
    const reason = typeof details.reason === "string" ? details.reason : "the approved provider is unavailable";
    return {
        id,
        category,
        status: required ? "FAIL" : "SKIP",
        message: required ? `${blocker}: required ${lane} provider did not run: ${reason}` : `${blocker}: optional ${lane} provider was unavailable: ${reason}`,
        details: { ...details, blocker, lane, required }
    };
}
async function readArtifactText(root, artifact) {
    if (!artifact)
        return undefined;
    try {
        return await fs.readFile(path.resolve(root, artifact), "utf8");
    }
    catch {
        return undefined;
    }
}
function failureFinding(tool, kind, rule, message) {
    const finding = { tool, kind, rule, message };
    return { ...finding, fingerprint: sha256Canonical(finding) };
}
export function providerSpecFor(config, capability, spec) {
    const providerName = typeof spec?.options?.provider === "string" ? spec.options.provider : undefined;
    return config.validation?.providers?.find((item) => item.capability === capability && (!providerName || item.provider === providerName || item.id === providerName));
}
export function capabilityRequirements(contract) {
    const declared = [...(contract.verification?.capabilities ?? []), ...(contract.requirements ?? []).flatMap((item) => item.capabilities ?? [])];
    return [...new Set(declared)];
}
//# sourceMappingURL=registry.js.map