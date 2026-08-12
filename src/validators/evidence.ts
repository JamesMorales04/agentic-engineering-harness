export interface PolicyEvidence {
  newDependencies: string[];
  schemaChanged: boolean;
  schemaFiles: string[];
}

const dependencyPatterns = [/(^|\/)package\.json$/, /(^|\/)package-lock\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/, /\.csproj$/, /(^|\/)Directory\.Packages\.props$/, /(^|\/)pyproject\.toml$/, /(^|\/)requirements[^/]*\.txt$/, /(^|\/)go\.mod$/, /(^|\/)Cargo\.toml$/];
const schemaPatterns = [/(^|\/)migrations?\//i, /(^|\/)schema\.prisma$/i, /(^|\/)openapi\.(json|ya?ml)$/i, /(^|\/)swagger\.(json|ya?ml)$/i, /\.sql$/i];

export function collectPolicyEvidence(changedFiles: string[]): PolicyEvidence {
  const dependencies = changedFiles.filter((file) => dependencyPatterns.some((pattern) => pattern.test(file)));
  const schemaFiles = changedFiles.filter((file) => schemaPatterns.some((pattern) => pattern.test(file)));
  return { newDependencies: dependencies, schemaChanged: schemaFiles.length > 0, schemaFiles };
}
