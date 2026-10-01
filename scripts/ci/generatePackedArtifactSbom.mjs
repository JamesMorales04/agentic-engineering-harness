import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(process.cwd());
const [artifactArgument, sbomArgument] = process.argv.slice(2);
if (!artifactArgument || !sbomArgument || process.argv.length !== 4) {
  throw new Error("PACKED_SBOM_USAGE: expected root-relative packed artifact and CycloneDX output paths.");
}

const artifactPath = normalizeRootRelative(artifactArgument);
const sbomPath = normalizeRootRelative(sbomArgument);
const artifactFile = path.resolve(root, artifactPath);
const sbomFile = path.resolve(root, sbomPath);
const artifactBytes = await fs.readFile(artifactFile);
const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aeh-packed-artifact-sbom-"));

try {
  const members = execFileSync("tar", ["-tzf", artifactFile], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  if (!members.length || members.some((member) => member.startsWith("/") || member.split("/").some((part) => part === "..") || !member.startsWith("package/"))) {
    throw new Error("PACKED_SBOM_ARCHIVE_LAYOUT_INVALID: candidate archive must contain only normalized package-relative members.");
  }

  const extractedRoot = path.join(temporaryRoot, "package");
  await fs.mkdir(extractedRoot);
  execFileSync("tar", ["-xzf", artifactFile, "-C", extractedRoot, "--strip-components=1", "package"], { stdio: "ignore" });
  const packagedManifest = JSON.parse(await fs.readFile(path.join(extractedRoot, "package.json"), "utf8"));
  const buildLockFile = path.join(root, "package-lock.json");
  const buildLock = JSON.parse(await fs.readFile(buildLockFile, "utf8"));
  const lockRoot = buildLock.packages?.[""];
  if (!lockRoot || lockRoot.name !== packagedManifest.name || lockRoot.version !== packagedManifest.version) {
    throw new Error("PACKED_SBOM_LOCK_IDENTITY_MISMATCH: build lock root does not identify the exact packaged project.");
  }
  await fs.copyFile(buildLockFile, path.join(extractedRoot, "package-lock.json"));
  await fs.mkdir(path.dirname(sbomFile), { recursive: true });
  execFileSync("trivy", ["fs", "--format", "cyclonedx", "--output", sbomFile, extractedRoot], { stdio: "inherit" });

  const sbom = JSON.parse(await fs.readFile(sbomFile, "utf8"));
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error("PACKED_SBOM_CYCLONEDX_INVALID: Trivy did not produce a CycloneDX component inventory.");
  }
  const runtimeDependencies = Object.keys({
    ...(packagedManifest.dependencies ?? {}),
    ...(packagedManifest.optionalDependencies ?? {})
  });
  const dependencyRefs = [];
  for (const dependencyName of runtimeDependencies) {
    const lockEntry = buildLock.packages[`node_modules/${dependencyName}`];
    if (!lockEntry?.version) throw new Error(`PACKED_SBOM_LOCK_DEPENDENCY_MISSING: ${dependencyName}`);
    const expectedPurl = `${npmPurlBase(dependencyName)}@${lockEntry.version}`;
    const component = sbom.components.find((entry) => entry.purl === expectedPurl);
    if (!component) throw new Error(`PACKED_SBOM_COMPONENT_MISSING: Trivy SBOM omitted locked runtime dependency ${expectedPurl}.`);
    dependencyRefs.push(component["bom-ref"] ?? expectedPurl);
  }

  const productPurl = `${npmPurlBase(packagedManifest.name)}@${packagedManifest.version}`;
  if (sbom.components.some((component) => component.purl === productPurl)) {
    throw new Error(`PACKED_SBOM_PRODUCT_DUPLICATE: product component already exists in Trivy output: ${productPurl}`);
  }
  const productComponent = {
    type: "application",
    name: packagedManifest.name,
    version: packagedManifest.version,
    "bom-ref": productPurl,
    purl: productPurl,
    hashes: [{ alg: "SHA-256", content: artifactSha256 }],
    properties: [
      { name: "aeh:packedArtifactPath", value: artifactPath },
      { name: "aeh:sbomDependencyLock", value: "package-lock.json" }
    ]
  };
  sbom.components.push(productComponent);
  sbom.metadata = sbom.metadata ?? {};
  sbom.metadata.component = {
    type: "application",
    name: packagedManifest.name,
    version: packagedManifest.version,
    "bom-ref": `urn:aeh:packed-candidate:${artifactSha256}`,
    purl: productPurl,
    hashes: [{ alg: "SHA-256", content: artifactSha256 }]
  };
  sbom.metadata.properties = [
    ...(Array.isArray(sbom.metadata.properties) ? sbom.metadata.properties : []),
    { name: "aeh:packedArtifactPath", value: artifactPath },
    { name: "aeh:packedArtifactSha256", value: artifactSha256 }
  ];
  sbom.dependencies = Array.isArray(sbom.dependencies) ? sbom.dependencies : [];
  sbom.dependencies.push({ ref: productPurl, dependsOn: [...new Set(dependencyRefs)] });
  await fs.writeFile(sbomFile, `${JSON.stringify(sbom, null, 2)}\n`);

  const generated = JSON.parse(await fs.readFile(sbomFile, "utf8"));
  const packedProduct = generated.components.find((component) => component.name === packagedManifest.name && component.version === packagedManifest.version && component.purl === productPurl);
  if (!packedProduct || generated.components.length < runtimeDependencies.length + 1) {
    throw new Error("PACKED_SBOM_IDENTITY_OR_COMPONENTS_MISSING: SBOM must include the exact packed project identity and its locked runtime components.");
  }
  process.stdout.write(`${JSON.stringify({ artifact: artifactPath, artifactSha256, product: productPurl, componentCount: generated.components.length, runtimeDependencies: runtimeDependencies.length })}\n`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

function normalizeRootRelative(value) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`PACKED_SBOM_PATH_INVALID: ${value}`);
  }
  return normalized;
}

function npmPurlBase(name) {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}`;
}
