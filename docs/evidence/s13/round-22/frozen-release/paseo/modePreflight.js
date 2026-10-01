import process from "node:process";
import { pathToFileURL } from "node:url";
import { connectPaseoClient, PaseoSdkUnavailableError } from "./sdk.js";
import { resolvePaseoSdkFromCli } from "./sdkResolve.js";
import { recordPaseoTrace } from "./trace.js";
/**
 * Validate an externally-authored provider mode before AEH dispatches work.
 * This is intentionally fail-closed: an explicit nativeAgent is part of the
 * frozen execution contract, so silently falling back to an ambient default
 * would execute a different agent than the one AEH selected.
 */
export async function preflightPaseoProviderMode(root, provider, modeId, cwd = root) {
    const normalizedProvider = provider.trim();
    const normalizedMode = modeId.trim();
    if (!normalizedProvider)
        throw new Error("Paseo provider is required for mode preflight.");
    if (!normalizedMode)
        throw new Error("Paseo modeId is required for mode preflight.");
    const sdk = await loadSdk(root);
    const client = sdk.createPaseoClient({
        url: process.env.PASEO_DAEMON_URL?.trim() || "ws://127.0.0.1:6767/ws",
        clientId: `aeh-mode-preflight-${process.pid}`,
        password: process.env.PASEO_DAEMON_PASSWORD?.trim() || undefined
    });
    try {
        await connectPaseoClient(client);
        if (typeof client.providers?.listModes !== "function") {
            throw new Error("The active Paseo SDK does not expose providers.listModes(), which AEH requires to validate an explicit native OpenCode agent before dispatch.");
        }
        const response = await client.providers.listModes(normalizedProvider, { cwd });
        const availableModes = modeIds(response);
        const ok = availableModes.includes(normalizedMode);
        const result = {
            ok,
            provider: normalizedProvider,
            modeId: normalizedMode,
            availableModes,
            source: "paseo-provider-modes",
            message: ok
                ? `Paseo provider ${normalizedProvider} exposes mode ${normalizedMode}.`
                : availableModes.length
                    ? `Paseo provider ${normalizedProvider} does not expose requested mode ${normalizedMode}.`
                    : `Paseo provider ${normalizedProvider} reported no selectable modes for ${cwd}.`
        };
        await recordPaseoTrace(root, "provider.mode.preflight", {
            ok,
            provider: normalizedProvider,
            modeId: normalizedMode,
            availableModeCount: availableModes.length,
            source: result.source,
            message: result.message
        });
        return result;
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
async function loadSdk(root) {
    const bundled = await resolvePaseoSdkFromCli(root);
    if (bundled.resolved) {
        try {
            const sdk = (await import(pathToFileURL(bundled.resolved).href));
            if (typeof sdk.createPaseoClient === "function")
                return sdk;
        }
        catch (error) {
            bundled.diagnostics.push(`mode preflight bundled import: ${String(error)}`);
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
    const detail = bundled.diagnostics.length
        ? ` Resolution diagnostics: ${bundled.diagnostics.join("; ")}.`
        : "";
    throw new PaseoSdkUnavailableError(`Paseo SDK could not be resolved for explicit provider-mode preflight.${detail}${directError ? ` Direct import: ${String(directError)}` : ""}`, { cause: directError });
}
function modeIds(value) {
    const result = new Set();
    const visit = (item) => {
        if (Array.isArray(item)) {
            for (const child of item)
                visit(child);
            return;
        }
        if (!item || typeof item !== "object")
            return;
        const record = item;
        const id = stringField(record, ["id", "modeId", "mode_id"]);
        if (id &&
            ("label" in record ||
                "description" in record ||
                "colorTier" in record ||
                "isDefault" in record)) {
            result.add(id);
        }
        for (const child of Object.values(record))
            visit(child);
    };
    visit(value);
    return [...result];
}
function stringField(record, keys) {
    for (const key of keys) {
        if (typeof record[key] === "string" && record[key])
            return record[key];
    }
    return undefined;
}
//# sourceMappingURL=modePreflight.js.map