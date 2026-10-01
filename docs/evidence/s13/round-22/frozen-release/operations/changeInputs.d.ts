export interface ChangeInputReference {
    kind: "audit";
    id: string;
    sourceArtifact: string;
    artifact: string;
    sha256: string;
    summary: Record<string, unknown>;
}
export declare function resolveChangeInputs(controlRoot: string, operationId: string, request: string): Promise<ChangeInputReference[]>;
export declare function changeInputsPrompt(inputs: ChangeInputReference[]): string;
