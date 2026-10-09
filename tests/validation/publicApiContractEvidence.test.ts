import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessProjectConfig, TaskContract } from "../../src/core/types.js";
import { PactContractTestingProvider } from "../../src/providers/validation/pact.js";
import type { ValidationProviderContext } from "../../src/providers/validation/types.js";
import { normalizePactOutput, parseToolEvidenceResult } from "../../src/validators/toolEvidence.js";

const REPO_ROOT = path.resolve(process.cwd());
const SCRIPT = path.join(REPO_ROOT, "scripts", "publicApiContract.mjs");
const CANONICAL_COMMAND = "node scripts/publicApiContract.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function runScript(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 });
  return { status: result.status ?? 2, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function rawDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-trackf-raw-"));
  roots.push(dir);
  return dir;
}

function providerContext(directory: string, command: string): ValidationProviderContext {
  const config: HarnessProjectConfig = { version: 1, project: { name: "contract-evidence-track-f" }, evidence: { outputDir: ".harness/evidence" } };
  const contract: TaskContract = { version: 1, task: { id: "TRACK-F", title: "contract evidence unblock" } };
  return {
    root: REPO_ROOT,
    config,
    contract,
    capability: "contract-test",
    spec: { id: "contract-test", adapter: "contract-test", command, required: true },
    rawArtifactDirectory: directory,
    baseRef: "HEAD"
  };
}

describe("public-api contract structured evidence (Track F)", () => {
  it("emits a versioned interaction array with --json (all pass on this checkout)", () => {
    const run = runScript(["--json"]);
    expect(run.status).toBe(0);
    const payload = JSON.parse(run.stdout) as {
      version: unknown;
      tool: unknown;
      interactions: Array<{ id: unknown; name: unknown; status: unknown; evidence: unknown }>;
      summary: { total: unknown; passed: unknown; failed: unknown };
    };
    expect(payload.version).toBe(1);
    expect(payload.tool).toBe("aeh-public-api-contract");
    expect(Array.isArray(payload.interactions)).toBe(true);
    expect(payload.interactions.length).toBeGreaterThan(0);
    for (const item of payload.interactions) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.name).toBe("string");
      expect(item.status).toBe("pass");
      expect(typeof item.evidence).toBe("string");
    }
    expect(payload.summary.total).toBe(payload.interactions.length);
    expect(payload.summary.failed).toBe(0);
    // The Pact normalizer accepts exactly this schema: valid with zero findings.
    const parsed = parseToolEvidenceResult("pact", run.stdout);
    expect(parsed.valid).toBe(true);
    expect(parsed.findings).toEqual([]);
    expect(normalizePactOutput(payload)).toEqual([]);
  });

  it("leaves the default stdout text format and exit codes unchanged", () => {
    const run = runScript([]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("PUBLIC_API_CONTRACT_PASS");
    expect(() => JSON.parse(run.stdout)).toThrow();
  });

  it("wires the canonical lane command to --json and normalizes to PASS with total>0", async () => {
    const provider = new PactContractTestingProvider();
    const context = providerContext(await rawDir(), CANONICAL_COMMAND);
    const plan = await provider.plan(context);
    expect(plan.command).toBe(`${CANONICAL_COMMAND} --json`);
    const execution = await provider.execute(context, plan);
    expect(execution.exitCode).toBe(0);
    const result = await provider.normalize(context, execution);
    expect(result.status).toBe("PASS");
    expect(result.summary.total).toBeGreaterThan(0);
    expect(result.summary.failed).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("leaves ad-hoc text invocations untouched so they still fail closed with EMPTY_TEST_EVIDENCE", async () => {
    const provider = new PactContractTestingProvider();
    const context = providerContext(await rawDir(), `node ${SCRIPT} ${REPO_ROOT}`);
    const plan = await provider.plan(context);
    expect(plan.command).not.toContain("--json");
    const text = runScript([]);
    const result = await provider.normalize(context, { plan, exitCode: 0, stdout: text.stdout, stderr: "", durationMs: 5, rawArtifact: "" });
    expect(result.status).toBe("FAIL");
    expect(result.summary.total).toBe(0);
    expect(JSON.stringify(result.failures)).toContain("EMPTY_TEST_EVIDENCE");
  });

  it("fail-closes malformed JSON evidence and keeps the Pact path strict", async () => {
    const provider = new PactContractTestingProvider();
    const context = providerContext(await rawDir(), CANONICAL_COMMAND);
    const plan = await provider.plan(context);
    const normalize = (stdout: string, exitCode = 0) =>
      provider.normalize(context, { plan, exitCode, stdout, stderr: "", durationMs: 5, rawArtifact: "" });

    // Truncated JSON: no parseable interactions -> EMPTY_TEST_EVIDENCE, never PASS.
    const truncated = await normalize('{"version":1,"tool":"aeh-public-api-contract","interactions":[');
    expect(truncated.status).toBe("FAIL");
    expect(truncated.summary.total).toBe(0);
    expect(JSON.stringify(truncated.failures)).toContain("EMPTY_TEST_EVIDENCE");

    // Marker present but interactions malformed -> explicit fail-closed finding, never PASS.
    const malformed = await normalize(JSON.stringify({ version: 1, tool: "aeh-public-api-contract", interactions: "not-an-array" }));
    expect(malformed.status).toBe("FAIL");
    expect(malformed.failures.length).toBeGreaterThan(0);

    // Unsupported schema version fails with an explicit version error, never a silent PASS.
    const future = await normalize(JSON.stringify({
      version: 999,
      tool: "aeh-public-api-contract",
      interactions: [{ id: "X", name: "X", status: "pass", evidence: "ok" }],
      summary: { total: 1, passed: 1, failed: 0 }
    }));
    expect(future.status).toBe("FAIL");
    expect(JSON.stringify(future.failures)).toMatch(/unsupported.*version|version.*unsupported/i);

    // Genuine Pact JSON handling is byte-identical: passing interactions stay silent.
    const pactPass = parseToolEvidenceResult("pact", JSON.stringify({ interactions: [{ description: "a consumer pact", status: "passed" }] }));
    expect(pactPass.valid).toBe(true);
    expect(pactPass.findings).toEqual([]);

    // Genuine Pact failures still surface one finding per failed interaction.
    const pactFail = parseToolEvidenceResult("pact", JSON.stringify({ interactions: [{ description: "a consumer pact", status: "failed", error: "boom" }] }));
    expect(pactFail.valid).toBe(true);
    expect(pactFail.findings.length).toBe(1);

    // JUnit handling is unchanged.
    const junit = parseToolEvidenceResult(
      "pact",
      '<testsuite name="contract"><testcase classname="c" name="pact one"><failure message="mismatch">expected 200 got 500</failure></testcase></testsuite>'
    );
    expect(junit.valid).toBe(true);
    expect(junit.findings.length).toBe(1);
  });
});
