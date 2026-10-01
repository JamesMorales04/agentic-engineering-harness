import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = path.resolve(process.cwd());
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const destination = path.resolve(process.env.AEH_PACK_DESTINATION ?? root);
await fs.mkdir(destination, { recursive: true });
const before = await fs.readdir(destination);
if (before.some((entry) => entry.endsWith(".tgz"))) {
  throw new Error(`PACKAGED_CONSUMER_DESTINATION_NOT_FRESH: ${destination} already contains a .tgz archive.`);
}
const cache = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-pack-cache-"));
try {
  await execFileAsync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", destination, "--cache", cache], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
} catch (error) {
  const details = error && typeof error === "object" ? error : { message: String(error) };
  const stderr = printable(details.stderr);
  const stdout = printable(details.stdout);
  const message = printable(details.message);
  const code = printable(details.code);
  throw new Error(`PACKAGED_CONSUMER_PACK_FAILED: code=${code}; ${stderr || stdout || message}`);
} finally {
  await fs.rm(cache, { recursive: true, force: true });
}

const expectedFilename = `${packageMetadata.name.replace(/^@/, "").replaceAll("/", "-")}-${packageMetadata.version}.tgz`;
const archives = (await fs.readdir(destination)).filter((entry) => entry.endsWith(".tgz"));
if (archives.length !== 1 || archives[0] !== expectedFilename) {
  throw new Error(`PACKAGED_CONSUMER_IDENTITY_MISMATCH: expected exactly ${expectedFilename}, received ${JSON.stringify(archives)}.`);
}
const archive = path.resolve(destination, expectedFilename);
const stat = await fs.stat(archive).catch(() => undefined);
if (!stat?.isFile() || stat.size === 0) throw new Error(`PACKAGED_CONSUMER_TARBALL_REQUIRED: npm pack did not produce a non-empty ${expectedFilename}.`);
const tarOutput = await execFileAsync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" });
const tarMetadata = JSON.parse(tarOutput.stdout);
if (tarMetadata.name !== packageMetadata.name || tarMetadata.version !== packageMetadata.version) {
  throw new Error(`PACKAGED_CONSUMER_CONTENT_IDENTITY_MISMATCH: archive contains ${tarMetadata.name}@${tarMetadata.version}, expected ${packageMetadata.name}@${packageMetadata.version}.`);
}
process.stdout.write(archive + "\n");

function printable(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}
