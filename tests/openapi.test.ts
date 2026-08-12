import { describe, expect, it } from "vitest";
import { compareOpenApi } from "../src/validators/openapi.js";
describe("OpenAPI compatibility", () => {
  it("accepts additive compatible changes", () => {
    const before = { paths: { "/pets": { get: { responses: { "200": {} } } } }, components: { schemas: { Pet: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } };
    const after = { paths: { "/pets": { get: { responses: { "200": {} } } }, "/owners": { get: { responses: { "200": {} } } } }, components: { schemas: { Pet: { type: "object", properties: { id: { type: "string" }, nickname: { type: "string" } }, required: ["id"] } } } };
    expect(compareOpenApi(before, after)).toEqual([]);
  });
  it("detects removed and newly-required contract elements", () => {
    const before = { paths: { "/pets": { get: { parameters: [{ name: "limit", in: "query", required: false }], responses: { "200": {}, "404": {} } } } }, components: { schemas: { Pet: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] } } } };
    const after = { paths: { "/pets": { get: { parameters: [{ name: "limit", in: "query", required: true }], responses: { "200": {} } } } }, components: { schemas: { Pet: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } };
    const breaking = compareOpenApi(before, after);
    expect(breaking).toContain("parameter query:limit became required on GET /pets"); expect(breaking).toContain("removed response 404 from GET /pets"); expect(breaking).toContain("removed property Pet.name");
  });
});
