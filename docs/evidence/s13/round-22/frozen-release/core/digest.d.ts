/** Canonical JSON-like serialization for identity and provenance values. */
export declare function canonicalSerialize(value: unknown): string;
export declare function sha256Canonical(value: unknown): string;
export declare function sha256Utf8(value: string | Buffer): string;
