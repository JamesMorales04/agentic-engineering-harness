import type { ContextFragment, ContextPreservation } from "./types.js";
export declare function classifyFragment(fragment: ContextFragment): ContextPreservation;
export declare function canLossyCompress(fragment: ContextFragment): boolean;
export declare function isRequired(fragment: ContextFragment): boolean;
