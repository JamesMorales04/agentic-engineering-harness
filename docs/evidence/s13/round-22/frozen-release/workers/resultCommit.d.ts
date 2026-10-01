import { type AcceptedStructuredResult, type StructuredResultSource } from "./resultGateway.js";
export declare function commitStructuredResult<T = unknown>(root: string, operationId: string, channelId: string, payload: unknown, source: StructuredResultSource): Promise<AcceptedStructuredResult<T>>;
