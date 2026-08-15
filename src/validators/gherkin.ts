import type { ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";
import { resultCheck } from "../providers/validation/protocol.js";
import { runBddExecution } from "../providers/validation/bddExecution.js";
import type { ValidationProviderContext } from "../providers/validation/types.js";

export async function runGherkinValidator(context: ValidationContext): Promise<ValidationCheck> {
  const providerContext: ValidationProviderContext = { root: context.root, config: context.config, contract: context.contract, spec: context.spec, capability: "bdd", rawArtifactDirectory: context.config.evidence?.outputDir ?? ".harness/evidence/raw", baseRef: context.baseRef };
  const execution = await runBddExecution(providerContext);
  return resultCheck(context.spec.id, "acceptance", execution.result, execution.required);
}
