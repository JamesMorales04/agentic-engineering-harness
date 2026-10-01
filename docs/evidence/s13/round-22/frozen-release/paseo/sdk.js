import process from "node:process";
import { pathToFileURL } from "node:url";
import { acceptedStructuredResultForAgent, activateStructuredResultTurn, activateStructuredResultTurnForAgent, bindStructuredResultChannel, loadStructuredResultChannel, provisionStructuredResultChannel, resultSinkMcpServerDefinition } from "../workers/resultGateway.js";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";
import { recordPaseoTrace } from "./trace.js";
export class PaseoSdkUnavailableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "PaseoSdkUnavailableError";
    }
}
export class PaseoSdkTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = "PaseoSdkTimeoutError";
    }
}
export async function connectPaseoClient(client, timeoutMs = 15_000) {
    let timer;
    try {
        await Promise.race([
            client.connect(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new PaseoSdkTimeoutError(`Connecting to the Paseo daemon timed out after ${timeoutMs}ms.`)), timeoutMs);
            })
        ]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new PaseoSdkUnavailableError(`Unable to connect to the Paseo daemon through @getpaseo/client: ${message}`, { cause: error });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export async function createPaseoSdkAgent(root, options) {
    const effective = await withStructuredResultSink(root, options, Boolean(options.prompt !== undefined && options.outputSchema));
    const result = await withPaseoClient(root, async (client) => createPaseoSdkAgentWithClient(client, effective));
    await bindStructuredResultFromOptions(root, effective, result.id);
    return projectAcceptedPaseoResult(root, result, structuredResultExpectation(effective.labels));
}
export async function materializePaseoSdkAgent(root, options) {
    const effective = await withStructuredResultSink(root, options, false);
    const result = await withPaseoClient(root, async (client) => materializePaseoSdkAgentWithClient(client, effective));
    await bindStructuredResultFromOptions(root, effective, result.id);
    return result;
}
export async function materializePaseoSdkAgentWithClient(client, options) {
    const handle = await client.agents.create(buildCreateOptions(options, false));
    return handleResult(handle);
}
export async function createPaseoSdkAgentWithClient(client, options) {
    const handle = await client.agents.create(buildCreateOptions(options, options.prompt !== undefined));
    if (options.prompt !== undefined && options.waitForFinish !== false) {
        const result = await waitForHandle(handle, options.timeoutMs);
        if (result.status === "timeout")
            await stopPaseoSdkAgentHandle(handle);
        return result;
    }
    return handleResult(handle);
}
export async function dispatchPaseoSdkAgent(root, agentId, prompt, timeoutMs) {
    return withPaseoClient(root, (client) => dispatchPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs));
}
export async function dispatchPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs) {
    const handle = client.agents.ref(agentId);
    if (typeof handle.send === "function") {
        try {
            await withTimeout(handle.send(prompt), timeoutMs, `Paseo agent ${agentId} dispatch timed out after ${timeoutMs ?? 1_800_000}ms.`);
        }
        catch (error) {
            if (error instanceof PaseoSdkTimeoutError)
                await stopPaseoSdkAgentHandle(handle);
            throw error;
        }
        return { ...handleResult(handle), status: statusText(handle.status) ?? "working" };
    }
    if (typeof handle.run === "function") {
        const turn = await handle.run(prompt, { timeoutMs });
        if (turn.status === "timeout")
            await stopPaseoSdkAgentHandle(handle);
        return turnResult(handle, turn);
    }
    throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither send() nor run(); cannot dispatch a turn through the SDK.");
}
export async function waitPaseoSdkAgent(root, agentId, timeoutMs) {
    const result = await withPaseoClient(root, async (client) => {
        const handle = client.agents.ref(agentId);
        const result = await waitForHandle(handle, timeoutMs);
        if (result.status === "timeout")
            await stopPaseoSdkAgentHandle(handle);
        return result;
    });
    return projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
}
/** Execute one resumed turn on one concrete SDK handle. Prefer the SDK's atomic
 * run() primitive so dispatch and completion observation cannot be separated by
 * an idle->running->idle race. Older SDKs fall back to send()+waitForFinish()
 * on the same handle/client. Structured output constraints accompany the turn
 * when provided. When the session has an AEH structured-result capability, the
 * accepted durable result artifact is projected back into lastMessage so legacy
 * consumers remain compatible without making transcript text lifecycle authority. */
export async function runPaseoSdkAgent(root, agentId, prompt, timeoutMs, outputSchema) {
    if (outputSchema)
        await activateStructuredResultTurnForAgent(root, agentId);
    const result = await withPaseoClient(root, async (client) => runPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs, outputSchema));
    let projected = await projectAcceptedPaseoResult(root, result, { requireBoundProvenance: true, verifyCurrentCandidate: true });
    if (!projected.lastMessage?.trim()) {
        // Some provider handles do not expose the completed turn text on the run handle; the
        // canonical agent timeline still carries the assistant message and is the deterministic
        // fallback for non-participant (assessor) turns that have no durable structured-result sink.
        let timelineError;
        const timeline = await inspectPaseoSdkAgentTimeline(root, agentId).catch((error) => {
            timelineError = error instanceof Error ? error.message : String(error);
            return undefined;
        });
        if (timelineError)
            await recordPaseoTrace(root, "timeline.refetch.failed", { agentId, error: timelineError, direction: "tail" }).catch(() => undefined);
        const recovered = timeline?.length ? extractLastAssistantText(timeline) : undefined;
        if (recovered)
            projected = { ...projected, lastMessage: recovered };
    }
    return projected;
}
export async function runPaseoSdkAgentWithClient(client, agentId, prompt, timeoutMs, outputSchema) {
    const handle = client.agents.ref(agentId);
    if (typeof handle.run === "function") {
        const turn = await handle.run(prompt, { timeoutMs, ...(outputSchema ? { outputSchema } : {}) });
        if (turn.status === "timeout")
            await stopPaseoSdkAgentHandle(handle);
        return turnResult(handle, turn);
    }
    if (typeof handle.send === "function") {
        await withTimeout(handle.send(prompt, outputSchema ? { outputSchema } : undefined), timeoutMs, `Paseo agent ${agentId} turn dispatch timed out after ${timeoutMs ?? 1_800_000}ms.`).catch(async (error) => {
            if (error instanceof PaseoSdkTimeoutError)
                await stopPaseoSdkAgentHandle(handle);
            throw error;
        });
        const result = await waitForHandle(handle, timeoutMs);
        if (result.status === "timeout")
            await stopPaseoSdkAgentHandle(handle);
        return result;
    }
    throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle exposes neither run() nor send(); cannot execute an atomic resumed turn through the SDK.");
}
export async function archivePaseoSdkAgent(root, agentId) {
    return withPaseoClient(root, async (client) => {
        const handle = client.agents.ref(agentId);
        if (typeof handle.archive !== "function")
            throw new PaseoSdkUnavailableError("The active @getpaseo/client agent handle does not expose archive().");
        await handle.archive();
    });
}
export async function inspectPaseoSdkAgent(root, agentId) {
    return withPaseoClient(root, async (client) => {
        const raw = await refreshHandle(client.agents.ref(agentId));
        return raw ? normalizeRecord(raw) : undefined;
    });
}
export async function inspectPaseoSdkAgentTimeline(root, agentId) {
    return withPaseoClient(root, async (client) => {
        const handle = client.agents.ref(agentId);
        if (!handle.timeline || typeof handle.timeline.refetch !== "function")
            return undefined;
        const result = await handle.timeline.refetch({ direction: "tail", limit: 100 });
        return extractTimelineEntries(result);
    });
}
export async function probePaseoSdkAgent(root, agentId) {
    return Boolean(await inspectPaseoSdkAgent(root, agentId));
}
export async function listPaseoSdkAgents(root, labels = {}) {
    return withPaseoClient(root, async (client) => {
        const filter = { includeArchived: false };
        if (Object.keys(labels).length)
            filter.labels = labels;
        if (typeof client.agents.list !== "function")
            throw new PaseoSdkUnavailableError("The active @getpaseo/client does not expose agents.list().");
        const page = await client.agents.list({ filter });
        return page.entries.map((entry) => normalizeRecord(entry.agent)).filter((agent) => labelsMatch(agent.labels, labels));
    });
}
async function withStructuredResultSink(root, options, activateInitialTurn) {
    const contract = options.labels?.["aeh.output.contract"]?.trim();
    const operationId = options.labels?.["aeh.operation"]?.trim();
    const logicalAgent = options.labels?.["aeh.role"]?.trim();
    if (!contract || !operationId || !logicalAgent)
        return options;
    const operationRevision = Number(options.labels?.["aeh.operation.revision"]);
    const supervisorGeneration = Number(options.labels?.["aeh.supervisor.generation"]);
    const taskId = options.labels?.["aeh.task"]?.trim();
    const role = options.labels?.["aeh.canonical.role"]?.trim();
    const rawBinding = options.labels?.["aeh.execution.binding"];
    if (!rawBinding) {
        const pendingChannelId = options.labels?.["aeh.result.channel"]?.trim();
        if (options.labels?.["aeh.execution.binding.phase"] !== "PENDING_SESSION" || !pendingChannelId) {
            throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry a complete versioned binding or an inert pending-session channel.");
        }
        const pending = await loadStructuredResultChannel(root, operationId, pendingChannelId);
        if (pending.operationId !== operationId || pending.logicalAgent !== logicalAgent || pending.role !== role || pending.taskId !== taskId || pending.contract !== contract || pending.provenance.status !== "UNSUPPORTED" || pending.agentId || pending.activeTurn || !options.mcpServers?.["aeh-result"] || !options.toolPolicy?.preapproved.some((item) => item.kind === "mcp" && item.server === "aeh-result" && item.tool === "aeh_submit_result")) {
            throw new Error("AEH_RESULT_PROVENANCE: pending Paseo result channel is not inert or does not match the launch contract.");
        }
        return options;
    }
    const provenance = parseStructuredResultProvenance(options.labels?.["aeh.result.provenance"], {
        operationId,
        logicalAgent,
        role,
        taskId,
        contract
    });
    if (!rawBinding || !provenance.executionBinding || rawBinding !== JSON.stringify(provenance.executionBinding) || options.labels?.["aeh.execution.binding.digest"] !== provenance.executionBinding.digest)
        throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launch must carry the complete versioned binding in its launch labels.");
    const channel = await provisionStructuredResultChannel(root, {
        operationId,
        logicalAgent,
        role,
        taskId,
        contract,
        operationRevision: Number.isInteger(operationRevision) ? operationRevision : undefined,
        supervisorGeneration: Number.isInteger(supervisorGeneration) ? supervisorGeneration : undefined,
        provenance
    });
    if (activateInitialTurn)
        await activateStructuredResultTurn(root, operationId, channel.channelId, options.labels?.["aeh.operation.phase"]);
    const server = "aeh-result";
    const preapproved = [
        ...(options.toolPolicy?.preapproved ?? []).filter((item) => !(item.kind === "mcp" && item.server === server && item.tool === "aeh_submit_result")),
        { kind: "mcp", server, tool: "aeh_submit_result" }
    ];
    return {
        ...options,
        labels: { ...options.labels, "aeh.result.channel": channel.channelId },
        mcpServers: { ...(options.mcpServers ?? {}), [server]: resultSinkMcpServerDefinition(root, operationId, channel.channelId) },
        toolPolicy: { preapproved }
    };
}
async function bindStructuredResultFromOptions(root, options, agentId) {
    const operationId = options.labels?.["aeh.operation"]?.trim();
    const channelId = options.labels?.["aeh.result.channel"]?.trim();
    if (!operationId || !channelId)
        return;
    await bindStructuredResultChannel(root, operationId, channelId, agentId);
}
async function projectAcceptedPaseoResult(root, result, expected = { requireBoundProvenance: true, verifyCurrentCandidate: true }) {
    const accepted = await acceptedStructuredResultForAgent(root, result.id, expected).catch(() => undefined);
    return accepted ? { ...result, lastMessage: JSON.stringify(accepted.payload) } : result;
}
function parseStructuredResultProvenance(raw, identity) {
    if (raw) {
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch {
            throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label is not valid JSON.");
        }
        const provenance = value;
        if (!provenance || provenance.version !== 1 || provenance.operationId !== identity.operationId || provenance.logicalAgent !== identity.logicalAgent || provenance.role !== identity.role || provenance.taskId !== identity.taskId || provenance.outputContract !== identity.contract) {
            throw new Error("AEH_RESULT_PROVENANCE: Paseo launch provenance label does not match operation/participant/task/contract labels.");
        }
        return provenance;
    }
    throw new Error("EXECUTION_BINDING_REQUIRED: Paseo structured-result launches must propagate a complete versioned StructuredResultProvenance before session creation.");
}
function structuredResultExpectation(labels) {
    const operationId = labels?.["aeh.operation"];
    const logicalAgent = labels?.["aeh.role"];
    const raw = labels?.["aeh.result.provenance"];
    if (!operationId || !logicalAgent || !raw)
        return { requireBoundProvenance: true, verifyCurrentCandidate: true };
    return {
        operationId,
        logicalAgent,
        role: labels?.["aeh.canonical.role"],
        taskId: labels?.["aeh.task"],
        contract: labels?.["aeh.output.contract"],
        provenance: parseStructuredResultProvenance(raw, { operationId, logicalAgent, role: labels?.["aeh.canonical.role"], taskId: labels?.["aeh.task"], contract: labels?.["aeh.output.contract"] ?? "" }),
        requireBoundProvenance: true,
        verifyCurrentCandidate: true
    };
}
async function withPaseoClient(root, action) {
    const sdk = await loadPaseoSdk(root);
    const client = sdk.createPaseoClient({
        url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
        clientId: `aeh-${process.pid}`,
        password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
    });
    try {
        await connectPaseoClient(client);
        return await action(client);
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
async function loadPaseoSdk(root) {
    const bundled = await resolvePaseoSdkFromCli(root);
    if (bundled.resolved) {
        try {
            const sdk = (await import(pathToFileURL(bundled.resolved).href));
            if (typeof sdk.createPaseoClient === "function")
                return sdk;
        }
        catch (error) {
            bundled.diagnostics.push(`bundled import: ${String(error)}`);
        }
    }
    const packageName = "@getpaseo/client";
    let directError;
    try {
        const direct = (await import(packageName));
        if (typeof direct.createPaseoClient === "function")
            return direct;
    }
    catch (error) {
        directError = error;
    }
    const detail = bundled.diagnostics.length ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.` : "";
    throw new PaseoSdkUnavailableError(`@getpaseo/client could not be resolved from the active Paseo CLI installation or directly.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`, { cause: directError });
}
function buildCreateOptions(options, includePrompt) {
    const config = { provider: providerModelForSdk(options.provider, options.model) };
    if (options.modeId)
        config.modeId = options.modeId;
    if (options.thinkingOptionId)
        config.thinkingOptionId = options.thinkingOptionId;
    if (options.systemPrompt)
        config.systemPrompt = options.systemPrompt;
    if (options.mcpServers && Object.keys(options.mcpServers).length)
        config.mcpServers = options.mcpServers;
    if (options.toolPolicy?.preapproved.length)
        config.toolPolicy = options.toolPolicy;
    if (options.providerOptions && Object.keys(options.providerOptions).length)
        config.options = options.providerOptions;
    if (options.featureValues && Object.keys(options.featureValues).length)
        config.featureValues = options.featureValues;
    const createOptions = { config, title: options.title, cwd: options.cwd };
    if (options.agentId)
        createOptions.agentId = options.agentId;
    if (options.env && Object.keys(options.env).length)
        createOptions.env = options.env;
    if (options.workspaceId)
        createOptions.workspaceId = options.workspaceId;
    if (options.parentAgentId)
        createOptions.parent = options.parentAgentId;
    if (includePrompt && options.prompt !== undefined)
        createOptions.initialPrompt = options.prompt;
    if (options.outputSchema)
        createOptions.outputSchema = options.outputSchema;
    if (options.labels && Object.keys(options.labels).length)
        createOptions.labels = options.labels;
    return createOptions;
}
async function waitForHandle(handle, timeoutMs = 1_800_000) {
    if (typeof handle.waitForFinish === "function") {
        const turn = await handle.waitForFinish(timeoutMs);
        return turnResult(handle, turn);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const raw = await refreshHandle(handle);
        const status = statusText(raw?.status ?? handle.status);
        if (isTerminalStatus(status)) {
            const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
                ? await handle.timeline.refetch({ direction: "tail", limit: 50 }).catch(() => undefined)
                : undefined;
            return {
                id: handle.id,
                workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
                status,
                lastMessage: stringField(raw ?? {}, ["lastMessage", "last_message"]) ?? extractLastAssistantText(timeline),
                error: stringField(raw ?? {}, ["error", "lastError", "last_error"]),
                ...(permissionStopDetail(raw?.pendingPermissions ?? handle.pendingPermissions) ? { permission: permissionStopDetail(raw?.pendingPermissions ?? handle.pendingPermissions) } : {})
            };
        }
        if (Date.now() >= deadline)
            return { id: handle.id, workspaceId: handle.workspaceId ?? undefined, status: "timeout", error: `Timed out after ${timeoutMs}ms.` };
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}
async function stopPaseoSdkAgentHandle(handle) {
    for (const method of [handle.cancel, handle.stop, handle.kill, handle.abort]) {
        if (typeof method !== "function")
            continue;
        await method.call(handle);
        return;
    }
}
async function withTimeout(promise, timeoutMs = 1_800_000, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new PaseoSdkTimeoutError(message)), timeoutMs);
                timer.unref();
            })
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function turnResult(handle, turn) {
    const permission = permissionStopDetail(turn.final?.pendingPermissions ?? handle.pendingPermissions);
    if (turn.lastMessage) {
        return {
            id: handle.id,
            workspaceId: handle.workspaceId ?? undefined,
            status: turn.status,
            lastMessage: turn.lastMessage,
            error: turn.error,
            ...(permission ? { permission } : {})
        };
    }
    const raw = await refreshHandle(handle).catch(() => undefined);
    const timeline = handle.timeline && typeof handle.timeline.refetch === "function"
        ? await handle.timeline.refetch({ direction: "tail", limit: 50 }).catch(() => undefined)
        : undefined;
    const observedPermission = permission ?? permissionStopDetail(raw?.pendingPermissions);
    return {
        id: handle.id,
        workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
        status: turn.status || statusText(raw?.status ?? handle.status),
        lastMessage: stringField(raw ?? {}, ["lastMessage", "last_message"]) ??
            extractLastAssistantText(timeline),
        error: turn.error ?? stringField(raw ?? {}, ["error", "lastError", "last_error"]),
        ...(observedPermission ? { permission: observedPermission } : {})
    };
}
function permissionStopDetail(value) {
    const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object")
            continue;
        const record = entry;
        const name = boundedString(record.name ?? record.permission);
        const title = boundedString(record.title);
        const description = boundedString(record.description);
        const input = record.input && typeof record.input === "object" ? record.input : undefined;
        const patterns = boundedStringArray(input?.patterns);
        if (name || title || patterns?.length) {
            return {
                ...(name ? { name } : {}),
                ...(title ? { title } : {}),
                ...(description ? { description } : {}),
                ...(patterns?.length ? { patterns } : {})
            };
        }
    }
    return undefined;
}
function boundedString(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 200) : undefined;
}
function boundedStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const strings = value.filter((item) => typeof item === "string" && item.trim().length > 0).slice(0, 8).map((item) => item.slice(0, 300));
    return strings.length ? strings : undefined;
}
async function refreshHandle(handle) {
    if (typeof handle.refetch === "function")
        return (await handle.refetch())?.agent;
    if (typeof handle.refresh === "function")
        return (await handle.refresh())?.agent;
    return handle.latest?.() ?? undefined;
}
function handleResult(handle) {
    const raw = handle.latest?.() ?? undefined;
    const permission = permissionStopDetail(raw?.pendingPermissions ?? handle.pendingPermissions);
    return {
        id: handle.id,
        workspaceId: handle.workspaceId ?? stringField(raw ?? {}, ["workspaceId", "workspace_id"]),
        status: statusText(raw?.status ?? handle.status),
        ...(permission ? { permission } : {})
    };
}
function providerModelForSdk(provider, model) {
    const normalizedProvider = provider.trim();
    if (!normalizedProvider)
        throw new Error("Paseo SDK requires a provider.");
    const separator = normalizedProvider.indexOf("/");
    if (separator < 0) {
        const explicitModel = model?.trim();
        if (!explicitModel)
            throw new Error("Paseo SDK requires a provider/model value.");
        return `${normalizedProvider}/${explicitModel}`;
    }
    const providerId = normalizedProvider.slice(0, separator).trim();
    const embeddedModel = normalizedProvider.slice(separator + 1).trim();
    if (!providerId || !embeddedModel)
        throw new Error(`Invalid Paseo provider/model value '${provider}'. Expected '<provider>/<model>'.`);
    const explicitModel = model?.trim();
    if (explicitModel && explicitModel !== embeddedModel)
        throw new Error(`Conflicting Paseo models: provider value '${provider}' embeds '${embeddedModel}' but explicit model is '${explicitModel}'.`);
    return `${providerId}/${embeddedModel}`;
}
function normalizeRecord(raw) {
    const id = stringField(raw, ["id", "agentId", "agent_id"]);
    if (!id)
        throw new Error("Paseo SDK returned an agent without an id.");
    return { id, title: stringField(raw, ["title", "name"]), status: statusText(raw.status), workspaceId: stringField(raw, ["workspaceId", "workspace_id"]), labels: recordOfStrings(raw.labels), raw };
}
/**
 * Select the canonical last assistant message from a timeline payload. Only the
 * assistant entry's own top-level text/content is accepted; nested tool-call
 * payloads, reasoning traces and user messages never become completion text.
 * Schema validation remains the authority for any structured payload.
 */
function extractLastAssistantText(value) {
    let found;
    for (const entry of extractTimelineEntries(value)) {
        const text = assistantEntryText(entry);
        if (text !== undefined)
            found = text;
    }
    return found;
}
function assistantEntryText(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return undefined;
    const record = entry;
    const item = record.item && typeof record.item === "object" && !Array.isArray(record.item) ? record.item : record;
    const role = String(item.role ?? record.role ?? "").toLowerCase();
    const type = String(item.type ?? item.kind ?? record.type ?? record.kind ?? "").toLowerCase();
    const assistant = role === "assistant" || role.endsWith("/assistant") || type === "assistant_message" || type === "assistant-message" || type === "assistant";
    if (!assistant)
        return undefined;
    return messageText(item) ?? messageText(record);
}
function messageText(record) {
    for (const key of ["text", "message", "lastMessage"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim())
            return value;
    }
    const content = record.content;
    if (typeof content === "string" && content.trim())
        return content;
    if (Array.isArray(content)) {
        const parts = content
            .map((part) => typeof part === "string" ? part : (part && typeof part === "object" && typeof part.text === "string" ? part.text : undefined))
            .filter((part) => typeof part === "string" && part.trim().length > 0);
        if (parts.length)
            return parts.join("\n");
    }
    return undefined;
}
function labelsMatch(actual, expected) {
    return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}
function isTerminalStatus(value) {
    return value === "idle" || value === "finished" || value === "completed" || value === "failed" || value === "error" || value === "timeout" || value === "cancelled";
}
function stringField(record, keys) {
    for (const key of keys)
        if (typeof record[key] === "string" && record[key])
            return record[key];
    return undefined;
}
function recordOfStrings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value))
        if (typeof item === "string")
            result[key] = item;
    return Object.keys(result).length ? result : undefined;
}
function statusText(value) {
    if (typeof value === "string")
        return value;
    if (value && typeof value === "object") {
        const nested = value.status;
        if (typeof nested === "string")
            return nested;
    }
    return undefined;
}
function extractTimelineEntries(value) {
    if (Array.isArray(value))
        return value;
    if (!value || typeof value !== "object")
        return [];
    const record = value;
    for (const key of ["entries", "items", "events", "messages"])
        if (Array.isArray(record[key]))
            return record[key];
    return [];
}
//# sourceMappingURL=sdk.js.map