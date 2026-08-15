import versions from "../../templates/provider-versions.json" with { type: "json" };

export const providerVersions = versions as {
  headroom: string;
  graphify: string;
  engram: string;
  serena: string;
  trivy: string;
  opengrep: string;
  playwright: string;
  pnpm: string;
};
