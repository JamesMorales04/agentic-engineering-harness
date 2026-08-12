import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ValidationCheck } from "../core/types.js";
import type { ValidationContext } from "./types.js";

const httpMethods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export async function runOpenApiValidator(context: ValidationContext): Promise<ValidationCheck> {
  const baseline = stringOption(context.spec.options, "baseline");
  const current = stringOption(context.spec.options, "current");
  if (!baseline || !current) return { id: context.spec.id, category: "contract", status: context.spec.required ? "FAIL" : "WARN", message: "OpenAPI validator requires options.baseline and options.current." };
  try {
    const before = parseDocument(await fs.readFile(path.resolve(context.root, baseline), "utf8"));
    const after = parseDocument(await fs.readFile(path.resolve(context.root, current), "utf8"));
    const breaking = compareOpenApi(before, after);
    return { id: context.spec.id, category: "contract", status: breaking.length ? "FAIL" : "PASS", message: breaking.length ? `OpenAPI compatibility failed: ${breaking.length} breaking change(s).` : "OpenAPI remains backward compatible for the supported checks.", details: { baseline, current, breaking } };
  } catch (error) {
    return { id: context.spec.id, category: "contract", status: context.spec.required ? "FAIL" : "WARN", message: `OpenAPI compatibility could not run: ${String(error)}` };
  }
}

interface OpenApiDocument { paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, JsonSchema> }; }
interface Operation { parameters?: Parameter[]; responses?: Record<string, unknown>; }
interface Parameter { name?: string; in?: string; required?: boolean; }
interface JsonSchema { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; }

export function compareOpenApi(before: OpenApiDocument, after: OpenApiDocument): string[] {
  const breaking: string[] = [];
  const beforePaths = before.paths ?? {}; const afterPaths = after.paths ?? {};
  for (const [route, beforePath] of Object.entries(beforePaths)) {
    const afterPath = afterPaths[route];
    if (!afterPath) { breaking.push(`removed path ${route}`); continue; }
    for (const method of httpMethods) {
      const beforeOperation = beforePath[method]; if (!beforeOperation) continue;
      const afterOperation = afterPath[method];
      if (!afterOperation) { breaking.push(`removed operation ${method.toUpperCase()} ${route}`); continue; }
      compareParameters(route, method, beforeOperation, afterOperation, breaking);
      compareResponses(route, method, beforeOperation, afterOperation, breaking);
    }
  }
  const beforeSchemas = before.components?.schemas ?? {}; const afterSchemas = after.components?.schemas ?? {};
  for (const [name, schema] of Object.entries(beforeSchemas)) {
    const next = afterSchemas[name]; if (!next) { breaking.push(`removed schema ${name}`); continue; }
    compareSchema(name, schema, next, breaking);
  }
  return breaking;
}
function compareParameters(route: string, method: string, before: Operation, after: Operation, breaking: string[]): void {
  const key = (p: Parameter): string => `${p.in ?? ""}:${p.name ?? ""}`;
  const beforeMap = new Map((before.parameters ?? []).map((item) => [key(item), item])); const afterMap = new Map((after.parameters ?? []).map((item) => [key(item), item]));
  for (const [id, parameter] of beforeMap) { const next = afterMap.get(id); if (!next) breaking.push(`removed parameter ${id} from ${method.toUpperCase()} ${route}`); else if (!parameter.required && next.required) breaking.push(`parameter ${id} became required on ${method.toUpperCase()} ${route}`); }
  for (const [id, parameter] of afterMap) if (!beforeMap.has(id) && parameter.required) breaking.push(`added required parameter ${id} to ${method.toUpperCase()} ${route}`);
}
function compareResponses(route: string, method: string, before: Operation, after: Operation, breaking: string[]): void { const next = after.responses ?? {}; for (const status of Object.keys(before.responses ?? {})) if (!(status in next)) breaking.push(`removed response ${status} from ${method.toUpperCase()} ${route}`); }
function compareSchema(pathName: string, before: JsonSchema, after: JsonSchema, breaking: string[]): void {
  if (before.type && after.type && before.type !== after.type) breaking.push(`schema ${pathName} changed type ${before.type} -> ${after.type}`);
  const beforeProperties = before.properties ?? {}; const afterProperties = after.properties ?? {};
  for (const [name, schema] of Object.entries(beforeProperties)) { const next = afterProperties[name]; const childPath = `${pathName}.${name}`; if (!next) breaking.push(`removed property ${childPath}`); else compareSchema(childPath, schema, next, breaking); }
  const beforeRequired = new Set(before.required ?? []); for (const required of after.required ?? []) if (!beforeRequired.has(required)) breaking.push(`property ${pathName}.${required} became required`);
}
function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined { const value = options?.[key]; return typeof value === "string" && value.trim() ? value : undefined; }
function parseDocument(content: string): OpenApiDocument { try { return JSON.parse(content) as OpenApiDocument; } catch { return YAML.parse(content) as OpenApiDocument; } }
