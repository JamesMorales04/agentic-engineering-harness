import { describe, expect, it } from "vitest";
import {
  extractMarkedJson,
  StructuredOutputError
} from "../src/agents/structuredOutput.js";

describe("extractMarkedJson", () => {
  it("extracts a direct marker", () =>
    expect(extractMarkedJson('log\nAEH_RESULT_JSON={"ok":true}')).toEqual({ ok: true }));

  it("extracts a marker nested in JSON event output", () => {
    const line = JSON.stringify({
      type: "message",
      data: { text: 'AEH_RESULT_JSON={"verdict":"PASS"}' }
    });
    expect(extractMarkedJson(line)).toEqual({ verdict: "PASS" });
  });

  it("classifies an empty captured turn separately", () => {
    try {
      extractMarkedJson("", "");
      throw new Error("expected extractMarkedJson to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).reason).toBe("EMPTY_OUTPUT");
    }
  });

  it("classifies a marker with smart quotes as invalid JSON without repairing it", () => {
    try {
      extractMarkedJson('AEH_RESULT_JSON={“verdict”:“PASS”}');
      throw new Error("expected extractMarkedJson to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).reason).toBe("MARKER_INVALID_JSON");
    }
  });

  it("classifies malformed native JSON separately from missing markers", () => {
    try {
      extractMarkedJson('{"verdict":');
      throw new Error("expected extractMarkedJson to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredOutputError);
      expect((error as StructuredOutputError).reason).toBe("NATIVE_JSON_INVALID");
    }
  });
});
