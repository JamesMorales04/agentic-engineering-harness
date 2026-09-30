import { GenericBddExecutionProvider } from "./bddExecution.js";
import type { ProviderDetection, ValidationProviderContext } from "./types.js";
/** Optional compatibility adapter. It is never selected by the generic BDD path. */
export declare class ReqnrollBddProvider extends GenericBddExecutionProvider {
    readonly id: string;
    detect(context: ValidationProviderContext): Promise<ProviderDetection | undefined>;
}
