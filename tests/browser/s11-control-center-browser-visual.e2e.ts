import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  ControlCenterJourneyFixture,
  JourneySetupError,
  sanitizeText,
  writeSetupFailureEvidence,
  type DurableFixtureOperation,
  type FailureClassification,
  type ReleaseRecord,
  type StartResult
} from "./fixture/controlCenterJourney";

test.setTimeout(20 * 60_000);

function unwrapOperationId(value: unknown): string {
  return String(value ?? "").replace(/^operation:/, "");
}

function operationArticle(page: Page, operationId: string): Locator {
  return page.getByRole("article").filter({ hasText: operationId.slice(0, 12) }).first();
}

function decisionCard(page: Page): Locator {
  return page.locator("section.decision-request").first();
}

function setupClassification(error: unknown): FailureClassification | "TEST_DEFECT" {
  if (error instanceof JourneySetupError) return error.classification;
  if (error && typeof error === "object" && "classification" in error) {
    const value = (error as { classification?: unknown }).classification;
    if (typeof value === "string") return value as FailureClassification;
  }
  return "TEST_DEFECT";
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

let fixture: ControlCenterJourneyFixture;
let context: BrowserContext;
let page: Page;
let operation: DurableFixtureOperation;
let start: StartResult;
let durable: ReleaseRecord;

test.beforeAll(async ({ browser }) => {
  fixture = await ControlCenterJourneyFixture.create();
  await fixture.initializeConsumerRoot();
  start = await fixture.startCandidate();
  await fixture.establishChangeOperation();
  operation = fixture.operation!;
  durable = await fixture.readOperation();
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(start.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect.poll(() => page.url().includes("pair="), { timeout: 30_000, message: "the UI must consume and clear the #pair fragment" }).toBe(false);
  await expect(page.getByText("Paired private session")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('header [aria-label="Status: connected"]')).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  try { await context?.close(); } catch { /* context already closed */ }
  try {
    await fixture?.cleanup();
    await fixture?.removeConsumerRoot();
    await fixture?.writeEvidence({
      slice: "S11",
      lane: "BROWSER/VISUAL",
      boundary: "real candidate build + real Control Center UI + real controller + real Playwright Chromium; scripted deterministic Paseo provider boundary (not REAL_PROVIDER certification)",
      playwrightRunner: "pinned candidate node_modules/.bin/playwright"
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`S11 evidence write failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
  }
});

test("S11 browser | rendered Control Center projection is candidate-bound and traceable", async ({}, testInfo) => {
  const recorder = fixture.recorder;
  const origin = start.controlCenterOrigin;

  await recorder.check("s11.startup.candidate-identity", "PRODUCT_DEFECT", () => {
    expect(start.exitCode).toBe(0);
    expect(start.controlCenterSession).toBe("started");
    expect(fixture.buildIdentity.releaseId).toBeTruthy();
    expect(fixture.buildIdentity.gitSha).toBeTruthy();
  });
  await recorder.check("s11.pairing.session-cookie-hardened", "PRODUCT_DEFECT", async () => {
    const session = (await context.cookies()).find((cookie) => cookie.name === "aeh_control_session");
    expect(session).toBeDefined();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe("Strict");
  });
  await recorder.check("s11.projection.rendered-operation-card", "PRODUCT_DEFECT", async () => {
    const article = operationArticle(page, operation.operationId);
    await expect(article).toBeVisible({ timeout: 30_000 });
    const text = (await article.innerText()).replace(/\s+/g, " ");
    expect(text).toContain(operation.operationId.slice(0, 12));
    expect(text).toContain(String(durable.phase));
    await expect(article.locator(`[aria-label="Status: ${String(durable.status).toLowerCase()}"]`)).toBeVisible();
  });
  await recorder.check("s11.projection.rendered-decision-scope", "PRODUCT_DEFECT", async () => {
    const scope = page.getByRole("region", { name: "Current decision scope" });
    await expect(scope).toBeVisible({ timeout: 30_000 });
    const rendered = await scope.locator("dl > div").evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
      node.querySelector("dt")?.textContent?.trim() ?? "",
      node.querySelector("dd")?.textContent?.trim() ?? ""
    ])));
    const expected: Record<string, string> = {
      "Operation": operation.operationId,
      "Candidate digest": operation.candidateDigest,
      "Policy digest": operation.policyDigest,
      "Execution revision": String(operation.operationExecutionRevision),
      "Controller epoch": String(operation.controllerEpoch),
      "Decision request": operation.requestId
    };
    for (const [label, value] of Object.entries(expected)) {
      expect(rendered[label], `rendered scope is missing '${label}' (rendered: ${JSON.stringify(rendered)})`).toBe(value);
    }
  });
  await recorder.check("s11.projection.rendered-choice", "PRODUCT_DEFECT", async () => {
    const card = decisionCard(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    expect(await card.innerText()).toContain(durable.decisionRequest.issue);
    await expect(card.locator(`input[type="radio"][value="${operation.choiceId}"]`)).toHaveCount(1);
  });
  await recorder.check("s11.projection.build-identity-matches-candidate", "PRODUCT_DEFECT", async () => {
    const footer = page.locator("footer");
    await expect(footer).toContainText(fixture.buildIdentity.packageVersion);
    await expect(footer).toContainText(fixture.buildIdentity.releaseId);
  });
  await recorder.check("s11.browser.sanitized-screenshot", "TEST_DEFECT", async () => {
    const screenshot = await fixture.screenshot(page, "s11-browser-projection");
    await testInfo.attach("s11-browser-projection", { path: screenshot.file, contentType: "image/png" });
    recorder.note("s11BrowserScreenshot", { ...screenshot, capturedAfterPairingFragmentRemoval: true });
  });
  const failures = recorder.failures();
  expect(failures.map((failure) => `${failure.classification ?? "UNCLASSIFIED"}: ${failure.name} :: ${failure.error ?? ""}`.slice(0, 400)), "the S11 browser journey must satisfy every frozen contract assertion").toEqual([]);
});

test("S11 visual | rendered projection screenshots are stable and digest-bound", async ({}, testInfo) => {
  const recorder = fixture.recorder;
  const heading = page.getByRole("heading", { name: "Engineering signal, at a glance." });
  await expect(heading).toBeVisible({ timeout: 30_000 });

  await recorder.check("s11.visual.element-geometry", "PRODUCT_DEFECT", async () => {
    const box = await heading.boundingBox();
    expect(box, "the rendered heading must have a measurable box").not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(10);
  });

  await recorder.check("s11.visual.render-stability", "PRODUCT_DEFECT", async () => {
    const first = await heading.screenshot({ animations: "disabled" });
    const second = await heading.screenshot({ animations: "disabled" });
    expect(sha256(first)).toBe(sha256(second));
    expect(first.byteLength).toBeGreaterThan(500);
  });

  await recorder.check("s11.visual.comparator-baseline", "TEST_DEFECT", async () => {
    await expect(heading).toHaveScreenshot("s11-control-center-heading.png", { animations: "disabled", maxDiffPixelRatio: 0.05 });
  });

  await recorder.check("s11.visual.artifacts-captured", "TEST_DEFECT", async () => {
    const directory = fixture.evidenceDirectory();
    await fs.mkdir(directory, { recursive: true });
    const card = decisionCard(page);
    const targets: Array<{ name: string; locator: Locator }> = [
      { name: "s11-visual-heading", locator: heading },
      { name: "s11-visual-decision-card", locator: card },
      { name: "s11-visual-footer", locator: page.locator("footer") }
    ];
    const captured: Array<{ name: string; file: string; sha256: string; bytes: number }> = [];
    for (const target of targets) {
      await expect(target.locator).toBeVisible({ timeout: 30_000 });
      const file = path.join(directory, `${target.name}.png`);
      const buffer = await target.locator.screenshot({ animations: "disabled", path: file });
      expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      await testInfo.attach(target.name, { path: file, contentType: "image/png" });
      captured.push({ name: target.name, file: path.relative(fixture.repoRoot, file), sha256: sha256(buffer), bytes: buffer.byteLength });
    }
    recorder.note("s11VisualArtifacts", captured);
    expect(captured.length).toBe(3);
    expect(captured.every((item) => item.bytes > 500)).toBe(true);
  });

  const failures = recorder.failures();
  expect(failures.map((failure) => `${failure.classification ?? "UNCLASSIFIED"}: ${failure.name} :: ${failure.error ?? ""}`.slice(0, 400)), "the S11 visual journey must satisfy every frozen contract assertion").toEqual([]);
});
