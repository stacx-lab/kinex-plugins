import { readFile } from "node:fs/promises"
import path from "node:path"
import type { CommandContext, CommandResult } from "@kinex/core/commands"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { mcpInteraction } from "./interaction.ts"
import { modelResult } from "./result.ts"
import { RuntimeSession } from "./session.ts"
import { ContextProjection, modelInstructions } from "./context.ts"
import type { AskForm, RuntimeOptions } from "./types.ts"
import { version } from "./version.ts"

export type { KinexComposition } from "./composition.ts"
export type { AskForm, Form, FormAnswer } from "./types.ts"
export interface KinexMcpOptions extends RuntimeOptions { interaction?: AskForm }
const empty = z.object({}).strict()
const discoveryInput = z.object({ tool: z.string().optional(), skill: z.string().optional(), workflow: z.string().optional(),
  arguments: z.string().default(""), context: z.union([z.literal("full"), z.array(z.string())]).optional() }).strict()
const callInput = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict()
const stopInput = z.object({ deviceID: z.string().optional(), reason: z.string().optional() }).strict()
const textResult = (value: object): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { ...value } })
export const lifecycleCommands = [
  { name: "start", description: "Start Kinex robotics", arguments: "", kind: "operation" },
  { name: "end", description: "End Kinex robotics", arguments: "", kind: "operation", interrupt: true },
  { name: "status", description: "Inspect Kinex lifecycle", arguments: "", kind: "operation" },
]

export async function createKinexMcpServer(options: KinexMcpOptions) {
  const directory = path.resolve(options.directory)
  const lifetime = new AbortController()
  const prose = await readFile(new URL("./instructions.txt", import.meta.url), "utf8")
  const server = new Server({ name: "kinex", version }, { capabilities: { tools: {} }, instructions: prose })
  const session = new RuntimeSession({ ...options, directory }, mcpInteraction(server, options.interaction))
  const projection = new ContextProjection()
  let connected = false, disposed: Promise<void> | undefined
  const definitions = [
    { name: "kinex_start", description: "Start Kinex only when the user requests activation. Restore configured loaded devices; approval may be required.", schema: empty },
    { name: "kinex_status", description: "Inspect Kinex lifecycle and recording status without activating robotics.", schema: empty, annotations: { readOnlyHint: true } },
    { name: "kinex_shutdown", description: "End Kinex robotics, cancel work, finalize recordings and release devices. The coding session stays open.", schema: empty },
    { name: "kinex_tools", description: "Discover active Kinex tools and skills. Summaries by default; use tool for a schema, skill or workflow for guidance, context=full or section names for live context. Refresh after resume/compaction.", schema: discoveryInput, annotations: { readOnlyHint: true } },
    { name: "kinex_call", description: "Call a Kinex tool with its current schema from kinex_tools. Core permissions apply. Denial/cancellation means wait for user direction.", schema: callInput },
    { name: "kinex_stop", description: "Immediately cancel robotics work and stop loaded actuators. Keeps Kinex active. Bypasses the Kinex queue and Kinex approval.", schema: stopInput },
  ]
  const status = async () => {
    const state = session.status(), bundle = session.state === "active" ? session.bundle : undefined
    return { ...state, versions: { mcp: version }, ...(bundle ? { recording: await bundle.runtime.recording.status() } : {}) }
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(({ schema, ...definition }) => ({
    ...definition, inputSchema: z.toJSONSchema(schema, { io: "input" }),
  })) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      lifetime.signal.throwIfAborted()
      const name = request.params.name, raw = request.params.arguments ?? {}
      const definition = definitions.find(item => item.name === name)
      if (!definition) throw new Error(`Unknown MCP tool: ${name}`)
      definition.schema.parse(raw)
      if (name === "kinex_status") return textResult(await status())
      if (name === "kinex_start") { await session.start(AbortSignal.any([extra.signal, lifetime.signal])); return textResult(await status()) }
      if (name === "kinex_shutdown") { projection.reset(); await session.shutdown(); return textResult(await status()) }
      const input = name === "kinex_call" ? callInput.parse(raw) : undefined
      const urgent = name === "kinex_stop" || input?.name === "device_stop"
      const stop = name === "kinex_stop" ? stopInput.parse(raw) : input?.name === "device_stop" ? stopInput.parse(input.arguments) : undefined
      if (urgent) {
        projection.reset()
        if (session.state === "starting") { await session.shutdown(); return textResult(await status()) }
        if (session.state === "inactive") return textResult(await status())
      }
      return await session.run(extra.signal, urgent, async (bundle, invocation) => {
        const { capabilities, sessionID } = bundle
        if (name === "kinex_tools") {
          const query = discoveryInput.parse(raw)
          if ([query.tool, query.skill, query.workflow].filter(Boolean).length > 1) throw new Error("Choose one of tool, skill or workflow")
          if (query.tool) {
            const catalog = await capabilities.tools.list()
            const tool = catalog.tools.find(tool => tool.name === query.tool)
            if (!tool) throw new Error(`Unknown Kinex tool: ${query.tool}`)
            return textResult({ tool, problems: catalog.problems })
          }
          if (query.skill) {
            const skill = await capabilities.skills.load(query.skill)
            if (!skill) throw new Error(`Unknown Kinex skill: ${query.skill}`)
            return textResult({ skill: { ...skill, content: modelInstructions(skill.content, capabilities) } })
          }
          if (query.workflow) {
            const command = capabilities.commands.find(command => command.name === query.workflow && command.kind === "workflow")
            if (!command) throw new Error(`Unknown Kinex workflow: ${query.workflow}`)
            const result = await command.execute(query.arguments, { sessionID, signal: invocation.abort, confirm: async () => false })
            if (result.kind !== "workflow") throw new Error("Workflow did not return a prompt")
            return textResult({ workflow: modelInstructions(result.prompt, capabilities) })
          }
          if (query.context) return textResult({ context: await projection.read(capabilities, sessionID, invocation.abort, true,
            Array.isArray(query.context) ? query.context : undefined) })
          const catalog = await capabilities.tools.list()
          const context = await capabilities.context()
          return textResult({ tools: catalog.tools.map(({ name, description }) => ({ name, description: description.split("\n")[0]?.slice(0, 240) ?? "" })), problems: catalog.problems,
            skills: await capabilities.skills.list(), workflows: capabilities.commands.filter(command => command.kind === "workflow")
              .map(({ name, description, arguments: args }) => ({ name, description, arguments: args })), contextSections: Object.keys(context.sections) })
        }
        const result = await capabilities.tools.call(input?.name ?? "device_stop", input?.arguments ?? stop, { ...invocation, callID: String(extra.requestId) })
        const response = await modelResult(result)
        try {
          const update = await projection.read(capabilities, sessionID, invocation.abort)
          if (Object.keys(update.sections).length) response.content.push({ type: "text", text: JSON.stringify({ context: update }) })
        } catch (error) {
          invocation.abort.throwIfAborted(); projection.reset()
          response.content.push({ type: "text", text: `Tool execution finished, but context refresh failed: ${String(error)}. Do not repeat the operation; use kinex_tools with context=full.` })
        }
        return response
      })
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }] }
    }
  })
  const dispose = () => disposed ??= (async () => {
    lifetime.abort(new Error("Kinex MCP disposed")); projection.reset()
    try { await session.shutdown() } finally { await server.close() }
  })()
  return {
    server, status, get runtime() { return session.bundle?.runtime }, get capabilities() { return session.bundle?.capabilities },
    get sessionID() { return session.bundle?.sessionID },
    commands() { return [...lifecycleCommands, ...(session.bundle?.capabilities.commands ?? [])].map(({ name, description, arguments: args, kind }) => ({ name, description, arguments: args, kind })) },
    async connect(transport: Transport) {
      lifetime.signal.throwIfAborted()
      if (connected) throw new Error("Kinex MCP already connected")
      connected = true
      server.onclose = () => { void dispose().catch(error => options.diagnostic?.(String(error))) }
      server.onerror = error => options.diagnostic?.(String(error))
      try { await server.connect(transport) } catch (error) { await dispose(); throw error }
    },
    async command(name: string, args: string, input: Pick<CommandContext, "confirm" | "notify" | "signal">): Promise<CommandResult> {
      lifetime.signal.throwIfAborted()
      const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])])
      if (["start", "end", "status"].includes(name)) {
        if (args.trim()) throw new Error(`${name} takes no arguments`)
        if (name === "start") await session.start(signal, true)
        if (name === "end") { projection.reset(); await session.shutdown() }
        return { kind: "output", text: JSON.stringify(await status()) }
      }
      const command = session.bundle?.capabilities.commands.find(command => command.name === name)
      if (!command) throw new Error(`Kinex is ${session.state} or command is unknown: ${name}`)
      return session.run(signal, command.interrupt === true, (bundle, invocation) => command.execute(args, { ...input, sessionID: bundle.sessionID, signal: invocation.abort }))
    },
    dispose,
  }
}
export type KinexMcpServer = Awaited<ReturnType<typeof createKinexMcpServer>>
