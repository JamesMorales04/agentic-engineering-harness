import { describe, expect, it } from "vitest";
import { chooseBumpFromMessages, incrementVersion, resolveTargetVersion } from "../scripts/release-version.mjs";

describe("release version resolver", () => {
  it("maps conventional commits to semantic bumps", () => {
    expect(chooseBumpFromMessages(["fix: repair start"])).toBe("patch");
    expect(chooseBumpFromMessages(["feat: add worker status"])).toBe("minor");
    expect(chooseBumpFromMessages(["feat!: replace public contract"])).toBe("major");
    expect(chooseBumpFromMessages(["feat: change\n\nBREAKING CHANGE: old API removed"])).toBe("major");
  });

  it("publishes an explicitly unshipped repository version before incrementing again", () => {
    expect(resolveTargetVersion({ currentVersion: "0.6.1", currentPublished: false, requestedBump: "auto", messages: ["feat: ignored until current ships"] })).toEqual(expect.objectContaining({ version: "0.6.1", bump: "current", shouldPublish: true }));
    expect(resolveTargetVersion({ currentVersion: "0.6.1", currentPublished: true, requestedBump: "auto", messages: ["fix: next change"] })).toEqual(expect.objectContaining({ version: "0.6.2", bump: "patch", shouldPublish: true }));
  });

  it("increments major, minor and patch versions deterministically", () => {
    expect(incrementVersion("0.6.1", "patch")).toBe("0.6.2");
    expect(incrementVersion("0.6.1", "minor")).toBe("0.7.0");
    expect(incrementVersion("0.6.1", "major")).toBe("1.0.0");
  });
});
