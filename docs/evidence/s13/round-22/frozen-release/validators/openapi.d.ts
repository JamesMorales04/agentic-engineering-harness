import type { ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";
export declare function runOpenApiValidator(context: ValidationContext): Promise<ValidationCheck>;
interface OpenApiDocument {
    paths?: Record<string, Record<string, Operation>>;
    components?: {
        schemas?: Record<string, JsonSchema>;
    };
}
interface Operation {
    parameters?: Parameter[];
    responses?: Record<string, unknown>;
}
interface Parameter {
    name?: string;
    in?: string;
    required?: boolean;
}
interface JsonSchema {
    type?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
}
export declare function compareOpenApi(before: OpenApiDocument, after: OpenApiDocument): string[];
export {};
