import { realpath } from "node:fs/promises"
import { parseArgs } from "node:util"
import { createInterface } from "node:readline/promises"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { version } from "./version.ts"
import { createKinexMcpServer } from "./index.ts"
import { remoteForm } from "./bridge.ts"
import { endpoints, requestCommand, serveCommands } from "./ipc.ts"

const commandResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow"), prompt: z.string() }),
  z.object({ kind: z.literal("output"), text: z.string(), isError: z.boolean().optional() }),
])

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    directory: { type: "string" }, instance: { type: "string" },
    "permission-mode": { type: "string" },
    "enable-recording": { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  } })
  if (values.version) { console.log(version); return }
  if (values.help || !positionals.length) {
    console.log("kinex-mcp serve [--directory PATH] [--enable-recording] [--permission-mode kinex|host]\nkinex-mcp control --directory PATH [--instance ID] <command> [arguments]\nkinex-mcp control --directory PATH [--instance ID] --help\n\nPermission mode defaults to kinex; host delegates default approvals to the host tool pipeline.\nControl commands execute on the existing Kinex server, without a model.\nUse 'control ... commands' to list Core commands, or 'control ... instances' to select a server.")
    return
  }
  const [mode, command, ...rest] = positionals
  const directory = await realpath(values.directory ?? process.env.KINEX_WORKSPACE ?? process.cwd())
  if (mode === "control") {
    if (values["enable-recording"]) throw new Error("--enable-recording is a serve option")
    if (values["permission-mode"] !== undefined) throw new Error("--permission-mode is a serve option")
    if (!command) throw new Error("control requires a command; use commands or instances")
    const found = await endpoints(directory)
    if (command === "instances") { console.log(JSON.stringify(found, null, 2)); return }
    const selected = values.instance ? found.find(item => item.instance === values.instance) : found.length === 1 ? found[0] : undefined
    if (!selected) throw new Error(found.length > 1 ? "Multiple Kinex servers; run control instances and select --instance ID" : "No matching Kinex server. Open your host with the Kinex plugin first.")
    const abort = new AbortController()
    const cancel = () => abort.abort(new Error("Control interrupted"))
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    try {
      const result = await requestCommand(selected, { method: command === "commands" ? "describe" : "execute", directory, command, args: rest.join(" ") }, {
        signal: abort.signal,
        async confirm(title, description) {
          if (!process.stdin.isTTY || !process.stdout.isTTY) return false
          const readline = createInterface({ input: process.stdin, output: process.stdout })
          try { return (await readline.question(`${title}\n${description}\nType yes to confirm: `, { signal: abort.signal })).trim() === "yes" }
          finally { readline.close() }
        },
      })
      if (command === "commands") { console.log(JSON.stringify(result, null, 2)); return }
      const parsed = commandResult.parse(result)
      console.log(parsed.kind === "workflow" ? parsed.prompt : parsed.text)
      if (parsed.kind === "output" && parsed.isError) process.exitCode = 1
    } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel) }
    return
  }
  if (mode !== "serve" || command || values.instance) throw new Error("Usage: kinex-mcp serve [--directory PATH] [--enable-recording]")
  const permissionMode = z.enum(["kinex", "host"]).parse(values["permission-mode"] ?? "kinex")
  const adapter = await createKinexMcpServer({ directory, permissionMode, enableRecording: values["enable-recording"], diagnostic: message => console.error(message), interaction: process.env.KINEX_INTERACTION_SOCKET && process.env.KINEX_INTERACTION_TOKEN ? remoteForm(process.env.KINEX_INTERACTION_SOCKET, process.env.KINEX_INTERACTION_TOKEN) : undefined })
  let shutdown!: () => void
  const stopped = new Promise<void>(resolve => { shutdown = resolve })
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  process.stdin.once("end", shutdown)
  let ipc: Awaited<ReturnType<typeof serveCommands>> | undefined
  try {
    ipc = await serveCommands(directory, async (request, connection) => {
      if (request.method === "describe") return adapter.commands()
      if (!request.command) throw new Error("Command required")
      return adapter.command(request.command, request.args, connection)
    }, process.env.KINEX_INSTANCE_ID)
    await adapter.connect(new StdioServerTransport())
    const onclose = adapter.server.onclose
    adapter.server.onclose = () => { onclose?.(); shutdown() }
    if (process.stdin.readableEnded) shutdown()
    await stopped
  } finally {
    process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); process.stdin.off("end", shutdown)
    const results = await Promise.allSettled([adapter.dispose(), ipc?.dispose()])
    for (const result of results) if (result.status === "rejected") console.error(String(result.reason))
    if (results.some(result => result.status === "rejected")) process.exitCode = 1
  }
}
