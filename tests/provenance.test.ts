import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSlsaPredicate, sha256File } from "../src/provenance/generate.js";

describe("provenance", () => {
  it("hashes artifacts deterministically", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-prov-"));
    const file = path.join(dir, "artifact.txt");
    await fs.writeFile(file, "hello");
    expect(await sha256File(file)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("creates SLSA v1 build/run details", () => {
    const predicate = buildSlsaPredicate({ project: "x", artifact: "a.tgz", taskId: "T-1", commit: "abc", remote: "https://example/repo.git", buildType: "https://example/build", invocationId: "i", startedOn: "s", finishedOn: "f" }) as any;
    expect(predicate.buildDefinition.buildType).toBe("https://example/build");
    expect(predicate.runDetails.metadata.invocationId).toBe("i");
  });
});
