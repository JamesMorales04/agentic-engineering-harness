import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

// RED V2 (round-3): no fallible window before protection.
// (a) abort handlers must be installed FIRST thing in isolation setup (before
//     any fallible step: port discovery, daemon config/start, health wait).
// (b) each campaign must enter try/finally immediately when isolation setup
//     returns — all subsequent fallible setup (staging mkdtemp, dist reads,
//     candidate packing, fixture prep) inside the protected region.

function indexOfFirst(src, patterns) {
  let best = { idx: -1, pat: null };
  for (const pat of patterns) {
    const idx = src.indexOf(pat);
    if (idx !== -1 && (best.idx === -1 || idx < best.idx)) best = { idx, pat };
  }
  return best;
}

test("RED V2a: abort handlers installed before any fallible isolation step", async () => {
  const src = await fs.readFile(new URL("./paseoIsolatedHome.mjs", import.meta.url), "utf8");
  const installIdx = src.indexOf("installAbortHandlers(handle)");
  assert.ok(installIdx !== -1, "setup must call installAbortHandlers(handle)");
  // installAbortHandlers is also defined once; the SETUP call site must be the
  // first one. Find the setup function body and require ordering there.
  const setupIdx = src.indexOf("export async function setupIsolatedPaseoHome");
  assert.ok(setupIdx !== -1, "setupIsolatedPaseoHome must exist");
  const setupBody = src.slice(setupIdx);
  const setupInstall = setupBody.indexOf("installAbortHandlers(handle)");
  assert.ok(setupInstall !== -1, "setup body must install abort handlers");
  const firstFallible = indexOfFirst(setupBody, [
    "findFreePort(",
    'runPaseo(["daemon", "config"',
    'runPaseo(["daemon", "start"',
    "waitForIsolatedDaemon(",
  ]);
  assert.ok(firstFallible.idx !== -1, "setup must contain a fallible isolation step to order against");
  assert.ok(
    setupInstall < firstFallible.idx,
    `abort handlers must be installed BEFORE any fallible step (install@${setupInstall} vs first fallible ${firstFallible.pat}@${firstFallible.idx})`
  );
});

test("RED V2b: campaigns enter try/finally immediately after isolation setup", async () => {
  const campaigns = [
    "s13GovernedOperationCampaign.mjs",
    "s13ContextPermissionCampaign.mjs",
    "s13RealPaseoLifecycleCampaign.mjs",
  ];
  for (const file of campaigns) {
    const src = await fs.readFile(new URL(`./${file}`, import.meta.url), "utf8");
    const setupMarker = "await setupIsolatedPaseoHome(";
    const setupIdx = src.indexOf(setupMarker);
    assert.ok(setupIdx !== -1, `${file} must call setupIsolatedPaseoHome`);
    const afterSetup = src.slice(setupIdx + setupMarker.length);
    // The protected region must begin immediately: the next substantive
    // statement after the setup line must open the try block. Allow only the
    // setup statement tail, whitespace, comments, and the assert guard INSIDE
    // try — no awaited fallible setup (mkdtemp, readFile, pack, digest).
    const setupLineEnd = afterSetup.indexOf("\n");
    const rest = afterSetup.slice(setupLineEnd + 1);
    // Find the first `try {` after setup.
    const tryIdx = rest.search(/\btry\s*\{/);
    assert.ok(tryIdx !== -1, `${file} must open try/finally after isolation setup`);
    const between = rest.slice(0, tryIdx);
    // Strip comments and blank lines for the gap analysis.
    const gapLines = between
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
    // Pure `let x;` declarations (no initializer, no await) are not fallible
    // setup and are allowed in the gap so the protected region can declare its
    // outer bindings before opening try. Anything else must be trivial.
    const substantiveGap = gapLines.filter((l) => !/^let\s+[A-Za-z0-9_,\s]+\s*;\s*$/.test(l));
    // The gap must contain NO fallible work: no await, no mkdtemp, no readFile,
    // no packCandidate/trackedDigest/prepareFixture.
    const forbidden = [/\bawait\b/, /\bmkdtemp\b/, /\breadFile\b/, /\bpackCandidate\b/, /\btrackedDigest\b/, /\bprepareFixture\b/];
    for (const line of gapLines) {
      for (const re of forbidden) {
        assert.ok(
          !re.test(line),
          `${file}: fallible setup outside protection between isolation-return and try-entry: "${line}"`
        );
      }
    }
    // Gap must be trivially small (only let-declarations before try).
    assert.ok(
      substantiveGap.length === 0,
      `${file}: try must begin immediately after isolation setup (found substantive line(s) before try: ${JSON.stringify(substantiveGap).slice(0, 500)})`
    );
    // And assertIsolatedPaseoEnv must be INSIDE the protected region.
    const assertIdx = src.indexOf("assertIsolatedPaseoEnv(paseoIsolation)");
    assert.ok(assertIdx !== -1, `${file} must call assertIsolatedPaseoEnv`);
    const tryAbsIdx = setupIdx + setupMarker.length + setupLineEnd + 1 + tryIdx;
    assert.ok(
      assertIdx > tryAbsIdx,
      `${file}: assertIsolatedPaseoEnv must be inside try (after try-entry), so a guard failure still tears down`
    );
  }
});
