import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessProjectConfig, OrganizationPolicySource } from "../core/types.js";
import { commandExists, runProcess } from "../utils/process.js";

export interface PolicyBundleFile { path: string; sha256: string; }
export interface OrganizationPolicyBundleManifest {
  version: 1;
  name: string;
  extends?: string[];
  policyDirs?: string[];
  files: PolicyBundleFile[];
}
export interface ResolvedPolicyBundle { name: string; root: string; manifestSha256: string; verifiedSignature: boolean; policyDirs: string[]; extends: string[]; }
export interface PolicyBundleResolution { bundles: ResolvedPolicyBundle[]; policyDirs: string[]; issues: string[]; }

export async function resolveOrganizationPolicyBundles(root: string, config: HarnessProjectConfig): Promise<PolicyBundleResolution> {
  const settings = config.organization?.policyBundles;
  const sources = settings?.sources ?? [];
  if (!sources.length) return { bundles: [], policyDirs: [], issues: [] };
  const cacheRoot = path.resolve(root, settings?.cacheDir ?? ".harness/policy-bundles");
  await fs.mkdir(cacheRoot, { recursive: true });
  const byName = new Map(sources.map((source) => [source.name, source]));
  const resolved = new Map<string, ResolvedPolicyBundle>();
  const issues: string[] = [];
  const visiting = new Set<string>();

  const visit = async (name: string): Promise<void> => {
    if (resolved.has(name)) return;
    if (visiting.has(name)) throw new Error(`Organization policy bundle inheritance cycle at ${name}.`);
    const source = byName.get(name); if (!source) throw new Error(`Organization policy bundle '${name}' is referenced but not configured.`);
    visiting.add(name);
    try {
      const bundle = await materializeBundle(root, cacheRoot, source);
      for (const parent of bundle.extends) await visit(parent);
      resolved.set(name, bundle);
    } catch (error) {
      const message = `${name}: ${String(error)}`; issues.push(message);
      if (source.required !== false || settings?.required === true) throw new Error(`Required organization policy bundle failed: ${message}`);
    } finally { visiting.delete(name); }
  };
  for (const source of sources) await visit(source.name);
  const bundles = [...resolved.values()];
  return { bundles, policyDirs: [...new Set(bundles.flatMap((bundle) => bundle.policyDirs))], issues };
}

export function withOrganizationPolicies(config: HarnessProjectConfig, resolution: PolicyBundleResolution): HarnessProjectConfig {
  if (!resolution.policyDirs.length) return config;
  const existing = config.validation?.opa?.policyDirs ?? [];
  return {
    ...config,
    validation: {
      ...config.validation,
      opa: { ...config.validation?.opa, enabled: config.validation?.opa?.enabled ?? true, policyDirs: [...new Set([...existing, ...resolution.policyDirs])] }
    }
  };
}

async function materializeBundle(projectRoot: string, cacheRoot: string, source: OrganizationPolicySource): Promise<ResolvedPolicyBundle> {
  const target = path.join(cacheRoot, safe(source.name));
  await fs.rm(target, { recursive: true, force: true }); await fs.mkdir(target, { recursive: true });
  const loaded = source.path ? await loadLocalManifest(projectRoot, source.path) : await loadRemoteManifest(source.url!);
  if (loaded.manifest.name !== source.name) throw new Error(`manifest name '${loaded.manifest.name}' does not match configured source '${source.name}'.`);
  const manifestHash = sha256(loaded.raw);
  if (source.sha256 && source.sha256 !== manifestHash) throw new Error(`manifest SHA-256 mismatch: expected ${source.sha256}, got ${manifestHash}.`);
  const manifestFile = path.join(target, "bundle.json"); await fs.writeFile(manifestFile, loaded.raw);
  let verifiedSignature = false;
  if (source.signature || source.publicKey) {
    if (!source.signature || !source.publicKey) throw new Error("signed bundle requires both signature and publicKey.");
    verifiedSignature = await verifySignature(projectRoot, manifestFile, source.signature, source.publicKey);
    if (!verifiedSignature) throw new Error("cosign signature verification failed.");
  }
  for (const file of loaded.manifest.files) {
    if (file.path.includes("..") || path.isAbsolute(file.path)) throw new Error(`unsafe bundle file path ${file.path}.`);
    const content = source.path ? await readLocalBundleFile(projectRoot, source.path, file.path) : await readRemoteBundleFile(source.url!, file.path);
    const actual = sha256(content); if (actual !== file.sha256) throw new Error(`${file.path} SHA-256 mismatch: expected ${file.sha256}, got ${actual}.`);
    const destination = path.join(target, file.path); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, content);
  }
  const policyDirs = (loaded.manifest.policyDirs?.length ? loaded.manifest.policyDirs : ["policies"]).map((relative) => path.relative(projectRoot, path.resolve(target, relative)).replaceAll("\\", "/"));
  return { name: source.name, root: target, manifestSha256: manifestHash, verifiedSignature, policyDirs, extends: loaded.manifest.extends ?? [] };
}

async function loadLocalManifest(projectRoot: string, configuredPath: string): Promise<{ manifest: OrganizationPolicyBundleManifest; raw: Buffer }> {
  const source = path.resolve(projectRoot, configuredPath); const stat = await fs.stat(source); const manifestFile = stat.isDirectory() ? path.join(source, "bundle.json") : source;
  const raw = await fs.readFile(manifestFile); return { manifest: parseManifest(raw), raw };
}
async function loadRemoteManifest(url: string): Promise<{ manifest: OrganizationPolicyBundleManifest; raw: Buffer }> {
  const response = await fetch(url); if (!response.ok) throw new Error(`unable to fetch manifest ${url}: HTTP ${response.status}`); const raw = Buffer.from(await response.arrayBuffer()); return { manifest: parseManifest(raw), raw };
}
function parseManifest(raw: Buffer): OrganizationPolicyBundleManifest {
  const value = JSON.parse(raw.toString("utf8")) as OrganizationPolicyBundleManifest;
  if (value.version !== 1 || !value.name || !Array.isArray(value.files)) throw new Error("invalid organization policy bundle manifest.");
  for (const file of value.files) if (!file.path || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`invalid bundle file declaration ${file.path ?? "<missing>"}.`);
  return value;
}
async function readLocalBundleFile(projectRoot: string, configuredPath: string, relative: string): Promise<Buffer> { const source = path.resolve(projectRoot, configuredPath); const stat = await fs.stat(source); const base = stat.isDirectory() ? source : path.dirname(source); return fs.readFile(path.resolve(base, relative)); }
async function readRemoteBundleFile(manifestUrl: string, relative: string): Promise<Buffer> { const url = new URL(relative, manifestUrl).toString(); const response = await fetch(url); if (!response.ok) throw new Error(`unable to fetch bundle file ${url}: HTTP ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
async function verifySignature(root: string, manifestFile: string, signature: string, publicKey: string): Promise<boolean> {
  if (!(await commandExists("cosign", root))) throw new Error("cosign is required to verify the configured organization policy bundle signature.");
  const signaturePath = path.resolve(root, signature); const keyPath = path.resolve(root, publicKey);
  const result = await runProcess(`cosign verify-blob --key ${quote(keyPath)} --signature ${quote(signaturePath)} ${quote(manifestFile)}`, { cwd: root, timeoutMs: 60_000 });
  return result.exitCode === 0;
}
function sha256(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-"); }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
