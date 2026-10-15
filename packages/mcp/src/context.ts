import type { KinexCapabilities } from "@kinex/core/integration"

// Only adapt commands supplied by contributions. Never direct model calls to the trusted CLI.
export function modelInstructions(text: string, capabilities: KinexCapabilities) {
  const commands = new Map(capabilities.commands.map(command => [command.name, command]))
  return text.replace(/(?<![\w/.-])\/([a-z][\w-]*)(?![\w/-])/g, (match, name: string) => {
    const command = commands.get(name)
    if (!command) return match
    return command.kind === "workflow" ? `kinex_tools(workflow=${JSON.stringify(name)})`
      : `${name} (use the corresponding permission-checked Kinex tool discovered with kinex_tools; direct commands are user-only)`
  })
}
export class ContextProjection {
  private previous: Record<string, string> = {}
  private sessionID?: string
  reset() { this.previous = {}; this.sessionID = undefined }
  async read(capabilities: KinexCapabilities, sessionID: string, signal: AbortSignal, full = false, selected?: string[]) {
    const current = await capabilities.context()
    signal.throwIfAborted()
    if (this.sessionID !== sessionID) { this.previous = {}; this.sessionID = sessionID; full = true }
    const keys = selected ?? [...new Set([...Object.keys(this.previous), ...Object.keys(current.sections)])]
    const sections = Object.fromEntries(keys.filter(key => full || selected || this.previous[key] !== current.sections[key])
      .map(key => [key, current.sections[key] ?? ""]))
    for (const key of Object.keys(sections)) this.previous[key] = current.sections[key] ?? ""
    return { ...(full && !selected ? { instructions: modelInstructions(current.instructions, capabilities) } : {}), sections }
  }
}
