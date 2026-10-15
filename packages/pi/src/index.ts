import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { realpath } from "node:fs/promises"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { serveInteraction, type FormAnswer } from "@kinex/mcp/interaction"
import { endpoints, requestCommand } from "@kinex/mcp/control"

export default function kinex(pi: ExtensionAPI) {
  let bridge: Awaited<ReturnType<typeof serveInteraction>> | undefined
  let instance: string | undefined
  let lifetime = new AbortController()
  let current: ExtensionContext | undefined
  let directory: string | undefined
  let dialogs: Promise<unknown> = Promise.resolve()
  pi.registerFlag("kinex-recording", { description: "Enable model access to Kinex recording after Start Kinex", type: "boolean", default: false })
  pi.registerFlag("kinex-permission-mode", { description: "Default approvals: host (Pi's tool pipeline) or kinex (Kinex dialogs)", type: "string", default: "host" })
  const dispose = async () => {
    current = undefined; instance = undefined; directory = undefined
    lifetime.abort(new Error("Pi session ended"))
    await bridge?.dispose(); bridge = undefined
  }
  pi.on("session_start", async (_event, ctx) => {
    await dispose()
    const permissionMode = pi.getFlag("kinex-permission-mode") ?? "host"
    if (permissionMode !== "host" && permissionMode !== "kinex") throw new Error("--kinex-permission-mode must be host or kinex")
    lifetime = new AbortController(); dialogs = Promise.resolve(); current = ctx
    directory = await realpath(ctx.cwd); instance = randomUUID()
    const owner = lifetime
    bridge = await serveInteraction((form, signal) => {
      const abort = AbortSignal.any([signal, owner.signal])
      const task = dialogs.then(async (): Promise<FormAnswer> => {
        abort.throwIfAborted()
        if (current !== ctx || !ctx.hasUI) return undefined
        const answer: Record<string, boolean | string> = {}
        for (const [key, field] of Object.entries(form.properties)) {
          const title = `${form.message}\n${field.title}`
          if (field.type === "boolean") {
            const choice = await ctx.ui.select(title, ["Yes", "No", "Cancel"], { signal: abort })
            abort.throwIfAborted()
            if (!choice || choice === "Cancel") return undefined
            answer[key] = choice === "Yes"
          } else {
            const value = await ctx.ui.input(title, undefined, { signal: abort })
            abort.throwIfAborted()
            if (value === undefined) return undefined
            answer[key] = value
          }
        }
        return answer
      })
      dialogs = task.catch(() => {})
      return task
    })
    pi.registerMcpServer("kinex", { command: "node", args: [fileURLToPath(import.meta.resolve("@kinex/mcp/cli")), "serve", "--directory", directory, "--permission-mode", permissionMode,
      ...(pi.getFlag("kinex-recording") === true ? ["--enable-recording"] : [])], exposure: "direct", timeout: 300,
      description: "Kinex robotics: explicit start/end, devices, Python, onboarding and calibration",
      env: { KINEX_INTERACTION_SOCKET: bridge.socketPath, KINEX_INTERACTION_TOKEN: bridge.token, KINEX_INSTANCE_ID: instance } })
  })
  pi.on("session_shutdown", dispose)
  for (const [name, command] of [["kinex-start", "start"], ["kinex-end", "end"], ["kinex-status", "status"]] as const) {
    pi.registerCommand(name, { description: `${command} Kinex robotics`, handler: async (args, ctx) => {
      if (args.trim()) throw new Error(`${name} takes no arguments`)
      if (!directory || !instance) throw new Error("Kinex session is not initialized")
      const endpoint = (await endpoints(directory)).find(endpoint => endpoint.instance === instance)
      if (!endpoint) throw new Error("Kinex MCP is not connected. Check /mcp; a configured kinex server overrides this plugin's server.")
      const result = await requestCommand(endpoint, { method: "execute", directory, command, args: "" }, {
        signal: lifetime.signal, confirm: async (title, description) => ctx.hasUI && await ctx.ui.confirm(title, description),
      })
      pi.sendMessage({ customType: "kinex", content: JSON.stringify(result), display: true }, { triggerTurn: false })
    } })
  }
}
