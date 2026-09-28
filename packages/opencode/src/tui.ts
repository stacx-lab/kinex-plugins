import { z } from "zod"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { endpoints, requestCommand, type Endpoint } from "./ipc.ts"

const descriptionSchema = z.object({ commands: z.array(z.object({ name: z.string(), description: z.string(), arguments: z.string(), kind: z.enum(["operation", "workflow"]), choices: z.array(z.string()).optional() })) })
const resultSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("workflow"), prompt: z.string() }), z.object({ kind: z.literal("output"), text: z.string(), isError: z.boolean().optional() })])

function dialogs(api: TuiPluginApi) {
  function show<T>(render: (finish: (value: T | undefined) => void) => ReturnType<TuiPluginApi["ui"]["Dialog"]>): Promise<T | undefined> {
    return new Promise(resolve => {
      let done = false
      const finish = (value: T | undefined) => {
        if (done) return
        done = true; api.lifecycle.signal.removeEventListener("abort", cancel)
        resolve(value); api.ui.dialog.clear()
      }
      const cancel = () => finish(undefined)
      if (api.lifecycle.signal.aborted) { cancel(); return }
      api.lifecycle.signal.addEventListener("abort", cancel, { once: true })
      api.ui.dialog.replace(() => render(finish), cancel)
    })
  }
  return {
    select: (title: string, choices: string[]) => show<string>(finish => api.ui.DialogSelect({ title, options: choices.map(value => ({ title: value, value })), onSelect: option => finish(option.value) })),
    input: (title: string, placeholder: string) => show<string>(finish => api.ui.DialogPrompt({ title, placeholder, onConfirm: value => finish(value), onCancel: () => finish(undefined) })),
    confirm: async (title: string, message: string) => (await show<boolean>(finish => api.ui.DialogConfirm({ title, message, onConfirm: () => finish(true), onCancel: () => finish(false) }))) === true,
  }
}

export const tui: TuiPlugin = async api => {
  const ui = dialogs(api)
  let endpoint: Endpoint | undefined
  let unregister: (() => void) | undefined
  const connection = { signal: api.lifecycle.signal, confirm: ui.confirm }
  const cwd = async () => {
    const { data } = await api.client.path.get(undefined, { throwOnError: true })
    if (!data) throw new Error("OpenCode directory is unavailable")
    return data.directory
  }
  const connect = async () => {
    const directory = await cwd()
    const candidates = await endpoints(directory)
    if (!candidates.length) throw new Error("No local Kinex server. Enable the server plugin in this OpenCode instance. Remote attach is not supported.")
    const selected = candidates.length === 1 ? candidates[0]?.instance : await ui.select("Choose local Kinex instance", candidates.map(candidate => candidate.instance))
    endpoint = candidates.find(candidate => candidate.instance === selected)
    if (!endpoint) return
    const description = descriptionSchema.parse(await requestCommand(endpoint, { method: "describe", directory, sessionID: "", args: "" }, connection))
    unregister?.()
    const existing = new Set(api.keymap.getCommands({ visibility: "registered" }).map(command => command.slashName).filter(value => typeof value === "string"))
    unregister = api.keymap.registerLayer({
      commands: description.commands.flatMap(command => {
        const run = async () => {
          try {
            if (!endpoint || endpoint.directory !== await cwd()) throw new Error("Workspace changed; use /kinex-connect")
            // Re-read choices; device profiles may have changed since installation.
            const fresh = descriptionSchema.parse(await requestCommand(endpoint, { method: "describe", directory: endpoint.directory, sessionID: "", args: "" }, connection))
            const latest = fresh.commands.find(item => item.name === command.name)
            if (!latest) throw new Error(`Command is no longer available: ${command.name}`)
            const args = latest.choices?.length ? await ui.select(`Kinex: ${command.name}`, latest.choices)
              : latest.arguments ? await ui.input(`Kinex: ${command.name}`, latest.arguments) : ""
            if (args === undefined) return
            const route = api.route.current
            const candidate: unknown = "params" in route ? route.params?.sessionID : undefined
            let sessionID = typeof candidate === "string" ? candidate : undefined
            if (!sessionID) {
              const { data } = await api.client.session.create({ directory: endpoint.directory }, { throwOnError: true })
              if (!data) throw new Error("Unable to create an OpenCode session")
              sessionID = data.id; api.route.navigate("session", { sessionID })
            }
            const result = resultSchema.parse(await requestCommand(endpoint, { method: "execute", directory: endpoint.directory, sessionID, command: command.name, args }, connection))
            if (result.kind === "workflow") {
              await api.client.session.promptAsync({ sessionID, directory: endpoint.directory, parts: [{ type: "text", text: result.prompt }] }, { throwOnError: true })
            } else api.ui.dialog.replace(() => api.ui.DialogAlert({ title: `Kinex: ${command.name}`, message: result.text, onConfirm: () => api.ui.dialog.clear() }))
          } catch (error) { api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) }) }
        }
        const alias = `kinex-${command.name}`
        if (existing.has(alias)) throw new Error(`Kinex command conflicts with /${alias}`)
        return [alias, ...(!existing.has(command.name) ? [command.name] : [])].map(slashName => ({
          name: `kinex.${slashName}`, title: `Kinex: ${command.description}`, category: "Kinex", namespace: "palette", slashName, run,
        }))
      }),
    })
    api.ui.toast({ variant: "success", message: "Kinex connected", duration: 2000 })
  }
  const unregisterConnect = api.keymap.registerLayer({ commands: [{
    name: "kinex.connect", title: "Connect Kinex", category: "Kinex", namespace: "palette", slashName: "kinex-connect",
    run: async () => { try { await connect() } catch (error) { api.ui.toast({ variant: "error", message: String(error) }) } },
  }] })
  api.lifecycle.onDispose(() => { unregister?.(); unregisterConnect() })
  try { await connect() } catch (error) { api.ui.toast({ variant: "warning", message: `${String(error)} Use /kinex-connect to retry.` }) }
}

const plugin: TuiPluginModule = { id: "kinex", tui }
export default plugin
