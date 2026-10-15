import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { AskForm } from "./types.ts"

// Transport capability, not client name, selects the interaction mechanism.
export function mcpInteraction(server: Server, fallback?: AskForm): AskForm {
  return async (form, signal) => {
    signal.throwIfAborted()
    const capability = server.getClientCapabilities()?.elicitation
    if (!capability || (!("form" in capability) && Object.keys(capability).length > 0)) return fallback?.(form, signal)
    const result = await server.elicitInput({ mode: "form", message: form.message,
      requestedSchema: { type: "object", properties: form.properties, required: form.required } }, { signal })
    signal.throwIfAborted()
    if (result.action !== "accept") return undefined
    const answer: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(result.content ?? {})) {
      if (typeof value === "string" || typeof value === "boolean") answer[key] = value
    }
    return answer
  }
}
