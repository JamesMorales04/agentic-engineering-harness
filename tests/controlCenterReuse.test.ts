import path from "node:path";
import { describe, expect, it } from "vitest";
import { reusableControlCenterFromSnapshot } from "../src/control-center/reuse.js";
import {
  runtimeProjectId,
  type RuntimeServiceKindV1,
  type RuntimeServiceStatusV1,
  type RuntimeServiceV1,
  type RuntimeSnapshotV1
} from "../src/runtime/index.js";

const ROOT = path.resolve("/tmp/aeh-s9-r15-control-center-reuse");
const FOREIGN_ROOT = path.resolve("/tmp/aeh-s9-r15-foreign-project");
const PROJECT_ID = runtimeProjectId(ROOT);
const SERVICE_ID = `control-center:${PROJECT_ID}`;
const LEAD_BINDING_MODE = "validated-current-session-v1";
const BASE_URL = "http://127.0.0.1:43123/";
const PAIRING_SECRET = "pairing-secret-must-not-leak";

function service(overrides: Partial<RuntimeServiceV1> = {}): RuntimeServiceV1 {
  return {
    version: 1,
    serviceId: SERVICE_ID,
    kind: "control-center",
    projectId: PROJECT_ID,
    canonicalRoot: ROOT,
    status: "READY",
    ownerId: "control-center:fixture",
    healthUrl: BASE_URL,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
    metadata: { leadBindingMode: LEAD_BINDING_MODE, pairingSecret: PAIRING_SECRET },
    ...overrides
  };
}

function snapshot(services: RuntimeServiceV1[]): RuntimeSnapshotV1 {
  return { version: 1, capturedAt: "2026-01-01T00:00:02.000Z", services, providerLeases: [] };
}

describe("reusableControlCenterFromSnapshot", () => {
  it("selects the base health URL of the single valid control-center record without exposing pairing secrets", () => {
    const result = reusableControlCenterFromSnapshot(ROOT, snapshot([service()]));
    expect(result).toEqual({ url: BASE_URL });
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it("selects the base health URL for a localhost loopback record", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ healthUrl: "http://localhost:43123/" })]))).toEqual({ url: "http://localhost:43123/" });
  });

  it("ignores unrelated records when exactly one record satisfies every condition", () => {
    const foreign = service({
      serviceId: `control-center:${runtimeProjectId(FOREIGN_ROOT)}`,
      projectId: runtimeProjectId(FOREIGN_ROOT),
      canonicalRoot: FOREIGN_ROOT
    });
    const stopped = service({ serviceId: "serena:primary", kind: "serena", status: "STOPPED" });
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([foreign, stopped, service()]))).toEqual({ url: BASE_URL });
  });

  it("returns undefined when the service record is missing", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([]))).toBeUndefined();
  });

  it("returns undefined when only unrelated service records exist", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ serviceId: "paseo:primary", kind: "paseo" })]))).toBeUndefined();
  });

  it("returns undefined for a foreign project record", () => {
    const foreign = service({
      serviceId: `control-center:${runtimeProjectId(FOREIGN_ROOT)}`,
      projectId: runtimeProjectId(FOREIGN_ROOT),
      canonicalRoot: FOREIGN_ROOT
    });
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([foreign]))).toBeUndefined();
  });

  it("returns undefined when the service id does not encode the expected project", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ serviceId: `control-center:${runtimeProjectId(FOREIGN_ROOT)}` })]))).toBeUndefined();
  });

  it("returns undefined when canonicalRoot is not exactly path.resolve(root)", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ canonicalRoot: `${ROOT}/` })]))).toBeUndefined();
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ canonicalRoot: path.join(ROOT, "nested") })]))).toBeUndefined();
  });

  it("returns undefined when duplicate service records satisfy every condition", () => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service(), service({ ownerId: "control-center:duplicate" })]))).toBeUndefined();
  });

  it.each<RuntimeServiceKindV1>(["paseo", "serena", "context", "provider"])("returns undefined for kind %s", (kind) => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ kind })]))).toBeUndefined();
  });

  it.each<RuntimeServiceStatusV1>(["STARTING", "DEGRADED", "STOPPED", "FAILED"])("returns undefined for non-READY status %s", (status) => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ status })]))).toBeUndefined();
  });

  it.each<Record<string, string>>([
    {},
    { leadBindingMode: "" },
    { leadBindingMode: "paired-session-v0" },
    { leadBindingMode: "validated-current-session-v0" },
    { leadBindingMode: "validated-current-session-v2" }
  ])("returns undefined for stale or unsupported lead binding metadata %#", (metadata) => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ metadata })]))).toBeUndefined();
  });

  it("returns undefined when healthUrl is missing", () => {
    const record = service();
    delete record.healthUrl;
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([record]))).toBeUndefined();
  });

  it.each([
    ["https protocol", "https://127.0.0.1:43123/"],
    ["non-loopback host", "http://example.com:43123/"],
    ["lookalike localhost host", "http://localhost.attacker.example:43123/"],
    ["wildcard host", "http://0.0.0.0:43123/"],
    ["path beyond the root", "http://127.0.0.1:43123/healthz"],
    ["query string", "http://127.0.0.1:43123/?token=secret"],
    ["fragment", "http://127.0.0.1:43123/#pairing"],
    ["embedded credentials", "http://user:secret@127.0.0.1:43123/"]
  ])("returns undefined for unsafe healthUrl: %s", (_label, healthUrl) => {
    expect(reusableControlCenterFromSnapshot(ROOT, snapshot([service({ healthUrl })]))).toBeUndefined();
  });
});
