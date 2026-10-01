import fs from "node:fs";
import path from "node:path";

export function resolveTrivyPath(configuredPath, pathValue = process.env.PATH ?? "") {
  if (typeof configuredPath === "string" && configuredPath.trim()) {
    const candidate = path.resolve(configuredPath.trim());
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "trivy");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch { return false; }
}
