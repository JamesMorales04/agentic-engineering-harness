export interface SerenaMcpContractResult {
    initialized: boolean;
    toolNames: string[];
    semanticTool: string;
    retrievalText: string;
}
export declare function runSerenaMcpContract(root: string, command?: string): Promise<SerenaMcpContractResult>;
