import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  ControlCenterJourneyFixture,
  JourneySetupError,
  sanitizeText,
  writeSetupFailureEvidence,
  type DurableFixtureOperation,
  type FailureClassification,
  type ReleaseRecord
} from "./fixture/controlCenterJourney";

test.setTimeout(20 * 60_000);

function unwrapOperationId(value: unknown): string {
  return String(value ?? "").replace(/^operation:/, "");
}

async function waitForDurable<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for durable state: ${label}${lastError ? ` (last error: ${sanitizeText(String(lastError))})` : ""}`);
}

function operationArticle(page: Page, operationId: string): Locator {
  return page.getByRole("article").filter({ hasText: operationId.slice(0, 12) }).first();
}

function decisionCard(page: Page): Locator {
  return page.locator("section.decision-request").first();
}

async function readOverview(page: Page, origin: string): Promise<Record<string, any>> {
  const response = await page.context().request.get(`${origin}/api/v1/overview`, { headers: { Accept: "application/json" } });
  if (!response.ok()) throw new Error(`overview request failed with status ${response.status()}`);
  return response.json() as Promise<Record<string, any>>;
}

async function readCsrf(page: Page, origin: string): Promise<string> {
  const response = await page.context().request.get(`${origin}/api/v1/session`, { headers: { Accept: "application/json" } });
  if (!response.ok()) throw new Error(`session request failed with status ${response.status()}`);
  return ((await response.json()) as { csrfToken: string }).csrfToken;
}

async function postDecision(page: Page, origin: string, csrf: string | undefined, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
  if (csrf) headers["X-AEH-CSRF"] = csrf;
  const response = await page.context().request.post(`${origin}/api/v1/decisions`, { headers, data: body });
  let responseBody: unknown;
  try { responseBody = await response.json(); } catch { responseBody = undefined; }
  return { status: response.status(), body: responseBody };
}

async function pageDiagnostics(page: Page): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(() => ({ href: location.href, readyState: document.readyState, hasRoot: Boolean(document.getElementById("root")) }));
  } catch (error) {
    return { evaluateFailed: sanitizeText(error instanceof Error ? error.message : String(error)) };
  }
}

function setupClassification(error: unknown): FailureClassification | "TEST_DEFECT" {
  if (error instanceof JourneySetupError) return error.classification;
  if (error && typeof error === "object" && "classification" in error) {
    const value = (error as { classification?: unknown }).classification;
    if (typeof value === "string") return value as FailureClassification;
  }
  return "TEST_DEFECT";
}

test("S9 browser E2E | real Control Center journey: pairing, decision, continuation, controls, cancellation, final projection", async ({ browser }) => {
  let fixture: ControlCenterJourneyFixture | undefined;
  let page: Page | undefined;
  try {
    fixture = await ControlCenterJourneyFixture.create();
  } catch (error) {
    await writeSetupFailureEvidence(error);
    throw new Error(`${setupClassification(error)} :: candidate fixture could not be created :: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
  }
  const journey = fixture;
  const recorder = journey.recorder;
  let pairingNonce = "";
  try {
    try {
      await journey.initializeConsumerRoot();
      const start = await journey.startCandidate();
      pairingNonce = new URL(start.pairingUrl).hash.slice("#pair=".length);
      await journey.establishChangeOperation();
      const context = await browser.newContext();
      page = await context.newPage();
      recorder.note("browser", { engine: "Playwright Chromium", version: browser.version() });
    } catch (error) {
      recorder.checks.push({
        name: "setup.candidate-start-and-durable-fixture",
        status: "FAIL",
        classification: setupClassification(error),
        error: sanitizeText(error instanceof Error ? error.message : String(error)),
        details: error instanceof JourneySetupError ? error.details : undefined
      });
      expect.soft(false, `${setupClassification(error)} :: setup.candidate-start-and-durable-fixture :: ${sanitizeText(error instanceof Error ? error.message : String(error))}`).toBe(true);
      return;
    }
    const operation: DurableFixtureOperation = journey.operation!;
    const start = journey.start!;
    const origin = start.controlCenterOrigin;
    const establishment = journey.establishment;
    let pauseSnapshot: ReleaseRecord | undefined;
    recorder.note("authority", establishment);

    await recorder.check("authority.controller-produced-product-choice-request", "TEST_DEFECT", () => {
      expect(establishment?.provenance, `remaining harness gap: ${establishment?.remainingGap ?? "no establishment record"}`).toBe("controller-accepted");
    });

    await recorder.check("startup.uses-current-candidate-runtime", "PRODUCT_DEFECT", () => {
      expect(start.command).toBe(`npm run aeh -- start --no-open ${journey.consumerRoot}`);
      expect(start.exitCode).toBe(0);
      expect(start.controlCenterSession).toBe("started");
    });
    await recorder.check("startup.loopback-pairing-origin", "PRODUCT_DEFECT", () => {
      expect(origin).toMatch(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/);
      expect(start.pairingPath).toBe("/");
      expect(pairingNonce.length).toBeGreaterThanOrEqual(16);
    });
    recorder.note("startup", {
      command: start.command,
      exitCode: start.exitCode,
      controlCenterSession: start.controlCenterSession,
      controlCenterOrigin: origin,
      controlCenterPath: start.pairingPath,
      pairingUrlEmitted: true,
      packageVersion: journey.buildIdentity.packageVersion,
      releaseId: journey.buildIdentity.releaseId,
      buildDigest: journey.buildIdentity.buildDigest,
      gitSha: journey.buildIdentity.gitSha,
      dirty: journey.buildIdentity.dirty,
      provider: start.provider,
      model: start.model
    });

    await recorder.check("pairing.navigation-succeeds", "ENVIRONMENT_DEFECT", async () => {
      try {
        await page!.goto(start.pairingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (error) {
        throw new Error(`navigation to the emitted pairing origin failed: ${sanitizeText(error instanceof Error ? error.message : String(error))}`);
      }
    });
    await recorder.check("pairing.fragment-cleared", "PRODUCT_DEFECT", async () => {
      await expect.poll(() => page!.url().includes("pair="), { timeout: 30_000, message: "the UI must consume and clear the #pair fragment" }).toBe(false);
      const current = new URL(page!.url());
      expect(current.origin).toBe(origin);
      expect(current.pathname).toBe("/");
    });
    await recorder.check("pairing.session-cookie-hardened", "PRODUCT_DEFECT", async () => {
      const cookies = await page!.context().cookies();
      const session = cookies.find((cookie) => cookie.name === "aeh_control_session");
      expect(session, "the UI must establish the HttpOnly single-use session cookie").toBeDefined();
      expect(session!.httpOnly).toBe(true);
      expect(session!.sameSite).toBe("Strict");
    });
    await recorder.check("pairing.fragment-not-persisted", "PRODUCT_DEFECT", async () => {
      const persisted = await page!.evaluate((nonce) => {
        const values = [...Object.values(localStorage), ...Object.values(sessionStorage)].filter((value): value is string => typeof value === "string");
        return Boolean(nonce) && values.some((value) => value.includes(nonce));
      }, pairingNonce);
      expect(persisted, "the pairing nonce must not be persisted in browser storage").toBe(false);
    });
    await recorder.check("pairing.ui-authenticated", "PRODUCT_DEFECT", async () => {
      await expect(page!.getByText("Paired loopback session")).toBeVisible({ timeout: 30_000 });
      await expect(page!.locator('header [aria-label="Status: connected"]')).toBeVisible({ timeout: 30_000 });
      await expect(page!.getByRole("heading", { name: "Engineering signal, at a glance." })).toBeVisible({ timeout: 30_000 });
    });
    await recorder.check("pairing.nonce-one-use-replay-rejected", "PRODUCT_DEFECT", async () => {
      const response = await page!.context().request.post(`${origin}/api/v1/pair`, {
        headers: { "Content-Type": "application/json", Origin: origin },
        data: { nonce: pairingNonce }
      });
      expect(response.status()).toBe(403);
    });
    await recorder.check("pairing.sanitized-screenshot", "TEST_DEFECT", async () => {
      const screenshot = await journey.screenshot(page!, "paired-home");
      recorder.note("pairedScreenshot", { ...screenshot, capturedAfterPairingFragmentRemoval: true });
    });
    recorder.note("pairing", { fragmentCleared: true, storageNonceLeak: false, cookieHttpOnly: true, oneUseReplayRejected: true });
    recorder.note("pairing.pageDiagnostics", await pageDiagnostics(page!));

    const durable = await journey.readOperation();
    const overview = await readOverview(page!, origin);
    const projected = (overview.operations ?? []).find((item: Record<string, unknown>) => unwrapOperationId(item.operationId) === operation.operationId);
    await recorder.check("projection.api-operation-identity", "PRODUCT_DEFECT", () => {
      expect(projected, `the authenticated overview must project durable operation ${operation.operationId}`).toBeDefined();
      expect(projected.kind).toBe(durable.kind);
      expect(projected.status).toBe(durable.status);
      expect(projected.phase).toBe(durable.phase);
      expect(projected.revision).toBe(durable.revision);
      expect(projected.candidateDigest).toBe(operation.candidateDigest);
    });
    await recorder.check("projection.api-decision-request-scope", "PRODUCT_DEFECT", () => {
      const request = projected.decisionRequest;
      expect(request, "the pending scoped DecisionRequest must be projected").toBeDefined();
      expect(request.version).toBe(1);
      expect(unwrapOperationId(request.operationId)).toBe(operation.operationId);
      expect(request.requestId).toBe(operation.requestId);
      expect(request.candidate).toBe(operation.candidateDigest);
      expect(request.policyDigest).toBe(operation.policyDigest);
      expect(request.operationExecutionRevision).toBe(operation.operationExecutionRevision);
      expect(request.controllerEpoch).toBe(operation.controllerEpoch);
      expect(request.resumeTarget).toBe("SPEC_AUTHORING");
    });
    await recorder.check("projection.rendered-operation-card", "PRODUCT_DEFECT", async () => {
      const article = operationArticle(page!, operation.operationId);
      await expect(article).toBeVisible({ timeout: 30_000 });
      const text = (await article.innerText()).replace(/\s+/g, " ");
      expect(text).toContain(operation.operationId.slice(0, 12));
      expect(text).toContain(durable.phase);
      await expect(article.locator('[aria-label="Status: running"]')).toBeVisible();
    });
    await recorder.check("projection.rendered-decision-scope", "PRODUCT_DEFECT", async () => {
      const scope = page!.getByRole("region", { name: "Current decision scope" });
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
    await recorder.check("projection.rendered-choice-and-issue", "PRODUCT_DEFECT", async () => {
      const card = decisionCard(page!);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const request = durable.decisionRequest;
      expect(await card.innerText()).toContain(request.issue);
      await expect(card.getByText(operation.choiceLabel, { exact: false }).first()).toBeVisible();
      await expect(card.locator(`input[type="radio"][value="${operation.choiceId}"]`)).toHaveCount(1);
    });
    await recorder.check("projection.build-identity-matches-candidate", "PRODUCT_DEFECT", async () => {
      const footer = page!.locator("footer");
      await expect(footer).toContainText(journey.buildIdentity.packageVersion);
      await expect(footer).toContainText(journey.buildIdentity.releaseId);
    });
    recorder.note("projection", {
      operationId: operation.operationId,
      durableRevision: durable.revision,
      durablePhase: durable.phase,
      durableStatus: durable.status,
      candidateDigest: operation.candidateDigest,
      policyDigest: operation.policyDigest,
      operationExecutionRevision: operation.operationExecutionRevision,
      controllerEpoch: operation.controllerEpoch,
      requestId: operation.requestId
    });

    const ledger = await journey.ledger();
    const ledgerBeforeDecision = await ledger.list();
    await recorder.check("decision.ui-submits-one-choice", "PRODUCT_DEFECT", async () => {
      const card = decisionCard(page!);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.locator(`input[type="radio"][value="${operation.choiceId}"]`).check();
      await card.locator("textarea").fill("Selected through the rendered Control Center during the S9 browser journey.");
      await card.getByRole("button", { name: "Submit choice" }).click();
      await expect(card.getByText("Choice recorded.")).toBeVisible({ timeout: 30_000 });
    });
    await recorder.check("decision.durable-human-decision-persisted", "PRODUCT_DEFECT", async () => {
      const after = await ledger.list();
      expect(after.length).toBe(ledgerBeforeDecision.length + 1);
      const decision = after.find((item) => item.purpose?.kind === "PRODUCT_CHOICE" && item.purpose.requestId === operation.requestId);
      expect(decision, "the frontend -> paired server -> controller path must persist a scoped HumanDecision").toBeDefined();
      expect(decision!.kind).toBe("CHOOSE");
      expect(decision!.purpose.choiceId).toBe(operation.choiceId);
      expect(decision!.operationId).toBe(operation.operationId);
      expect(decision!.operationExecutionRevision).toBe(operation.operationExecutionRevision);
      expect(decision!.policyDigest).toBe(operation.policyDigest);
      expect(decision!.controllerEpoch).toBe(operation.controllerEpoch);
      expect(decision!.actorId).toMatch(/^human:control-center:[a-f0-9]{32}$/);
      recorder.note("decision", { decisionId: decision!.decisionId, actorClass: "human:control-center", exactlyOnce: true });
    });
    await recorder.check("decision.operation-waits-for-controller-consumption", "PRODUCT_DEFECT", async () => {
      const durableAfter = await journey.readOperation();
      expect(durableAfter.status).toBe("RUNNING");
      if (durableAfter.phase === "HUMAN_REQUIRED") expect(durableAfter.decisionRequest?.requestId).toBe(operation.requestId);
    });

    const csrf = await readCsrf(page!, origin);
    const durableBeforeRejection = await journey.readOperation();
    await recorder.check("rejection.replay-is-rejected", "PRODUCT_DEFECT", async () => {
      const response = await postDecision(page!, origin, csrf, { operationId: operation.operationId, requestId: operation.requestId, choiceId: operation.choiceId, reason: "replay attempt" });
      expect(response.status).toBe(409);
    });
    await recorder.check("rejection.unknown-request-is-rejected", "PRODUCT_DEFECT", async () => {
      const response = await postDecision(page!, origin, csrf, { operationId: operation.operationId, requestId: `request:${"0".repeat(36)}`, choiceId: operation.choiceId });
      expect(response.status).toBe(409);
    });
    await recorder.check("rejection.out-of-scope-choice-is-rejected", "PRODUCT_DEFECT", async () => {
      const response = await postDecision(page!, origin, csrf, { operationId: operation.operationId, requestId: operation.requestId, choiceId: "not-a-bounded-choice" });
      expect(response.status).toBe(409);
    });
    await recorder.check("rejection.foreign-operation-is-rejected", "PRODUCT_DEFECT", async () => {
      const response = await postDecision(page!, origin, csrf, { operationId: "CHANGE-NOT-THE-FIXTURE", requestId: operation.requestId, choiceId: operation.choiceId });
      expect([400, 409]).toContain(response.status);
    });
    await recorder.check("rejection.missing-csrf-is-rejected", "PRODUCT_DEFECT", async () => {
      const response = await postDecision(page!, origin, undefined, { operationId: operation.operationId, requestId: operation.requestId, choiceId: operation.choiceId });
      expect(response.status).toBe(403);
    });
    await recorder.check("rejection.durable-state-unchanged", "PRODUCT_DEFECT", async () => {
      const durableAfter = await journey.readOperation();
      expect(durableAfter.revision).toBe(durableBeforeRejection.revision);
      expect(durableAfter.phase).toBe("HUMAN_REQUIRED");
      expect((await ledger.list()).length).toBe(ledgerBeforeDecision.length + 1);
    });

    await recorder.check("authority.controller-owned-continuation", "TEST_DEFECT", () => {
      expect(establishment?.controllerOwnedConsumption, `remaining harness gap: ${establishment?.remainingGap ?? "no establishment record"}`).toBe(true);
    });
    let secondRequestId = "";
    await recorder.check("continuation.controller-consumes-and-resumes", "PRODUCT_DEFECT", async () => {
      const second = await journey.waitForSecondProductChoice(operation.requestId);
      secondRequestId = String(second.decisionRequest?.requestId ?? "");
      expect(secondRequestId).not.toBe(operation.requestId);
      expect(second.phase).toBe("HUMAN_REQUIRED");
      expect(second.status).toBe("RUNNING");
      expect(second.candidateRevision?.identityDigest).toBe(operation.candidateDigest);
      expect(second.resolvedOperationPolicy?.digest).toBeTruthy();
      recorder.note("continuation", {
        secondRequestId,
        durableRevision: second.revision,
        durablePhase: second.phase,
        policyDigest: second.resolvedOperationPolicy?.digest
      });
    });
    await recorder.check("continuation.checkpoint-revalidated", "PRODUCT_DEFECT", async () => {
      const checkpoint = await journey.loadContinuationCheckpoint();
      expect(checkpoint).toBeDefined();
      const current = await journey.readOperation();
      expect(current.continuation?.operationExecutionRevision).toBe(current.operationExecutionRevision);
      expect(current.continuation?.policyDigest).toBe(current.resolvedOperationPolicy?.digest);
      expect(current.continuation?.candidate.identityDigest).toBe(current.candidateRevision.identityDigest);
    });
    await recorder.check("continuation.exact-once-consumption-receipt", "PRODUCT_DEFECT", async () => {
      const decisions = await ledger.list();
      const consumed = decisions.find((item) => item.purpose?.kind === "PRODUCT_CHOICE" && item.purpose.requestId === operation.requestId);
      expect(consumed, "the first UI decision must remain durably recorded").toBeDefined();
      const binding = {
        operationId: consumed!.operationId,
        candidate: consumed!.candidate,
        operationExecutionRevision: consumed!.operationExecutionRevision,
        policyDigest: consumed!.policyDigest,
        controllerEpoch: consumed!.controllerEpoch
      };
      const receipt = await ledger.consumedExact(binding, consumed!.purpose, consumed!.decisionId, consumed!.actorId);
      expect(receipt?.decisionId).toBe(consumed!.decisionId);
      await expect(ledger.consumeExact(binding, consumed!.purpose, consumed!.decisionId, consumed!.actorId)).rejects.toThrow(/already been consumed or replayed/);
    });
    await recorder.check("continuation.reissue-after-resume-is-stale", "PRODUCT_DEFECT", async () => {
      const api = await journey.api();
      let rejected = false;
      try {
        await api.state.reissueOperationProductChoice(journey.consumerRoot, operation.operationId, undefined);
      } catch {
        rejected = true;
      }
      expect(rejected, "reissuing a consumed product choice must fail closed").toBe(true);
    });
    await recorder.check("continuation.refreshed-ui-projection", "PRODUCT_DEFECT", async () => {
      await page!.reload({ waitUntil: "domcontentloaded" });
      await expect(page!.locator('header [aria-label="Status: connected"]')).toBeVisible({ timeout: 30_000 });
      const card = decisionCard(page!);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const refreshed = await readOverview(page!, origin);
      const refreshedProjection = (refreshed.operations ?? []).find((item: Record<string, unknown>) => unwrapOperationId(item.operationId) === operation.operationId);
      expect(refreshedProjection?.decisionRequest?.requestId).toBe(secondRequestId);
      expect(refreshedProjection?.phase).toBe("HUMAN_REQUIRED");
    });

    const article = operationArticle(page!, operation.operationId);
    const pauseCount = await article.getByRole("button", { name: /pause/i }).count();
    await recorder.check("pause.control-rendered", "PRODUCT_DEFECT", async () => {
      const labels = await article.getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean));
      expect(pauseCount, `no rendered pause control was found; the operation card renders buttons: ${JSON.stringify(labels)}`).toBeGreaterThan(0);
    });
    if (pauseCount > 0) {
      pauseSnapshot = await journey.readOperation();
      const beforePause = pauseSnapshot;
      await recorder.check("pause.reaches-durable-paused", "PRODUCT_DEFECT", async () => {
        await article.getByRole("button", { name: /pause/i }).first().click();
        const paused = await waitForDurable(async () => {
          const record = await journey.readOperation();
          return record.phase === "PAUSED" || record.status === "PAUSED" ? record : undefined;
        }, 60_000, "phase/status PAUSED");
        expect(paused.phase === "PAUSED" || paused.status === "PAUSED").toBe(true);
        expect(paused.progress?.running ?? 0).toBe(0);
        const running = Object.values(paused.participants ?? {}).filter((participant: any) => participant.status === "RUNNING");
        expect(running, "pause must drain active writers before it becomes observable").toHaveLength(0);
        recorder.note("pause", { durableRevision: paused.revision, durablePhase: paused.phase, durableStatus: paused.status, operationExecutionRevision: paused.operationExecutionRevision, controllerEpoch: paused.controller?.epoch });
      });
      await recorder.check("pause.writers-are-fenced", "PRODUCT_DEFECT", async () => {
        const api = await journey.api();
        const atPause = await journey.readOperation();
        const stalePolicy = await journey.compileResolvedPolicy(atPause);
        let rejected = false;
        let rejectionMessage = "";
        try {
          await api.state.bindResolvedOperationPolicy(journey.consumerRoot, operation.operationId, stalePolicy);
        } catch (error) {
          rejected = true;
          rejectionMessage = sanitizeText(error instanceof Error ? error.message : String(error));
        }
        expect(rejected, "a pre-pause writer policy must not land while the operation is PAUSED (no write landed after the fence)").toBe(true);
        const after = await journey.readOperation();
        expect(after.revision, "a fenced writer must leave the durable revision unchanged").toBe(atPause.revision);
        expect(api.state.currentControllerEpoch(after)).toBe(api.state.currentControllerEpoch(atPause));
        recorder.note("pause.fenceRejection", rejectionMessage);
      });
      await recorder.check("pause.ui-projection-is-paused", "PRODUCT_DEFECT", async () => {
        await expect(article.locator('[aria-label="Status: paused"]')).toBeVisible({ timeout: 30_000 });
        await expect(article).toContainText("paused");
      });
    } else {
      recorder.note("pause.dependentChecks", "not evaluated: the candidate UI does not render a pause control, classified PRODUCT_DEFECT");
    }

    const resumeCount = await article.getByRole("button", { name: /resume/i }).count();
    await recorder.check("resume.control-rendered", "PRODUCT_DEFECT", async () => {
      const labels = await article.getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean));
      expect(resumeCount, `no rendered resume control was found; the operation card renders buttons: ${JSON.stringify(labels)}`).toBeGreaterThan(0);
    });
    if (resumeCount > 0) {
      await recorder.check("resume.revalidates-and-continues", "PRODUCT_DEFECT", async () => {
        const before = pauseSnapshot ?? await journey.readOperation();
        await article.getByRole("button", { name: /resume/i }).first().click();
        const resumed = await waitForDurable(async () => {
          const record = await journey.readOperation();
          return record.phase !== "PAUSED" && record.status === "RUNNING" ? record : undefined;
        }, 60_000, "running operation after resume");
        expect(resumed.candidateRevision?.identityDigest).toBe(before.candidateRevision?.identityDigest);
        expect(resumed.resolvedOperationPolicy?.digest).toBeTruthy();
        expect(resumed.resolvedOperationPolicy?.controllerEpoch).toBe(resumed.controller?.epoch);
        if (resumed.continuation) {
          expect(resumed.continuation.operationId).toBe(operation.operationId);
          expect(resumed.continuation.candidate?.identityDigest).toBe(resumed.candidateRevision?.identityDigest);
          expect(resumed.continuation.operationExecutionRevision).toBe(resumed.operationExecutionRevision);
        }
        recorder.note("resume", { durableRevision: resumed.revision, durablePhase: resumed.phase, continuationState: resumed.continuation?.state });
      });
      await recorder.check("resume.continuation-checkpoint-current", "PRODUCT_DEFECT", async () => {
        const current = await journey.readOperation();
        if (!current.continuation) {
          recorder.note("resume.continuation", "operation has no continuation after resume; checkpoint revalidation is not applicable");
          return;
        }
        const checkpoint = await journey.loadContinuationCheckpoint();
        expect(checkpoint).toBeDefined();
      });
    } else {
      recorder.note("resume.dependentChecks", "not evaluated: the candidate UI does not render a resume control, classified PRODUCT_DEFECT");
    }

    const cancelControl = article.getByRole("button", { name: /cancel operation/i });
    const cancelCount = await cancelControl.count();
    const durableBeforeCancel = await journey.readOperation();
    const ledgerBeforeCancel = (await ledger.list()).length;
    await recorder.check("cancellation.control-rendered", "PRODUCT_DEFECT", async () => {
      const labels = await article.getByRole("button").evaluateAll((nodes) => nodes.map((node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "").filter(Boolean));
      expect(cancelCount, `no rendered cancellation control was found; the operation card renders buttons: ${JSON.stringify(labels)}`).toBeGreaterThan(0);
    });
    if (cancelCount > 0) {
      let cancelled: ReleaseRecord | undefined;
      await recorder.check("cancellation.reaches-durable-cancelled", "PRODUCT_DEFECT", async () => {
        await cancelControl.first().click();
        cancelled = await waitForDurable(async () => {
          const record = await journey.readOperation();
          return record.status === "CANCELLED" ? record : undefined;
        }, 90_000, "durable CANCELLED status");
        expect(cancelled.status).toBe("CANCELLED");
        expect(cancelled.decisionRequest).toBeUndefined();
        expect(cancelled.continuation).toBeUndefined();
        recorder.note("cancellation", { durableRevision: cancelled.revision, durableStatus: cancelled.status, durablePhase: cancelled.phase, controllerEpoch: cancelled.controller?.epoch });
      });
      await recorder.check("cancellation.stale-writers-fenced", "PRODUCT_DEFECT", async () => {
        const api = await journey.api();
        const stalePolicy = await journey.compileResolvedPolicy(durableBeforeCancel);
        const attempts: Record<string, string> = {};
        const probes: Array<{ name: string; run: () => Promise<unknown> }> = [
          { name: "bindResolvedOperationPolicy", run: () => api.state.bindResolvedOperationPolicy(journey.consumerRoot, operation.operationId, stalePolicy) },
          { name: "claimControllerEpoch", run: () => api.state.claimControllerEpoch(journey.consumerRoot, operation.operationId, "controller:stale-writer-probe", { pid: process.pid }) },
          { name: "transitionOperationToTerminal", run: async () => (await api.state.transitionOperationToTerminal(journey.consumerRoot, operation.operationId, { status: "SUCCEEDED", finishedAt: new Date().toISOString() })).transitioned }
        ];
        for (const probe of probes) {
          try {
            const result = await probe.run();
            attempts[probe.name] = `resolved without mutation (${JSON.stringify(result ?? null).slice(0, 60)})`;
          } catch (error) {
            attempts[probe.name] = `rejected: ${sanitizeText(error instanceof Error ? error.message : String(error))}`;
          }
        }
        const after = await journey.readOperation();
        expect(after.revision, "no writer may land after the cancellation fence").toBe(cancelled?.revision);
        expect(after.status).toBe("CANCELLED");
        expect(after.phase).toBe(cancelled?.phase);
        expect(api.state.currentControllerEpoch(after), "a stale writer must not take over the controller epoch").toBe(api.state.currentControllerEpoch(cancelled!));
        expect(after.candidateRevision?.identityDigest).toBe(cancelled?.candidateRevision?.identityDigest);
        recorder.note("cancellation.staleWriterAttempts", attempts);
      });
      await recorder.check("cancellation.stale-decision-rejected", "PRODUCT_DEFECT", async () => {
        const ledgerBeforeStalePost = (await ledger.list()).length;
        const response = await postDecision(page!, origin, csrf, { operationId: operation.operationId, requestId: operation.requestId, choiceId: operation.choiceId });
        expect([400, 409]).toContain(response.status);
        expect((await ledger.list()).length, "a stale decision POST must not add a ledger entry").toBe(ledgerBeforeStalePost);
        expect(ledgerBeforeCancel).toBeGreaterThan(0);
      });
      await recorder.check("cancellation.refreshed-ui-projection", "PRODUCT_DEFECT", async () => {
        await page!.reload({ waitUntil: "domcontentloaded" });
        await expect(page!.locator('header [aria-label="Status: connected"]')).toBeVisible({ timeout: 30_000 });
        const refreshed = operationArticle(page!, operation.operationId);
        await expect(refreshed).toBeVisible({ timeout: 30_000 });
        await expect(refreshed.locator('[aria-label="Status: cancelled"]')).toBeVisible({ timeout: 30_000 });
        await expect(decisionCard(page!)).toHaveCount(0);
      });
    } else {
      recorder.note("cancellation.dependentChecks", "not evaluated: the candidate UI does not render a cancellation control, classified PRODUCT_DEFECT");
    }

    const finalDurable = await journey.readOperation();
    const finalOverview = await readOverview(page!, origin);
    const finalProjected = (finalOverview.operations ?? []).find((item: Record<string, unknown>) => unwrapOperationId(item.operationId) === operation.operationId);
    await recorder.check("final.api-projection-equals-durable", "PRODUCT_DEFECT", () => {
      expect(finalProjected, "the final authenticated projection must include the fixture operation").toBeDefined();
      expect(unwrapOperationId(finalProjected.operationId)).toBe(finalDurable.id);
      expect(finalProjected.kind).toBe(finalDurable.kind);
      expect(finalProjected.status).toBe(finalDurable.status);
      expect(finalProjected.phase).toBe(finalDurable.phase);
      expect(finalProjected.revision).toBe(finalDurable.revision);
      expect(finalProjected.candidateDigest).toBe(finalDurable.candidateRevision.identityDigest);
      expect(finalProjected.decisionRequest).toBeUndefined();
      expect(finalProjected.participantCount).toBe(Object.keys(finalDurable.participants ?? {}).length);
    });
    await recorder.check("final.rendered-projection-equals-durable", "PRODUCT_DEFECT", async () => {
      const finalArticle = operationArticle(page!, operation.operationId);
      if (cancelCount === 0) throw new Error("the final rendered projection could not be compared because no cancellation transition was executed");
      await expect(finalArticle).toBeVisible({ timeout: 30_000 });
      await expect(finalArticle).toContainText(finalDurable.phase);
      await expect(finalArticle.locator(`[aria-label="Status: ${String(finalDurable.status).toLowerCase()}"]`)).toBeVisible();
      await expect(decisionCard(page!)).toHaveCount(0);
    });
    await recorder.check("final.sanitized-screenshot", "TEST_DEFECT", async () => {
      const screenshot = await journey.screenshot(page!, "final-projection");
      recorder.note("finalScreenshot", { ...screenshot, capturedAfterPairingFragmentRemoval: true });
    });
    recorder.note("final", {
      operationId: finalDurable.id,
      durableRevision: finalDurable.revision,
      durableStatus: finalDurable.status,
      durablePhase: finalDurable.phase,
      candidateDigest: operation.candidateDigest,
      operationExecutionRevision: finalDurable.operationExecutionRevision,
      controllerEpoch: finalDurable.controller?.epoch
    });

    const failures = recorder.failures();
    expect(failures.map((failure) => `${failure.classification ?? "UNCLASSIFIED"}: ${failure.name} :: ${failure.error ?? ""}`.slice(0, 400)), "the S9 browser journey must satisfy every frozen contract assertion").toEqual([]);
  } finally {
    try {
      await page?.context().close();
    } catch { /* context already closed */ }
    try {
      await journey.cleanup();
      await journey.removeConsumerRoot();
      recorder.note("evidenceDirectory", journey.evidenceDirectory());
      await journey.writeEvidence();
    } catch (error) {
      recorder.note("evidenceWriteFailure", sanitizeText(error instanceof Error ? error.message : String(error)));
    }
  }
});
