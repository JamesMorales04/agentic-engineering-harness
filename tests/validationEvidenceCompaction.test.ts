import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runValidationCommand } from "../src/validators/commands.js";

describe("validation evidence compaction", () => {
  it("summarizes successful validation output instead of retaining the full stdout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-validation-evidence-"));
    const check = await runValidationCommand(root, {
      id: "compact-pass",
      command: "printf 'typecheck tsc -p\\nTest Files  83 passed\\nTests  260 passed\\nbuild tsc -p\\n'"
    });
    expect(check.status).toBe("PASS");
    expect(check.details).not.toHaveProperty("stdout");
    expect(check.details).toEqual(expect.objectContaining({
      exitCode: 0,
      summary: expect.objectContaining({ testFilesPassed: 83, testsPassed: 260, typecheck: "PASS", build: "PASS" })
    }));
    expect(Number(check.details?.stdoutBytes)).toBeGreaterThan(0);
  });

  it("preserves bounded failure diagnostics because they are semantic evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-validation-evidence-"));
    const check = await runValidationCommand(root, {
      id: "diagnostic-fail",
      command: "printf 'expected one received two\\n' >&2; exit 1"
    });
    expect(check.status).toBe("FAIL");
    expect(check.details).toEqual(expect.objectContaining({ exitCode: 1 }));
    expect(String(check.details?.stderr)).toContain("expected one received two");
  });
});
