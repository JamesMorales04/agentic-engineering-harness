import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/core/config.js";

type JsonObject = Record<string, any>;

const schemaUrl = new URL("../schemas/project.schema.json", import.meta.url);
const templateUrl = new URL("../templates/project.yaml", import.meta.url);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function readProvenanceSchema(): Promise<JsonObject> {
  const schema = JSON.parse(await fs.readFile(schemaUrl, "utf8")) as JsonObject;
  return schema.properties.provenance as JsonObject;
}

function collectFlagPaths(ifSchema: JsonObject | undefined): string[] {
  return ((ifSchema?.anyOf ?? []) as JsonObject[]).map((branch) => {
    for (const [topProperty, topSchema] of Object.entries<JsonObject>(branch.properties ?? {})) {
      if (topSchema?.const === true) return topProperty;
      for (const [nestedProperty, nestedSchema] of Object.entries<JsonObject>(topSchema?.properties ?? {})) {
        if (nestedSchema?.const === true) return `${topProperty}.${nestedProperty}`;
      }
    }
    return "";
  });
}

function findFlagBranch(condition: JsonObject | undefined, flagPath: string[]): JsonObject {
  const branch = ((condition?.anyOf ?? []) as JsonObject[]).find((candidate) => {
    const top = (candidate.properties ?? {})[flagPath[0]] as JsonObject | undefined;
    if (!top) return false;
    if (flagPath.length === 1) return top.const === true;
    return Boolean((top.properties ?? {})[flagPath[1]]);
  });
  if (!branch) throw new Error(`schema has no if branch inspecting provenance.${flagPath.join(".")}`);
  return branch;
}

function expectFlagBranchGuarded(branch: JsonObject, flagPath: string[]): void {
  const label = `provenance.${flagPath.join(".")}`;
  expect.soft(Array.isArray(branch.required), `if branch for ${label} must declare a required array before const:true can match`).toBe(true);
  const branchRequired = Array.isArray(branch.required) ? (branch.required as unknown[]) : [];
  expect.soft(branchRequired, `if branch for ${label} must require "${flagPath[0]}"`).toContain(flagPath[0]);
  const top = (branch.properties ?? {})[flagPath[0]] as JsonObject | undefined;
  if (flagPath.length === 1) {
    expect.soft(top?.const, `if branch for ${label} must match const:true`).toBe(true);
    return;
  }
  expect.soft(Array.isArray(top?.required), `if branch for ${label} must require "${flagPath[1]}" inside "${flagPath[0]}" before const:true can match`).toBe(true);
  const nestedRequired = Array.isArray(top?.required) ? (top.required as unknown[]) : [];
  expect.soft(nestedRequired, `if branch for ${label} must require "${flagPath[1]}" inside "${flagPath[0]}"`).toContain(flagPath[1]);
  expect.soft((top?.properties ?? {})[flagPath[1]]?.const, `if branch for ${label} must match const:true`).toBe(true);
}

const ARTIFACT_FLAG_CASES = [
  { label: "provenance.required", path: ["required"] },
  { label: "provenance.sbom.required", path: ["sbom", "required"] },
  { label: "provenance.signing.required", path: ["signing", "required"] },
  { label: "provenance.verification.required", path: ["verification", "required"] },
];

const EVIDENCE_FLAG_CASES = [
  { label: "provenance.signing.required", path: ["signing", "required"] },
  { label: "provenance.verification.required", path: ["verification", "required"] },
];

async function writeProjectConfig(provenance: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s7-schema-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, ".harness"), { recursive: true });
  await fs.writeFile(path.join(root, ".harness", "project.yaml"), YAML.stringify({ version: 1, project: { name: "s7-provenance" }, provenance }), "utf8");
  return root;
}

function provenanceOf(config: { provenance?: unknown }): JsonObject | undefined {
  return config.provenance as unknown as JsonObject | undefined;
}

describe("S7 provenance JSON Schema guards", () => {
  describe("artifact condition", () => {
    it.each(ARTIFACT_FLAG_CASES)("$label branch guards const:true with required arrays", async ({ path: flagPath }) => {
      const provenance = await readProvenanceSchema();
      expectFlagBranchGuarded(findFlagBranch(provenance.allOf?.[0]?.if, flagPath), flagPath);
    });
  });

  describe("evidence condition", () => {
    it.each(EVIDENCE_FLAG_CASES)("$label branch guards const:true with required arrays", async ({ path: flagPath }) => {
      const provenance = await readProvenanceSchema();
      expectFlagBranchGuarded(findFlagBranch(provenance.allOf?.[1]?.if, flagPath), flagPath);
    });
  });

  it("requires artifact whenever any explicitly true provenance, SBOM, signing or verification flag is present", async () => {
    const provenance = await readProvenanceSchema();
    const condition = provenance.allOf?.[0] as JsonObject | undefined;
    expect(collectFlagPaths(condition?.if).sort()).toEqual(["required", "sbom.required", "signing.required", "verification.required"]);
    expect((condition?.then?.required ?? []) as string[]).toContain("artifact");
  });

  it("requires signing and verification key material whenever signing or verification is explicitly true", async () => {
    const provenance = await readProvenanceSchema();
    const condition = provenance.allOf?.[1] as JsonObject | undefined;
    expect(collectFlagPaths(condition?.if).sort()).toEqual(["signing.required", "verification.required"]);
    const then = condition?.then as JsonObject | undefined;
    expect((then?.required ?? []) as string[]).toEqual(expect.arrayContaining(["signing", "verification"]));
    expect((then?.properties?.signing?.required ?? []) as string[]).toContain("key");
    expect((then?.properties?.verification?.required ?? []) as string[]).toContain("publicKey");
  });
});

describe("S7 provenance config loading", () => {
  it("accepts the shipped template without artifact or signing values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-s7-template-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.copyFile(templateUrl, path.join(root, ".harness", "project.yaml"));
    const provenance = provenanceOf(await loadProjectConfig(root));
    expect(provenance?.outputDir).toBe(".harness/provenance");
    expect(provenance?.artifact).toBeUndefined();
    expect(provenance?.signing).toBeUndefined();
    expect(provenance?.verification).toBeUndefined();
  });

  it("accepts minimal non-strict provenance without artifact or signing values", async () => {
    const root = await writeProjectConfig({ outputDir: ".harness/provenance" });
    const provenance = provenanceOf(await loadProjectConfig(root));
    expect(provenance?.outputDir).toBe(".harness/provenance");
    expect(provenance?.artifact).toBeUndefined();
    expect(provenance?.signing).toBeUndefined();
  });

  it("accepts explicit false or absent flags without artifact or signing values", async () => {
    const root = await writeProjectConfig({ outputDir: ".harness/provenance", required: false, sbom: { required: false }, signing: { required: false }, verification: { required: false } });
    const provenance = provenanceOf(await loadProjectConfig(root));
    expect(provenance?.artifact).toBeUndefined();
    expect(provenance?.signing).toEqual({ required: false });
    expect(provenance?.verification).toEqual({ required: false });
  });

  it("accepts strict provenance with artifact and complete signing evidence", async () => {
    const root = await writeProjectConfig({ required: true, artifact: "dist/pkg.tgz", sbom: { required: true }, signing: { required: true, key: "signing.key" }, verification: { required: true, publicKey: "verification.pub" } });
    const provenance = provenanceOf(await loadProjectConfig(root));
    expect(provenance?.artifact).toBe("dist/pkg.tgz");
  });

  it("accepts strict provenance when only provenance and SBOM requirements are true", async () => {
    const root = await writeProjectConfig({ required: true, artifact: "dist/pkg.tgz", sbom: { required: true } });
    const provenance = provenanceOf(await loadProjectConfig(root));
    expect(provenance?.artifact).toBe("dist/pkg.tgz");
    expect(provenance?.signing).toBeUndefined();
    expect(provenance?.verification).toBeUndefined();
  });

  it.each([
    { label: "provenance.required", provenance: { required: true } },
    { label: "sbom.required", provenance: { sbom: { required: true } } },
    { label: "signing.required", provenance: { signing: { required: true, key: "signing.key" }, verification: { publicKey: "verification.pub" } } },
    { label: "verification.required", provenance: { verification: { required: true, publicKey: "verification.pub" }, signing: { key: "signing.key" } } },
  ])("rejects missing artifact when $label is explicitly true", async ({ provenance }) => {
    const root = await writeProjectConfig(provenance);
    await expect(loadProjectConfig(root)).rejects.toThrow(/artifact/);
  });

  it.each([
    { label: "signing.required without a verification public key", provenance: { required: true, artifact: "dist/pkg.tgz", signing: { required: true, key: "signing.key" } } },
    { label: "signing.required without a signing key", provenance: { required: true, artifact: "dist/pkg.tgz", signing: { required: true }, verification: { publicKey: "verification.pub" } } },
    { label: "verification.required without a signing key", provenance: { required: true, artifact: "dist/pkg.tgz", verification: { required: true, publicKey: "verification.pub" } } },
    { label: "verification.required without a verification public key", provenance: { required: true, artifact: "dist/pkg.tgz", verification: { required: true }, signing: { key: "signing.key" } } },
  ])("rejects $label even when artifact is present", async ({ provenance }) => {
    const root = await writeProjectConfig(provenance);
    await expect(loadProjectConfig(root)).rejects.toThrow(/signing key and a verification public key/);
  });
});
