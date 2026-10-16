import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  ControlCenterJourneyFixture,
  JourneySetupError,
  sanitizeText,
  writeSetupFailureEvidence,
  type FailureClassification,
  type StartResult
} from "./fixture/controlCenterJourney";

test.setTimeout(20 * 60_000);

function setupClassification(error: unknown): FailureClassification | "TEST_DEFECT" {
  if (error instanceof JourneySetupError) return error.classification;
  if (error && typeof error === "object" && "classification" in error) {
    const value = (error as { classification?: unknown }).classification;
    if (typeof value === "string") return value as FailureClassification;
  }
  return "TEST_DEFECT";
}

let fixture: ControlCenterJourneyFixture;
let context: BrowserContext;
let page: Page;
let start: StartResult;

async function readCsrf(): Promise<string | undefined> {
  const origin = new URL(start.pairingUrl).origin;
  const response = await context.request.get(`${origin}/api/v1/session`, { headers: { Accept: "application/json" } });
  if (!response.ok()) return undefined;
  return ((await response.json()) as { csrfToken?: string }).csrfToken;
}

async function grantDelegation(delegatePrincipalId: string, expiresAt: string): Promise<void> {
  const origin = new URL(start.pairingUrl).origin;
  const csrf = await readCsrf();
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (csrf) headers["X-AEH-CSRF"] = csrf;
  const response = await context.request.post(`${origin}/api/v1/delegations`, {
    headers,
    data: { delegatePrincipalId, expiresAt }
  });
  if (!response.ok()) throw new Error(`grant failed: ${response.status()} ${sanitizeText(await response.text())}`);
}

function delegationRow(delegatePrincipalId: string) {
  return page.locator(".card", { hasText: "Owner delegation" }).locator(".row", { hasText: delegatePrincipalId }).first();
}

test.beforeAll(async ({ browser }) => {
  fixture = await ControlCenterJourneyFixture.create();
  await fixture.initializeConsumerRoot();
  start = await fixture.startCandidate();
  await fixture.establishChangeOperation();
  context = await browser.newContext();
  page = await context.newPage();
  await page.goto(start.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await expect.poll(() => page.url().includes("pair="), { timeout: 30_000, message: "the UI must consume and clear the #pair fragment" }).toBe(false);
  await expect(page.getByText("Paired private session")).toBeVisible({ timeout: 30_000 });
});

test.afterAll(async () => {
  try { await context?.close(); } catch { /* context already closed */ }
  try {
    await fixture?.cleanup();
    await fixture?.removeConsumerRoot();
    await fixture?.writeEvidence({
      slice: "S12",
      lane: "BROWSER",
      boundary: "real candidate build + real Control Center UI + real controller + real Playwright Chromium; scripted deterministic Paseo provider boundary (not REAL_PROVIDER certification)"
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`S12 evidence write failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
  }
});

test("S12 delegation expiry | countdown renders relative expiry with urgency tones", async () => {
  // Note: issuance rejects already-expired grants, so the expired tone is
  // covered by formatter unit tests; the browser journey stages grants the
  // API accepts and asserts rendered countdown text and tone classes.
  const now = Date.now();
  const cases = [
    { principal: "delegate:s12-normal", expiresAt: new Date(now + 25 * 3_600_000).toISOString(), text: /expires in 1d/, tone: "delegation-expiry-normal" },
    { principal: "delegate:s12-soon", expiresAt: new Date(now + 2 * 3_600_000).toISOString(), text: /expires in \d+h/, tone: "delegation-expiry-expiring-soon" }
  ];
  for (const grant of cases) {
    try {
      await grantDelegation(grant.principal, grant.expiresAt);
    } catch (error) {
      throw new Error(`S12 setup grant failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`, { cause: setupClassification(error) });
    }
  }
  for (const grant of cases) {
    const row = delegationRow(grant.principal);
    await expect(row, `delegation row for ${grant.principal} must render`).toBeVisible({ timeout: 30_000 });
    const countdown = row.locator("span.delegation-expiry").first();
    await expect(countdown, `countdown for ${grant.principal} must render`).toBeVisible({ timeout: 30_000 });
    await expect(countdown).toHaveText(grant.text);
    await expect(countdown).toHaveClass(new RegExp(`\\b${grant.tone}\\b`));
  }
});
