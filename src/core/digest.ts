import { createHash } from "node:crypto";

/** Canonical JSON-like serialization for identity and provenance values. */
export function canonicalSerialize(value: unknown): string {
  return serialize(value, "$", false);
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

export function sha256Utf8(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function serialize(value: unknown, path: string, nested: boolean): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Unsupported non-finite number at ${path}.`);
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (value === undefined) {
    if (nested) return "";
    throw new TypeError(`Unsupported undefined value at ${path}.`);
  }
  if (["bigint", "function", "symbol"].includes(typeof value)) throw new TypeError(`Unsupported ${typeof value} value at ${path}.`);
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => {
      if (item === undefined) throw new TypeError(`Unsupported undefined array value at ${path}[${index}].`);
      return serialize(item, `${path}[${index}]`, false);
    }).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError(`Unsupported value at ${path}.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Unsupported object type at ${path}.`);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError(`Unsupported symbol-keyed property at ${path}.`);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, `${path}.${key}`, true)}`);
  return `{${entries.join(",")}}`;
}
