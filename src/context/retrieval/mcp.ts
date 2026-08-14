import type { ContextRetrievalGateway, RetrievalRequest } from "./gateway.js";

export function contextRetrievalToolDescription(): Record<string, unknown> {
  return { name: "aeh_context_retrieve", description: "Retrieve an already-authorized AEH context fragment artifact; arbitrary filesystem paths are rejected.", inputSchema: { type: "object", required: ["fragmentId"], properties: { fragmentId: { type: "string", minLength: 1 }, section: { enum: ["raw", "source"] }, maxTokens: { type: "integer", minimum: 1 } }, additionalProperties: false } };
}

export async function handleContextRetrievalRequest(gateway: ContextRetrievalGateway, request: RetrievalRequest): Promise<Record<string, unknown>> {
  const result = await gateway.retrieve(request);
  return { status: "OK", ...result };
}
