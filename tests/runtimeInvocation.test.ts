import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planSelfCheckoutRuntime, resolveStartProjectRoot } from "../src/runtime/invocation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-runtime-invocation-"));
  roots.push(root);
  return root;
}

describe("AEH runtime invocation identity", () => {
  it("redirects an external/npm-exec runtime to the checkout-local dist entry", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(path.join(root, "dist", "main.js"), "// local build\n");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agentic-engineering-harness", version: "0.6.6" }));

    const plan = await planSelfCheckoutRuntime(root, "/home/test/.npm/_npx/cache/node_modules/.bin/aeh");
    expect(plan).toEqual(expect.objectContaining({
      selfCheckout: true,
      localEntryReady: true,
      shouldRelaunch: true,
      checkoutVersion: "0.6.6",
      localEntry: path.join(root, "dist", "main.js")
    }));
  });

  it("does not recurse once running through checkout-local dist", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    const localEntry = path.join(root, "dist", "main.js");
    await fs.writeFile(localEntry, "// local build\n");
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "agentic-engineering-harness", version: "0.6.6" }));

    expect((await planSelfCheckoutRuntime(root, localEntry)).shouldRelaunch).toBe(false);
  });

  it("does not redirect consumer repositories", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "consumer" }));
    const plan = await planSelfCheckoutRuntime(root, "/tmp/aeh");
    expect(plan.selfCheckout).toBe(false);
    expect(plan.shouldRelaunch).toBe(false);
  });

  it("resolves the start project directory while skipping option values", () => {
    expect(resolveStartProjectRoot(["--lead", "lead", "--title", "AEH Lead", "repo"], "/workspace")).toBe("/workspace/repo");
    expect(resolveStartProjectRoot(["--resume"], "/workspace")).toBe("/workspace");
  });
});
