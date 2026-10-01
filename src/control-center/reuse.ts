import path from "node:path";
import { runtimeProjectId } from "../runtime/managed.js";
import type { RuntimeSnapshotV1 } from "../runtime/supervisorV2.js";

export interface ReusableControlCenterV1 {
  url: string;
}

/** Select a project-owned Control Center only when it supports current-session Lead routing. */
export function reusableControlCenterFromSnapshot(root: string, snapshot: RuntimeSnapshotV1): ReusableControlCenterV1 | undefined {
  const canonicalRoot = path.resolve(root);
  const serviceId = `control-center:${runtimeProjectId(canonicalRoot)}`;
  const matches = snapshot.services.filter((service) => service.serviceId === serviceId);
  if (matches.length !== 1) return undefined;

  const service = matches[0];
  if (service.kind !== "control-center" || service.status !== "READY" || service.canonicalRoot !== canonicalRoot
    || service.metadata.leadBindingMode !== "validated-current-session-v1" || typeof service.healthUrl !== "string") return undefined;

  let url: URL;
  try { url = new URL(service.healthUrl); }
  catch { return undefined; }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname.toLowerCase())
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;

  return { url: url.origin + "/" };
}

export async function controlCenterHealthCheck(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    const response = await fetch(new URL("health", url), { signal: controller.signal, redirect: "error" });
    if (!response.ok) return false;
    const value = await response.json() as { status?: unknown; version?: unknown };
    return value.status === "ok" && value.version === 1;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
