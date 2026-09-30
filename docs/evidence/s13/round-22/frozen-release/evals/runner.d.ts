import type { HarnessProjectConfig } from "../core/types.js";
import type { EvalCorpusIdentityV1, EvalCorpusManifestV1, EvalResult } from "./types.js";
export declare function runEvalCase(root: string, config: HarnessProjectConfig, caseId: string, variantName?: string): Promise<EvalResult>;
export declare function compareEvalCase(root: string, config: HarnessProjectConfig, caseId: string): Promise<EvalResult[]>;
export declare function evalCorpusDir(root: string, config: HarnessProjectConfig): string;
/** Load the committed corpus manifest. A corpus without a manifest has no recorded identity. */
export declare function loadEvalCorpusManifest(root: string, config: HarnessProjectConfig): Promise<EvalCorpusManifestV1 | undefined>;
/**
 * Deterministic corpus identity over the manifest, every case definition,
 * every fixed fixture file, and every case's executable scenario harness
 * closure inside the project `evals/` tree (the scenario entry file plus its
 * relative imports, e.g. the shared result writer). Production `src/` code is
 * bound separately by the recorded build identity, so a scored observation is
 * bound to both the corpus revision and the executable harness that produced
 * it. The digest is recorded on each eval result.
 */
export declare function computeEvalCorpusIdentity(root: string, config: HarnessProjectConfig, caseId?: string): Promise<EvalCorpusIdentityV1 | undefined>;
