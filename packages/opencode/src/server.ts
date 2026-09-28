import { readFile } from "node:fs/promises"
import { tool, type Plugin, type PluginModule, type ToolResult } from "@opencode-ai/plugin"
import type { Result } from "@kinex/core"
import { OpenCodeOwner, type OpenCodeOptions } from "./owner.ts"
import { serveCommands } from "./ipc.ts"
import { projectContext } from "./context.ts"
import { onShutdown } from "./shutdown.ts"

async function resultForHost(result: Result, signal: AbortSignal): Promise<ToolResult> {
  const attachments = await Promise.all((result.attachments ?? []).map(async attachment => ({
    type: "file" as const, mime: attachment.mime,
    url: `data:${attachment.mime};base64,${(await readFile(attachment.path, { signal })).toString("base64")}`,
  })))
  return { title: result.title, output: result.output, metadata: { ...result.metadata, kinex: { isError: result.isError ?? false } }, attachments }
}

export function createOpenCodePlugin(options: OpenCodeOptions = {}): Plugin {
  return async (input, config) => {
    const owner = new OpenCodeOwner(input, { ...options, enableRecording: config?.enableRecording === true || options.enableRecording === true })
    let ipc: Awaited<ReturnType<typeof serveCommands>> | undefined
    const instructions = await readFile(new URL("./instructions.txt", import.meta.url), "utf8")
    let disposed: Promise<void> | undefined
    let removeShutdown: (() => void) | undefined
    const dispose = () => disposed ??= (async () => {
      removeShutdown?.()
      // Abort operations before waiting for IPC handlers that own them.
      await Promise.all([owner.dispose(), ipc?.dispose()])
    })()
    try {
      await owner.capabilities.tools.list()
      await owner.capabilities.skills.list()
      await owner.initialize()
      ipc = await serveCommands(input.directory, async (request, connection) => {
        if (request.method === "describe") return {
          commands: await Promise.all(owner.capabilities.commands.map(async command => ({
            name: command.name, description: command.description, arguments: command.arguments, kind: command.kind, choices: await command.choices?.(),
          }))),
          devices: await owner.runtime.devices.list(), recording: await owner.runtime.recording.status(),
        }
        await owner.validateSession(request.sessionID)
        const command = owner.capabilities.commands.find(command => command.name === request.command)
        if (!command) throw new Error(`Unknown command: ${request.command}`)
        if (command.interrupt) {
          owner.interrupt()
          await input.client.session.abort({ path: { id: request.sessionID }, query: { directory: input.directory } })
        }
        return owner.serial(request.sessionID, connection.signal, signal => command.execute(request.args, {
          sessionID: request.sessionID, signal,
          confirm: async (title, description) => {
            const accepted = await connection.confirm(title, description)
            signal.throwIfAborted()
            return accepted
          },
        }), command.interrupt, true)
      })
      removeShutdown = onShutdown(dispose)
    } catch (error) { await dispose(); throw error }
    return {
      dispose,
      tool: {
        kinex_tools: tool({
          description: "Discover the current Kinex tools and input schemas, or load a Kinex skill. Refresh after creating tools or skills; new definitions are immediately callable through kinex_call.",
          args: { name: tool.schema.string().optional(), skill: tool.schema.string().optional() },
          async execute(args, ctx) {
            ctx.abort.throwIfAborted()
            if (args.skill) {
              const skill = await owner.capabilities.skills.load(args.skill)
              if (!skill) throw new Error(`Unknown Kinex skill: ${args.skill}`)
              return { title: `Kinex skill: ${args.skill}`, output: `${skill.content}\n\nBase directory: ${skill.info.directory}` }
            }
            const catalog = await owner.capabilities.tools.list()
            return JSON.stringify({ ...catalog, tools: args.name ? catalog.tools.filter(tool => tool.name === args.name) : catalog.tools, skills: await owner.capabilities.skills.list() })
          },
        }),
        kinex_call: tool({
          description: "Call a Kinex tool using the current schema from kinex_tools. Device access remains permission checked. This cannot execute trusted user commands.",
          args: { name: tool.schema.string(), arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()) },
          async execute(args, ctx) { return resultForHost(await owner.call(args.name, args.arguments, ctx), ctx.abort) },
        }),
      },
      "chat.message": async ({ sessionID }) => { owner.reset(sessionID) },
      "experimental.chat.system.transform": async (_input, output) => {
        output.system.push(`${instructions}\n\n${(await owner.capabilities.context()).instructions}`)
      },
      "experimental.chat.messages.transform": async (_input, output) => {
        const sessionID = output.messages.at(-1)?.info.sessionID
        if (!sessionID) return
        try { await projectContext(input.directory, output.messages, owner.capabilities) }
        catch (error) {
          owner.block(sessionID, error instanceof Error ? error : new Error(String(error)))
          throw error
        }
      },
      "experimental.session.compacting": async (_input, output) => {
        const context = await owner.capabilities.context()
        output.context.push(`Retain robotics goals, device activation intent, calibration blockers and recording ownership. Runtime state will be refreshed before continuation.\n${JSON.stringify(context.sections)}`)
      },
      event: async ({ event }) => {
        if (event.type === "session.deleted") await owner.leave(event.properties.info.id)
        if (event.type === "session.error") owner.interrupt(event.properties.sessionID)
        if (event.type === "message.updated") {
          const info = event.properties.info
          owner.observe(info.sessionID, info.id, info.role === "assistant" && !!info.time.completed)
        }
      },
    }
  }
}

const plugin: PluginModule = { id: "kinex", server: createOpenCodePlugin() }
export default plugin
