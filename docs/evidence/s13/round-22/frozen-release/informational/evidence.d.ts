export interface InformationalEvidenceRange {
    startByte: number;
    endByte: number;
}
export interface InformationalEvidenceRefOptions {
    /** Hash of the live file, independent of the selected evidence range. */
    fileSha256?: string;
    /** A later bounded range to return while preserving the original locator. */
    requestedRange?: InformationalEvidenceRange;
}
export interface ParsedInformationalEvidenceRef {
    path: string;
    /** Hash of the selected range, or of the complete file for a legacy ref. */
    sha256: string;
    fileSha256?: string;
    range?: InformationalEvidenceRange;
    requestedRange?: InformationalEvidenceRange;
}
export interface InformationalEvidenceResult {
    ref: string;
    path: string;
    /** The selected-range identity carried by the ref. */
    sha256: string;
    fileSha256?: string;
    content: string;
    estimatedTokens: number;
    truncated: boolean;
    range?: InformationalEvidenceRange;
    selectedRange?: InformationalEvidenceRange;
}
/**
 * Build a repository-relative reference. New references carry both the
 * selected chunk identity and a whole-file identity, so a caller can ask for
 * a later range without confusing that range's hash with the original one.
 * The optional arguments preserve the old range-only format for callers that
 * have not yet adopted file identity.
 */
export declare function informationalEvidenceRef(filePath: string, contentSha256: string, range?: InformationalEvidenceRange, options?: InformationalEvidenceRefOptions): string;
export declare function parseInformationalEvidenceRef(ref: string): ParsedInformationalEvidenceRef;
/**
 * Retrieve a bounded live repository range. New refs verify the whole-file
 * identity with a streaming hash and independently verify the selected chunk;
 * only the requested bytes are retained for delivery. There is deliberately
 * no evidence persistence or cache here: a ref authorizes inspection of the
 * live repository, not an artifact lookup.
 */
export declare function retrieveInformationalEvidence(root: string, ref: string, maxTokens?: number): Promise<InformationalEvidenceResult>;
