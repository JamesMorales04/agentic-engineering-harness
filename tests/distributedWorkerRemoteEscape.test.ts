import { describe, expect, it } from "vitest";
import {
  findDistributedRemoteEscapeV1,
  isDistributedRemoteEscapeExcludedV1,
} from "../src/distributed/worker.js";
import { isWaveWorktreeExcludedV1 } from "../src/agents/waveExecutor.js";

/**
 * D23c regression (DETERMINISTIC, no providers): the remote escape check in
 * `src/distributed/worker.ts` (~line 325) must skip managed-provisioned
 * toolchain droppings exactly like the canonical live-gate predicate, while
 * real off-scope files still fail. Tests the smallest deterministic seam —
 * the extracted pure filter predicate over fixture file lists — because the
 * enclosing `executeClaimedJob` path requires git clones, queue leases, and
 * provider sessions.
 */
const SCOPE = ["src/b.ts"];

const DROPPINGS = [
  ".config/mise/conf.d/aeh.toml",
  ".config/mise/locks/node-22.23.2",
  ".config/mise/mise.lock",
  ".serena/scratch.json",
  "graphify-out/x.json",
  ".aeh-direct-heartbeat.json",
];

describe("distributed remote escape exclusion (D23c)", () => {
  it("exclusion matches the canonical live-gate predicate over the full fixture set", () => {
    const fixtures = [
      ...DROPPINGS,
      ".config/mise/config.toml",
      ".config/mise/settings.toml",
      ".config/mise",
      ".config/other",
      ".config",
      "outside/.aeh-direct-heartbeat.json",
      "outside/evil.ts",
      "src/b.ts",
    ];
    for (const file of fixtures) {
      expect(
        isDistributedRemoteEscapeExcludedV1(file),
        `parity for ${file}`,
      ).toBe(isWaveWorktreeExcludedV1(file));
    }
  });

  it("droppings do NOT trigger remote escape failure", () => {
    expect(findDistributedRemoteEscapeV1(DROPPINGS, SCOPE)).toEqual([]);
    expect(findDistributedRemoteEscapeV1([...DROPPINGS, "src/b.ts"], SCOPE)).toEqual([]);
  });

  it("real off-scope files still trigger remote escape failure", () => {
    expect(findDistributedRemoteEscapeV1(["outside/evil.ts"], SCOPE)).toEqual(["outside/evil.ts"]);
    expect(findDistributedRemoteEscapeV1([...DROPPINGS, "outside/evil.ts"], SCOPE)).toEqual([
      "outside/evil.ts",
    ]);
  });

  it("project-authored toolchain decoys still trigger (no enforcement-blindness)", () => {
    expect(findDistributedRemoteEscapeV1([".config/mise/config.toml"], SCOPE)).toEqual([
      ".config/mise/config.toml",
    ]);
    expect(
      findDistributedRemoteEscapeV1(
        [".config/mise/conf.d/aeh.toml", ".config/mise/config.toml"],
        SCOPE,
      ),
    ).toEqual([".config/mise/config.toml"]);
    // Nested heartbeat-named files are ordinary off-patch writes (root-only rule).
    expect(
      findDistributedRemoteEscapeV1(["outside/.aeh-direct-heartbeat.json"], SCOPE),
    ).toEqual(["outside/.aeh-direct-heartbeat.json"]);
  });

  it("scope matching itself is unchanged", () => {
    expect(findDistributedRemoteEscapeV1(["src/b.ts"], ["src/**"])).toEqual([]);
    expect(findDistributedRemoteEscapeV1(["src/b.ts"], ["src/b.ts"])).toEqual([]);
    expect(findDistributedRemoteEscapeV1(["src/other.ts"], SCOPE)).toEqual(["src/other.ts"]);
  });
});
