import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSerialize, sha256Canonical } from "../src/core/digest.js";
import { AehError } from "../src/core/errors.js";
import { compileSkillSet } from "../src/participants/index.js";

describe("canonical provenance digest", () => {
  it("orders object keys recursively and uses a real lowercase SHA-256 digest", () => {
    const first = { b: { z: 2, a: 1 }, a: ["x", true] };
    const second = { a: ["x", true], b: { a: 1, z: 2 } };
    const canonical = '{"a":["x",true],"b":{"a":1,"z":2}}';
    expect(canonicalSerialize(first)).toBe(canonical);
    expect(canonicalSerialize(second)).toBe(canonical);
    expect(sha256Canonical(first)).toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(sha256Canonical(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("has explicit fail-closed behavior for unsupported values", () => {
    expect(canonicalSerialize({ optional: undefined, value: 1 })).toBe('{"value":1}');
    expect(() => canonicalSerialize([undefined])).toThrow(/undefined array value/);
    expect(() => canonicalSerialize({ value: Number.NaN })).toThrow(/non-finite number/);
    expect(() => canonicalSerialize({ value: 1n })).toThrow(/bigint/);
  });

  it("is the digest authority used by compiled participant skills", () => {
    const compiled = compileSkillSet({ role: "Reviewer", competencies: ["security.authorization"] });
    const { digest, ...unsigned } = compiled;
    expect(digest).toBe(sha256Canonical(unsigned));
  });

  it("exposes machine-readable typed error codes", () => {
    const error = new AehError("CANDIDATE_STALE", "candidate revision is stale");
    expect(error.code).toBe("CANDIDATE_STALE");
    expect(error.message).toContain("CANDIDATE_STALE");
  });
});
