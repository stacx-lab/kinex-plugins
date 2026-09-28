import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Hooks } from "@opencode-ai/plugin"
import type { KinexCapabilities } from "@kinex/core/integration"
import { ConfigPaths } from "@kinex/core/config/paths"

type Messages = Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]["messages"]
const updateSchema = z.object({ anchor: z.string(), id: z.string(), timestamp: z.number(), snapshot: z.string(), content: z.string() })
const ledgerSchema = z.object({ epoch: z.string(), updates: z.array(updateSchema) })

/** Projection state is adapter-owned. No synthetic user prompts or extra runs are
 * sent to the host; anchors keep updates in the same position after a restart. */
export async function projectContext(directory: string, messages: Messages, capabilities: KinexCapabilities) {
  const lastUser = messages.findLast(message => message.info.role === "user")
  const last = messages.at(-1)
  if (!lastUser || lastUser.info.role !== "user" || !last) return
  const user = lastUser.info
  const sessionID = lastUser.info.sessionID
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionID)) throw new Error("Invalid session ID")
  const root = path.join(await ConfigPaths.projectDir(directory), "agent", "opencode", "context")
  const file = path.join(root, `${sessionID}.json`)
  const epoch = messages.findLast(message => message.info.role === "assistant" && message.info.summary)?.info.id ?? "initial"
  const json = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
  const previous = json ? ledgerSchema.parse(JSON.parse(json)) : undefined
  const ids = new Set(messages.map(message => message.info.id))
  const updates = previous?.epoch === epoch ? previous.updates.filter(update => ids.has(update.anchor)) : []
  const [context, catalog, skills] = await Promise.all([capabilities.context(), capabilities.tools.list(), capabilities.skills.list()])
  const sections = { ...context.sections, "kinex.tools": JSON.stringify(catalog.tools), "kinex.skills": JSON.stringify(skills), "kinex.problems": catalog.problems.join("\n") }
  const snapshot = JSON.stringify(sections)
  if (updates.at(-1)?.snapshot !== snapshot) {
    updates.push({
      anchor: last.info.id, id: `msg_kinex_${randomUUID().replaceAll("-", "")}`, timestamp: Date.now(), snapshot,
      content: `<kinex_context>\n${Object.entries(sections).map(([key, value]) => `${key}:\n${value || "(none)"}`).join("\n\n")}\n</kinex_context>`,
    })
    await mkdir(root, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ epoch, updates }), { mode: 0o600 })
    await rename(temporary, file)
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const anchor = messages[index]?.info.id
    const additions: Messages = updates.filter(update => update.anchor === anchor).map(update => ({
      info: { role: "user", sessionID, agent: user.agent, model: user.model, id: update.id, time: { created: update.timestamp } },
      parts: [{ id: `prt_${update.id}`, messageID: update.id, sessionID, type: "text", text: update.content, synthetic: true }],
    }))
    messages.splice(index + 1, 0, ...additions)
  }
}
