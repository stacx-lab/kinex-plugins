import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { KinexCapabilities } from "@kinex/core/integration"

interface Update { after: number; snapshot: string; content: string; timestamp: number }
function isUpdate(value: unknown): value is Update {
  return !!value && typeof value === "object" && "after" in value && typeof value.after === "number"
    && "snapshot" in value && typeof value.snapshot === "string" && "content" in value && typeof value.content === "string"
    && "timestamp" in value && typeof value.timestamp === "number"
}

/** Persist a projection ledger through the public extension API, without mutating
 * Pi's session/agent internals. Stable insertion positions preserve old prefixes. */
export async function projectContext(pi: ExtensionAPI, ctx: ExtensionContext, event: ContextEvent, capabilities: KinexCapabilities) {
  const branch = ctx.sessionManager.getBranch()
  const boundary = branch.findLastIndex(entry => entry.type === "compaction")
  const updates = branch.slice(boundary + 1).flatMap(entry => entry.type === "custom" && entry.customType === "kinex-context-projection" && isUpdate(entry.data) ? [entry.data] : [])
  const context = await capabilities.context()
  const catalog = await capabilities.tools.list()
  const skills = await capabilities.skills.list()
  const sections = { ...context.sections, "kinex.skills": JSON.stringify(skills), "kinex.problems": catalog.problems.join("\n") }
  const snapshot = JSON.stringify(sections)
  if (updates.at(-1)?.snapshot !== snapshot) {
    const update: Update = {
      after: event.messages.filter(message => message.role !== "system").length,
      snapshot, timestamp: Date.now(),
      content: `<kinex_context>\n${Object.entries(sections).map(([key, value]) => `${key}:\n${value || "(none)"}`).join("\n\n")}\n</kinex_context>`,
    }
    pi.appendEntry("kinex-context-projection", update)
    updates.push(update)
  }
  const messages: ContextEvent["messages"] = []
  let count = 0
  const insert = () => {
    for (const update of updates.filter(update => update.after === count)) messages.push({
      role: "custom", customType: "kinex-context", content: update.content, display: false, timestamp: update.timestamp,
    })
  }
  for (const message of event.messages) {
    messages.push(message)
    if (message.role !== "system") { count++; insert() }
  }
  return { messages }
}
