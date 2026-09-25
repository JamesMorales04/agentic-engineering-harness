export function contextRetrievalToolDescription(): Record<string, unknown> {
  return { name: "aeh_context_retrieve", description: "Retrieve a controller-authorized, current-session AEH context reference. Arbitrary fragment names and filesystem paths are rejected.", inputSchema: { type: "object", required: ["refId"], properties: { refId: { type: "string", minLength: 1 }, maxTokens: { type: "integer", minimum: 1 } }, additionalProperties: false } };
}
