import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/version.js";
import {
  assertInteractiveRunSelfHostingV1,
  assertIsolatedSelfHostingCharterV1,
  assertSelfHostingExecutionV1,
  bindSelfHostingCharterV1,
  canonicalCharterDigest,
  resolveSelfHostingAuthority,
  type SelfHostingCharterV1,
} from "../src/operations/selfHostingCharter.js";
import { startDetachedOperation } from "../src/operations/controller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-charter-test-"));
  roots.push(root);
  return root;
}

async function repoIdentity(): Promise<{ name: string; repository: { type: string; url: string } }> {
  const pkg = JSON.parse(
    await fs.readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { name: string; repository: { type: string; url: string } };
  return { name: pkg.name, repository: pkg.repository };
}

// A controller-checkout-shaped root: carries the Harness package identity.
async function controllerShapedRoot(): Promise<string> {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, ".git"));
  const identity = await repoIdentity();
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(identity));
  return root;
}

// A source-checkout-shaped control root (or worktree): Harness identity + Git metadata.
async function sourceShapedRoot(): Promise<string> {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, ".git"));
  const identity = await repoIdentity();
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(identity));
  return root;
}

function charterBody(targetRoot: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    targetRoot,
    controller: { aehVersion: VERSION },
    authorizedBy: "human-owner",
    authorizedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: { kinds: ["change"] },
    ...overrides,
  };
}

async function writeControllerCharter(
  controllerRoot: string,
  body: Record<string, unknown>,
  name = "experiment.json",
): Promise<string> {
  const digest = canonicalCharterDigest(body);
  const dir = path.join(controllerRoot, ".harness", "self-hosting-charters");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), `${JSON.stringify({ ...body, charterDigest: digest })}\n`);
  return digest;
}

describe("isolated self-hosting charter gate (DETERMINISTIC)", () => {
  it("consumer-shaped roots pass without any charter", async () => {
    const root = await tempRoot();
    await expect(assertIsolatedSelfHostingCharterV1(root, "change")).resolves.toBeUndefined();
  });

  it("packed-fixture-shaped roots (Harness name, no Git metadata) pass", async () => {
    // Disposable packed fixtures must keep working: without .git this
    // cannot be a source checkout, so the gate passes through.
    const root = await tempRoot();
    const identity = await repoIdentity();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify(identity));
    await expect(assertIsolatedSelfHostingCharterV1(root, "change")).resolves.toBeUndefined();
  });

  it("unresolvable Git authority fails closed", async () => {
    // .git present but owning checkout unresolvable: refuse, never pass.
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", {
        controllerRoot,
        resolveCommonDir: () => undefined,
      }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_REQUIRED/);
  });

  it("the live controller checkout is frozen even with a charter", async () => {
    const controllerRoot = await controllerShapedRoot();
    await writeControllerCharter(controllerRoot, charterBody(controllerRoot));
    await expect(
      assertIsolatedSelfHostingCharterV1(controllerRoot, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CONTROLLER_FROZEN/);
  });

  it("a valid controller-side charter for this exact target passes", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    const digest = await writeControllerCharter(controllerRoot, charterBody(root));
    const charter = await assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot });
    expect(charter?.charterDigest).toBe(digest);
  });

  it("target-local charter files are not authoritative", async () => {
    // A lead that mints .harness/self-hosting-charter.json beside the code
    // it wants to change authorizes nothing: authority lives controller-side.
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    const body = charterBody(root);
    const digest = canonicalCharterDigest(body);
    await fs.mkdir(path.join(root, ".harness"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".harness", "self-hosting-charter.json"),
      `${JSON.stringify({ ...body, charterDigest: digest })}\n`,
    );
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_REQUIRED/);
  });

  it("tampered charters fail closed (digest mismatch)", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    await writeControllerCharter(controllerRoot, charterBody(root));
    const file = path.join(controllerRoot, ".harness", "self-hosting-charters", "experiment.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    parsed.scope = { kinds: ["change", "run"] };
    await fs.writeFile(file, `${JSON.stringify(parsed)}\n`);
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
  });

  it("expired, version-drifted, and wrong-kind charters fail closed", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["expired", charterBody(root, { expiresAt: new Date(Date.now() - 1_000).toISOString() })],
      ["version", charterBody(root, { controller: { aehVersion: "0.0.0-test" } })],
      ["kind", charterBody(root, { scope: { kinds: ["audit"] } })],
    ];
    for (const [name, body] of cases) {
      await writeControllerCharter(controllerRoot, body, `${name}.json`);
    }
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
  });

  it("charters naming another target do not authorize this root", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    await writeControllerCharter(controllerRoot, charterBody("/elsewhere/entirely"));
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_REQUIRED/);
  });

  it("malformed charter files fail closed, never pass", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    // A malformed file naming this target: STALE (seen-but-invalid).
    // Note: targetRoot is checked on parsed JSON; an unparsable file is
    // skipped, so seed a valid-but-tampered sibling to force the STALE path.
    const dir = path.join(controllerRoot, ".harness", "self-hosting-charters");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "broken.json"), "not json\n");
    await writeControllerCharter(controllerRoot, charterBody(root), "ok.json");
    const file = path.join(dir, "ok.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    parsed.authorizedBy = "";
    await fs.writeFile(file, `${JSON.stringify(parsed)}\n`);
    await expect(
      assertIsolatedSelfHostingCharterV1(root, "change", { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
  });

  it("real git topology: main checkout frozen, worktree charter-gated (production path, no seams)", async () => {
    const git = (args: string[], cwd: string) => {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const origin = await tempRoot();
    const identity = await repoIdentity();
    await fs.writeFile(path.join(origin, "package.json"), JSON.stringify(identity));
    git(["init", "-b", "main"], origin);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "package.json"], origin);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], origin);
    const worktree = `${origin}-wt`;
    roots.push(worktree);
    git(["worktree", "add", "--detach", worktree], origin);
    // Main checkout: live controller -> frozen on the real git path.
    await expect(assertIsolatedSelfHostingCharterV1(origin, "change")).rejects.toThrow(
      /SELF_HOSTING_CONTROLLER_FROZEN/,
    );
    // Worktree without charter: required.
    await expect(assertIsolatedSelfHostingCharterV1(worktree, "change")).rejects.toThrow(
      /SELF_HOSTING_CHARTER_REQUIRED/,
    );
    // Worktree with controller-side charter at the origin checkout: admitted.
    const digest = await writeControllerCharter(origin, charterBody(worktree));
    const charter = (await assertIsolatedSelfHostingCharterV1(
      worktree,
      "change",
    )) as SelfHostingCharterV1;
    expect(charter.charterDigest).toBe(digest);
  });

  it("startDetachedOperation refuses charterless source checkouts before preflight and durable writes", async () => {
    const root = await sourceShapedRoot();
    const resolveChangePreflight = vi.fn();
    await expect(
      startDetachedOperation(root, "change", { request: "Improve Home." }, {
        nodeExecutable: process.execPath,
        entryFile: "/pkg/dist/main.js",
        initiator: { kind: "CLI" },
        spawnProcess: vi.fn(() => ({ pid: 1, unref: vi.fn() })) as never,
        resolveChangePreflight,
      } as never),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_REQUIRED/);
    expect(resolveChangePreflight).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, ".harness", "operations"))).rejects.toThrow();
  });

  it("execution binding: bound operations execute, unbound/rotated ones refuse", async () => {    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    const opts = { controllerRoot };
    const digest = await writeControllerCharter(controllerRoot, charterBody(root));
    const charter = (await assertIsolatedSelfHostingCharterV1(root, "change", opts)) as SelfHostingCharterV1;
    expect(charter.charterDigest).toBe(digest);
    await bindSelfHostingCharterV1(root, "CHANGE-1", charter);
    // Currently-valid charter + matching binding: passes.
    await expect(
      assertSelfHostingExecutionV1(root, { id: "CHANGE-1", kind: "change" }, opts),
    ).resolves.toBeUndefined();
    // Audit records skip the check entirely.
    await expect(
      assertSelfHostingExecutionV1(root, { id: "CHANGE-1", kind: "audit" }, opts),
    ).resolves.toBeUndefined();
    // Missing binding: refuses.
    await expect(
      assertSelfHostingExecutionV1(root, { id: "CHANGE-9", kind: "change" }, opts),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
    // Charter rotation strands the in-flight binding: refuses.
    await writeControllerCharter(
      controllerRoot,
      charterBody(root, { authorizedBy: "human-owner-rotated" }),
      "experiment.json",
    );
    await expect(
      assertSelfHostingExecutionV1(root, { id: "CHANGE-1", kind: "change" }, opts),
    ).rejects.toThrow(/SELF_HOSTING_CHARTER_STALE/);
  });

  it("synchronous aeh run is gated on source checkouts (no direct runTask bypass)", async () => {
    const controllerRoot = await controllerShapedRoot();
    const root = await sourceShapedRoot();
    const opts = { controllerRoot };
    // Charterless target: refused.
    await expect(assertInteractiveRunSelfHostingV1(root, opts)).rejects.toThrow(
      /SELF_HOSTING_CHARTER_REQUIRED/,
    );
    // Change-only charter: refused (run needs kind "run").
    await writeControllerCharter(controllerRoot, charterBody(root));
    await expect(assertInteractiveRunSelfHostingV1(root, opts)).rejects.toThrow(
      /SELF_HOSTING_CHARTER_STALE/,
    );
    // Run-covering charter: admitted (synchronous human driver is the Owner checkpoint).
    await writeControllerCharter(
      controllerRoot,
      charterBody(root, { scope: { kinds: ["change", "run"] } }),
      "run.json",
    );
    await expect(assertInteractiveRunSelfHostingV1(root, opts)).resolves.toBeUndefined();
    // Live controller: frozen even with charter.
    await expect(
      assertInteractiveRunSelfHostingV1(controllerRoot, { controllerRoot }),
    ).rejects.toThrow(/SELF_HOSTING_CONTROLLER_FROZEN/);
    // Consumer root: passes.
    await expect(assertInteractiveRunSelfHostingV1(await tempRoot(), opts)).resolves.toBeUndefined();
  });

  it("cli run action invokes the self-hosting entry guard", async () => {
    const text = await fs.readFile(
      path.resolve(import.meta.dirname, "..", "src", "cli.ts"),
      "utf8",
    );
    expect(text).toContain("assertInteractiveRunSelfHostingV1");
  });
});
