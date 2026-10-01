import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../version.js";
const versions = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "templates", "provider-versions.json"), "utf8"));
export const providerVersions = versions;
//# sourceMappingURL=versions.js.map