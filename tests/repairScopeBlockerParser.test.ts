import { describe, expect, it } from "vitest";
import { extractMarkedJson } from "../src/agents/structuredOutput.js";
import { parseRepairScopeBlockerFromSession } from "../src/candidates/repairScope.js";

const BLOCKER_PAYLOAD = JSON.stringify({
  filesChanged: [],
  filesNeededOutsideScope: [{ path: "package-lock.json", reason: "needs bump" }],
});

function expectedBlocker() {
  return [{ path: "package-lock.json", reason: "needs bump" }];
}

describe("repair blocker parser unification (H-NEW-1)", () => {
  it("(a) trailing-log marker parses via the canonical extractor", () => {
    const stdout = `log line\nAEH_RESULT_JSON=${BLOCKER_PAYLOAD} trailing log after json`;
    // Canonical accepts trailing logs via prefix-shrink.
    expect(extractMarkedJson(stdout, "")).toMatchObject({ filesChanged: [] });
    // Blocker parser must also surface the declaration.
    expect(parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toEqual(expectedBlocker());
  });

  it("(a) smart-quote marker parses via the canonical extractor", () => {
    const smart = `AEH_RESULT_JSON=${BLOCKER_PAYLOAD.replaceAll('"', "“")}`;
    expect(extractMarkedJson(smart, "")).toMatchObject({ filesChanged: [] });
    expect(parseRepairScopeBlockerFromSession({ stdout: smart, stderr: "" })).toEqual(expectedBlocker());
  });

  it("(a) fenced marker parses via the canonical extractor", () => {
    const stdout = `AEH_RESULT_JSON=\`\`\`json\n${BLOCKER_PAYLOAD}\n\`\`\``;
    expect(extractMarkedJson(stdout, "")).toMatchObject({ filesChanged: [] });
    expect(parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toEqual(expectedBlocker());
  });

  it("(b) tail-truncated marker surfaces a distinct contract error (never silent no-blocker)", () => {
    const stdout = `AEH_RESULT_JSON={"filesChanged":[], "filesNeededOutsideScope":[{"path":"package-lock.json"`;
    // Canonical surfaces a distinct invalid-marker error, never silent success.
    expect(() => extractMarkedJson(stdout, "")).toThrowError(/not valid JSON/);
    // Blocker parser must surface a distinct contract error, never undefined.
    expect(() => parseRepairScopeBlockerFromSession({ stdout, stderr: "" })).toThrowError(
      /MARKER_INVALID_JSON|REPAIR_SCOPE_BLOCKER_INVALID|BLOCKER_INVALID/i,
    );
  });
});
