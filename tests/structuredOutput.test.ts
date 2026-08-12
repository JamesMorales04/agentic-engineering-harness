import { describe, expect, it } from "vitest";
import { extractMarkedJson } from "../src/agents/structuredOutput.js";
describe("extractMarkedJson", () => {
  it("extracts a direct marker", () => expect(extractMarkedJson('log\nAEH_RESULT_JSON={"ok":true}')).toEqual({ ok: true }));
  it("extracts a marker nested in JSON event output", () => { const line = JSON.stringify({ type: "message", data: { text: 'AEH_RESULT_JSON={"verdict":"PASS"}' } }); expect(extractMarkedJson(line)).toEqual({ verdict: "PASS" }); });
});
