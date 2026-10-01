import { sha256Canonical } from "../core/digest.js";
export function sandboxPolicyDigest(config, selection, risk = "low") {
    const policy = {
        risk,
        sandbox: config.security?.sandbox ?? null,
        runtimeAdapter: selection.runtimeAdapter,
        transport: selection.transport,
        permissions: selection.permissions
    };
    return sha256Canonical(policy);
}
export function enforceSandboxPolicy(selection, config, risk = "low") {
    const sandbox = config.security?.sandbox;
    const force = (sandbox?.forceForRisks ?? []).includes(risk);
    const required = sandbox?.required === true || force;
    const provider = sandbox?.provider ?? "podman";
    if (!required)
        return { required: false, provider, reasons: [], selection };
    if (provider === "none")
        throw new Error(`Sandbox is required for ${risk}-risk work but security.sandbox.provider is none.`);
    if (selection.runtimeAdapter !== "opencode")
        throw new Error(`Sandbox policy requires ${provider}, but runtime ${selection.runtimeAdapter} is not supported by the hardened worker sandbox.`);
    if (!sandbox?.image)
        throw new Error("Sandbox policy requires security.sandbox.image.");
    return { required: true, provider, reasons: force ? [`risk:${risk}`] : ["security.sandbox.required"], selection: { ...selection, transport: provider === "podman" ? "podman" : selection.transport } };
}
export function hardenedPodmanArgs(config, selection, writable, options = {}) {
    const sandbox = config.security?.sandbox;
    const args = ["--rm", "-i", "--userns=keep-id"];
    if (sandbox?.readOnlyRoot !== false)
        args.push("--read-only");
    if (sandbox?.capDropAll !== false)
        args.push("--cap-drop=ALL");
    if (sandbox?.noNewPrivileges !== false)
        args.push("--security-opt=no-new-privileges");
    args.push(`--pids-limit=${sandbox?.pidsLimit ?? 512}`);
    if (sandbox?.memory)
        args.push(`--memory=${sandbox.memory}`);
    if (sandbox?.cpus)
        args.push(`--cpus=${sandbox.cpus}`);
    if (sandbox?.network === false || selection.permissions.network === "deny")
        args.push("--network=none");
    const tmpfs = sandbox?.tmpfs ?? ["/tmp:rw,nosuid,nodev,noexec,size=1g"];
    for (const mount of tmpfs)
        args.push(`--tmpfs=${mount}`);
    if (sandbox?.ephemeralHome !== false && !options.persistentIsolatedHome) {
        args.push("--tmpfs=/home/aeh:rw,nosuid,nodev,size=256m");
        args.push("--env=HOME=/home/aeh");
    }
    if (!writable)
        args.push("--env=AEH_WORKSPACE_READ_ONLY=1");
    if (sandbox?.extraArgs?.length)
        throw new Error("security.sandbox.extraArgs is disabled because arbitrary Podman flags can weaken the hardened boundary.");
    return args;
}
export function sandboxImage(config) {
    const sandbox = config.security?.sandbox;
    if (!sandbox?.image)
        throw new Error("security.sandbox.image is required for Podman execution.");
    if (!sandbox.imageDigest || sandbox.image.includes("@sha256:"))
        return sandbox.image;
    const digest = sandbox.imageDigest.startsWith("sha256:") ? sandbox.imageDigest : `sha256:${sandbox.imageDigest}`;
    return `${sandbox.image.replace(/:[^/@]+$/, "")}@${digest}`;
}
export function allowedSandboxEnvironment(config, source = process.env) {
    const sandbox = config.security?.sandbox;
    const allowed = new Set(sandbox?.environmentAllowlist ?? []);
    const credentials = new Set(sandbox?.credentialEnvAllowlist ?? []);
    const result = {};
    for (const name of [...allowed, ...credentials])
        if (source[name] !== undefined)
            result[name] = source[name];
    return result;
}
//# sourceMappingURL=sandbox.js.map