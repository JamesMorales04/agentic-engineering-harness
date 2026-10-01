import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DETERMINISTIC_RUNTIME_ENV,
  deterministicPaseoRuntimeDeps,
  isDeterministicPaseoRuntimeEnabled,
  isDeterministicPaseoSessionId
} from "../src/paseo/deterministicRuntime.js";

const roots: string[] = [];
let previousEnvironment: Record<string, string | undefined> = {};

afterEach(async () => {
  process.env[DETERMINISTIC_RUNTIME_ENV] = previousEnvironment[DETERMINISTIC_RUNTIME_ENV];
  if (previousEnvironment[DETERMINISTIC_RUNTIME_ENV] === undefined) delete process.env[DETERMINISTIC_RUNTIME_ENV];
  delete process.env.AEH_CONTROL_ROOT;
  previousEnvironment = {};
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(script?: unknown): Promise<string> {
  previousEnvironment = { [DETERMINISTIC_RUNTIME_ENV]: process.env[DETERMINISTIC_RUNTIME_ENV] };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-deterministic-runtime-"));
  roots.push(root);
  if (script !== undefined) {
    const file = path.join(root, ".harness", "fixtures", "deterministic-paseo-runtime.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(script, null, 2)}\n`, "utf8");
  }
  return root;
}

function assessmentPrompt(type: string): string {
  return JSON.stringify({ version: 1, assessmentType: type, evidenceRefs: ["request"] });
}

describe("deterministic Paseo runtime boundary", () => {
  it("selects the runtime by its explicit environment gate and recognizes scripted session ids by prefix", async () => {
    delete process.env[DETERMINISTIC_RUNTIME_ENV];
    expect(isDeterministicPaseoRuntimeEnabled()).toBe(false);
    // Lifecycle owners without the runtime environment (for example the paired
    // Control Center performing cancellation) still recognize scripted sessions.
    expect(isDeterministicPaseoSessionId("deterministic:any")).toBe(true);
    expect(isDeterministicPaseoSessionId("real-agent")).toBe(false);
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
    expect(isDeterministicPaseoRuntimeEnabled()).toBe(true);
    expect(isDeterministicPaseoSessionId("deterministic:any")).toBe(true);
  });

  it("materializes idle sessions and keeps inspect/list/probe/labels consistent", async () => {
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
    const root = await fixtureRoot();
    const deps = deterministicPaseoRuntimeDeps();
    const created = await deps.sdk.materialize(root, { title: "idle", provider: "deterministic", cwd: root, labels: { "aeh.role": "Implementer", "aeh.operation": "OP-1" }, waitForFinish: false });
    expect(created.status).toBe("idle");
    expect(isDeterministicPaseoSessionId(created.id)).toBe(true);
    expect(await deps.sdk.probe(root, created.id)).toBe(true);
    expect((await deps.sdk.inspect(root, created.id))?.labels?.["aeh.role"]).toBe("Implementer");
    expect((await deps.sdk.list(root, { "aeh.operation": "OP-1" })).map((record) => record.id)).toEqual([created.id]);
    await deps.updateLabels!(root, created.id, { "aeh.canonical.role": "Implementer" });
    expect((await deps.sdk.inspect(root, created.id))?.labels?.["aeh.canonical.role"]).toBe("Implementer");
    expect(await deps.sdk.probe(root, "deterministic:missing")).toBe(false);
  });

  it("returns a scripted semantic assessment payload through the provider result channel", async () => {
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
    const root = await fixtureRoot({
      version: 1,
      responses: {
        "semantic-assessment:ROUTE": [{ judgment: { type: "ROUTE", recommendedRoute: "FORMAL_SDD" } }],
        "spec-authoring": [{ change: "x", status: "BLOCKED" }]
      }
    });
    const deps = deterministicPaseoRuntimeDeps();
    const outputSchema = { type: "object" };
    const created = await deps.sdk.create(root, {
      title: "assessor",
      provider: "deterministic",
      cwd: root,
      prompt: assessmentPrompt("ROUTE"),
      outputSchema,
      labels: { "aeh.semantic.assessment.type": "ROUTE" },
      waitForFinish: false
    });
    expect(created.status).toBe("idle");
    expect(JSON.parse(created.lastMessage ?? "{}")).toMatchObject({ judgment: { recommendedRoute: "FORMAL_SDD" } });
  });

  it("advances a durable per-key cursor and fails closed when the script is exhausted or absent", async () => {
    process.env[DETERMINISTIC_RUNTIME_ENV] = "1";
    const root = await fixtureRoot({
      version: 1,
      responses: { "semantic-assessment:INTENT": [{ first: true }, { second: true }] }
    });
    const deps = deterministicPaseoRuntimeDeps();
    const options = { title: "intent", provider: "deterministic", cwd: root, prompt: assessmentPrompt("INTENT"), outputSchema: { type: "object" }, labels: { "aeh.semantic.assessment.type": "INTENT" }, waitForFinish: false };
    const first = await deps.sdk.create(root, options);
    const second = await deps.sdk.create(root, options);
    expect(JSON.parse(first.lastMessage ?? "{}")).toEqual({ first: true });
    expect(JSON.parse(second.lastMessage ?? "{}")).toEqual({ second: true });
    const exhausted = await deps.sdk.create(root, options);
    expect(exhausted.status).toBe("failed");
    expect(exhausted.error).toContain("DETERMINISTIC_RUNTIME_SCRIPT_EXHAUSTED");

    const missingRoot = await fixtureRoot();
    const missing = await deterministicPaseoRuntimeDeps().sdk.create(missingRoot, options);
    expect(missing.status).toBe("failed");
    expect(missing.error).toContain("DETERMINISTIC_RUNTIME_SCRIPT_MISSING");
  });
});
