import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOperationStateRoot } from "../operations/state.js";
import { activateStructuredResultTurn } from "../workers/resultGateway.js";
import { commitStructuredResult } from "../workers/resultCommit.js";
/**
 * File-scripted deterministic implementation of the existing Paseo runtime
 * boundary. It replaces only the external model conversation for fixture
 * journeys selected by AEH_DETERMINISTIC_PASEO_RUNTIME=1; controller state,
 * execution bindings, provider leases, context authorization, and structured
 * result provenance all run unchanged. It is not a REAL_PROVIDER capability.
 */
export const DETERMINISTIC_RUNTIME_ENV = "AEH_DETERMINISTIC_PASEO_RUNTIME";
const SESSION_PREFIX = "deterministic:";
const SESSIONS_FILE = ".harness/paseo/deterministic-runtime-sessions.json";
const CURSOR_FILE = ".harness/paseo/deterministic-runtime-cursor.json";
const SCRIPT_FILE = ".harness/fixtures/deterministic-paseo-runtime.json";
export function isDeterministicPaseoRuntimeEnabled() {
    return process.env[DETERMINISTIC_RUNTIME_ENV] === "1";
}
/**
 * Scripted fixture sessions have no external process. The prefix is unambiguous,
 * so lifecycle owners without the runtime environment (for example the paired
 * Control Center performing cancellation) can still skip them safely.
 */
export function isDeterministicPaseoSessionId(agentId) {
    return Boolean(agentId) && agentId.startsWith(SESSION_PREFIX);
}
function stateRoot(root) {
    return resolveOperationStateRoot(process.env.AEH_CONTROL_ROOT?.trim() || root);
}
function sessionsFile(root) { return path.resolve(stateRoot(root), SESSIONS_FILE); }
function cursorFile(root) { return path.resolve(stateRoot(root), CURSOR_FILE); }
function scriptFile(root) { return path.resolve(stateRoot(root), SCRIPT_FILE); }
async function readJson(file) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
async function readSessions(root) {
    return await readJson(sessionsFile(root)) ?? { version: 1, sessions: [] };
}
async function writeSessions(root, file) {
    await writeJson(sessionsFile(root), file);
}
async function findSession(root, agentId) {
    return (await readSessions(root)).sessions.find((session) => session.id === agentId);
}
async function updateSession(root, agentId, patch) {
    const file = await readSessions(root);
    const index = file.sessions.findIndex((session) => session.id === agentId);
    if (index < 0)
        throw new Error(`DETERMINISTIC_RUNTIME_SESSION_MISSING: no scripted session '${agentId}' exists.`);
    const next = { ...file.sessions[index], ...patch, id: agentId };
    file.sessions[index] = next;
    await writeSessions(root, file);
    return next;
}
function sessionResult(session) {
    return {
        id: session.id,
        ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
        status: session.status,
        ...(session.lastMessage ? { lastMessage: session.lastMessage } : {})
    };
}
async function createSession(root, options) {
    const file = await readSessions(root);
    const session = {
        id: `${SESSION_PREFIX}${crypto.randomUUID()}`,
        title: options.title,
        status: "idle",
        workspaceId: options.workspaceId,
        labels: { ...(options.labels ?? {}) },
        root: path.resolve(root),
        createdAt: new Date().toISOString()
    };
    file.sessions.push(session);
    await writeSessions(root, file);
    return session;
}
function responseKey(prompt, options) {
    const assessmentType = options.labels?.["aeh.semantic.assessment.type"]?.trim() || parseAssessmentType(prompt);
    if (assessmentType)
        return `semantic-assessment:${assessmentType}`;
    const contract = options.labels?.["aeh.output.contract"]?.trim();
    if (contract)
        return contract;
    throw new Error("DETERMINISTIC_RUNTIME_KEY_MISSING: the turn carries neither a semantic assessment type nor an output contract label.");
}
function parseAssessmentType(prompt) {
    if (!prompt)
        return undefined;
    try {
        const parsed = JSON.parse(prompt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const value = parsed.assessmentType;
            if (typeof value === "string" && value.trim())
                return value.trim();
        }
    }
    catch { /* not a semantic assessment prompt */ }
    return undefined;
}
async function nextScriptedResponse(root, key) {
    const script = await readJson(scriptFile(root));
    if (!script || script.version !== 1 || !script.responses || typeof script.responses !== "object") {
        throw new Error(`DETERMINISTIC_RUNTIME_SCRIPT_MISSING: no version-1 script exists at ${scriptFile(root)}.`);
    }
    const candidates = [key, key.startsWith("semantic-assessment:") ? "semantic-assessment" : undefined].filter((item) => Boolean(item));
    for (const candidate of candidates) {
        const responses = script.responses[candidate];
        if (!Array.isArray(responses) || responses.length === 0)
            continue;
        const cursor = await readJson(cursorFile(root)) ?? { version: 1, consumed: {} };
        const index = cursor.consumed[candidate] ?? 0;
        if (index >= responses.length)
            throw new Error(`DETERMINISTIC_RUNTIME_SCRIPT_EXHAUSTED: scripted responses for '${candidate}' are exhausted after ${responses.length} turn(s).`);
        cursor.consumed[candidate] = index + 1;
        await writeJson(cursorFile(root), cursor);
        return responses[index];
    }
    throw new Error(`DETERMINISTIC_RUNTIME_SCRIPT_MISSING: no scripted response for '${key}' exists at ${scriptFile(root)}.`);
}
/** Execute one scripted turn: submit the payload through the same result path as the real agent. */
async function executeTurn(root, session, options, prompt) {
    const payload = await nextScriptedResponse(root, responseKey(prompt, options));
    const controlRoot = stateRoot(root);
    const operationId = options.labels?.["aeh.operation"]?.trim();
    const channelId = options.labels?.["aeh.result.channel"]?.trim();
    if (operationId && channelId) {
        await activateStructuredResultTurn(controlRoot, operationId, channelId, options.labels?.["aeh.operation.phase"]);
        await commitStructuredResult(controlRoot, operationId, channelId, payload, "mcp");
    }
    await updateSession(root, session.id, { status: "idle", lastMessage: JSON.stringify(payload) });
    return payload;
}
function optionsFromSession(session, prompt, outputSchema) {
    return { title: session.title ?? "deterministic-runtime", provider: "deterministic", cwd: session.root, labels: session.labels, workspaceId: session.workspaceId, ...(prompt !== undefined ? { prompt } : {}), ...(outputSchema ? { outputSchema } : {}) };
}
export function deterministicPaseoRuntimeDeps() {
    return {
        run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 }),
        updateLabels: async (root, agentId, labels) => {
            const session = await findSession(root, agentId);
            if (!session)
                throw new Error(`DETERMINISTIC_RUNTIME_SESSION_MISSING: cannot update labels for '${agentId}'.`);
            await updateSession(root, agentId, { labels: { ...session.labels, ...labels } });
        },
        detectCapabilities: async () => ({ version: "deterministic-runtime", background: true, quiet: true, json: true, outputSchema: true, daemonJson: true, nativeToolsRecommended: false }),
        trace: async () => undefined,
        native: {
            preflight: async (_root, provider) => ({ ok: true, provider, source: "paseo-provider-unchecked", message: "deterministic runtime boundary" }),
            preflightMode: async (_root, provider, modeId) => ({ ok: true, provider, modeId, availableModes: [], source: "paseo-provider-modes", message: "deterministic runtime boundary" }),
            wait: async (root, agentId) => {
                const session = await findSession(root, agentId);
                if (!session)
                    return { id: agentId, status: "failed", error: `DETERMINISTIC_RUNTIME_SESSION_MISSING: '${agentId}' is unknown.`, source: "paseo-agent-subscription", updatesObserved: 0 };
                const result = sessionResult(session);
                return { ...result, source: "paseo-agent-subscription", updatesObserved: 1 };
            },
            capture: undefined
        },
        sdk: {
            create: async (root, options) => {
                const session = await createSession(root, options);
                if (options.prompt !== undefined) {
                    try {
                        await executeTurn(root, session, options, options.prompt);
                    }
                    catch (error) {
                        await updateSession(root, session.id, { status: "idle", lastMessage: undefined }).catch(() => undefined);
                        return { id: session.id, status: "failed", error: error instanceof Error ? error.message : String(error) };
                    }
                }
                return sessionResult(await findSession(root, session.id) ?? session);
            },
            materialize: async (root, options) => sessionResult(await createSession(root, options)),
            dispatch: async (root, agentId) => sessionResult(await updateSession(root, agentId, { status: "working" })),
            wait: async (root, agentId) => {
                const session = await findSession(root, agentId);
                if (!session)
                    return { id: agentId, status: "failed", error: `DETERMINISTIC_RUNTIME_SESSION_MISSING: '${agentId}' is unknown.` };
                return sessionResult(session);
            },
            run: async (root, agentId, prompt, _timeoutMs, outputSchema) => {
                const session = await findSession(root, agentId);
                if (!session)
                    return { id: agentId, status: "failed", error: `DETERMINISTIC_RUNTIME_SESSION_MISSING: '${agentId}' is unknown.` };
                try {
                    await updateSession(root, agentId, { status: "working" });
                    await executeTurn(root, session, optionsFromSession(session, prompt, outputSchema), prompt);
                    return sessionResult((await findSession(root, agentId)));
                }
                catch (error) {
                    await updateSession(root, agentId, { status: "idle", lastMessage: undefined }).catch(() => undefined);
                    return { id: agentId, status: "failed", error: error instanceof Error ? error.message : String(error) };
                }
            },
            probe: async (root, agentId) => Boolean(await findSession(root, agentId)),
            inspect: async (root, agentId) => {
                const session = await findSession(root, agentId);
                return session ? { id: session.id, title: session.title, status: session.status, workspaceId: session.workspaceId, labels: session.labels, raw: { deterministic: true } } : undefined;
            },
            list: async (root, labels = {}) => {
                return (await readSessions(root)).sessions
                    .filter((session) => Object.entries(labels).every(([key, value]) => session.labels[key] === value))
                    .map((session) => ({ id: session.id, title: session.title, status: session.status, workspaceId: session.workspaceId, labels: session.labels, raw: { deterministic: true } }));
            }
        }
    };
}
//# sourceMappingURL=deterministicRuntime.js.map