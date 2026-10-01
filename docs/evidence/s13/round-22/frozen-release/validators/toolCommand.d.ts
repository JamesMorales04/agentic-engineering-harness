import type { ValidationCheck, ValidatorSpec } from "../core/types.js";
import type { ValidationContext } from "./types.js";
export declare function runSpecCommand(context: ValidationContext, command: string, category: string, details?: Record<string, unknown>): Promise<ValidationCheck>;
export declare function renderTokens(command: string, context: ValidationContext): string;
export declare function missingTool(spec: ValidatorSpec, tool: string, category: string): ValidationCheck;
