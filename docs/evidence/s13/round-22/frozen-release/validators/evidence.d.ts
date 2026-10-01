export interface PolicyEvidence {
    newDependencies: string[];
    schemaChanged: boolean;
    schemaFiles: string[];
}
export declare function collectPolicyEvidence(changedFiles: string[]): PolicyEvidence;
