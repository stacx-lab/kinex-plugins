import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { createKinexRuntime, loadPermissionRules, kinexPermissionAction, PermissionDeniedError, QuestionDeclinedError, type KinexRuntime } from "@kinex/core"
import { composeContributions, coreContribution, type KinexContribution } from "@kinex/core/integration"

export interface OpenCodeOptions {
  enableRecording?: boolean
  contributions?(runtime: KinexRuntime): readonly KinexContribution[]
}

export class OpenCodeOwner {
  readonly runtime: KinexRuntime
  readonly capabilities
  readonly lifetime = new AbortController()
  private calls = new AsyncLocalStorage<ToolContext>()
  private queue: Promise<unknown> = Promise.resolve()
  private ready?: Promise<void>
  private disposed?: Promise<void>
  private blocked = new Map<string, Error>()
  private recordingSession?: string
  private observed = new Set<string>()
  private controllers = new Map<AbortController, string>()

  constructor(readonly input: PluginInput, options: OpenCodeOptions) {
    this.runtime = createKinexRuntime({ directory: input.directory, enableRecording: options.enableRecording, host: {
      ask: async request => {
        const ctx = this.calls.getStore()
        if (!ctx) throw new PermissionDeniedError(request.permission)
        ctx.abort.throwIfAborted()
        if (request.permission === "device_stop") return
        const action = kinexPermissionAction(request.permission, await loadPermissionRules(ctx.directory))
        if (action === "deny") throw new PermissionDeniedError(request.permission)
        try {
          await ctx.ask({ permission: request.permission, patterns: [request.permission], always: [request.permission], metadata: { ...request.metadata, description: request.description } })
          ctx.abort.throwIfAborted()
        } catch { throw new PermissionDeniedError(request.permission) }
      },
      questions: async () => { throw new QuestionDeclinedError() },
      exportTrace: async (sessionID, range) => {
        const { data } = await input.client.session.messages({ path: { id: sessionID }, query: { directory: input.directory }, throwOnError: true })
        const messages = data ?? []
        const first = range.first ? messages.findIndex(message => message.info.id === range.first) : 0
        const last = range.last ? messages.findIndex(message => message.info.id === range.last) : messages.length - 1
        return { sessionID, messages: messages.slice(Math.max(0, first), last < 0 ? undefined : last + 1).map(message => ({
          id: message.info.id, role: message.info.role,
          content: message.parts.flatMap<unknown>(part => {
            if (part.type === "text") return [{ type: "text", text: part.text }]
            if (part.type === "tool") return [{ type: "toolCall", id: part.callID, name: part.tool, arguments: part.state.input,
              ...("output" in part.state ? { output: part.state.output } : {}), ...("error" in part.state ? { error: part.state.error } : {}),
            }]
            if (part.type === "file") return [{ type: "file", mime: part.mime, omitted: true }]
            return []
          }),
        })) }
      },
    } })
    try { this.capabilities = composeContributions(options.contributions?.(this.runtime) ?? [coreContribution(this.runtime)]) }
    catch (error) { void this.runtime.dispose(); throw error }
  }

  initialize(): Promise<void> {
    return this.ready ??= (async () => {
      for (const activation of await this.runtime.devices.warmLoaded()) void activation.ready.catch(error => this.log(String(error)))
    })()
  }

  async validateSession(sessionID: string) {
    const { data } = await this.input.client.session.get({ path: { id: sessionID }, query: { directory: this.input.directory }, throwOnError: true })
    if (!data || path.resolve(data.directory) !== path.resolve(this.input.directory)) throw new Error("Kinex session belongs to another workspace")
  }

  reset(sessionID: string) { this.blocked.delete(sessionID) }
  block(sessionID: string, error: Error) { this.blocked.set(sessionID, error) }
  check(sessionID: string) { const error = this.blocked.get(sessionID); if (error) throw error }

  interrupt(sessionID?: string) {
    for (const [controller, owner] of this.controllers) if (!sessionID || owner === sessionID) controller.abort(new Error("Kinex operation interrupted"))
  }

  async serial<T>(sessionID: string, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>, emergency = false, trusted = false): Promise<T> {
    const controller = new AbortController()
    this.controllers.set(controller, sessionID)
    const combined = AbortSignal.any([signal, controller.signal, this.lifetime.signal])
    const run = async () => {
      combined.throwIfAborted()
      if (!trusted && !emergency) this.check(sessionID)
      await this.initialize()
      const recording = await this.runtime.recording.status()
      if (!emergency && recording && this.recordingSession && this.recordingSession !== sessionID) throw new Error("Another session owns the active Kinex recording")
      try { return await action(combined) }
      finally {
        if (await this.runtime.recording.status()) this.recordingSession ??= sessionID
        else this.recordingSession = undefined
      }
    }
    const pending = emergency ? run() : this.queue.then(run)
    if (!emergency) this.queue = pending.catch(() => {})
    try { return await pending }
    finally { this.controllers.delete(controller) }
  }

  async call(name: string, args: unknown, ctx: ToolContext) {
    if (path.resolve(ctx.directory) !== path.resolve(this.input.directory)) throw new Error("Kinex tool workspace mismatch")
    const emergency = name === "device_stop"
    if (emergency) this.interrupt()
    return this.serial(ctx.sessionID, ctx.abort, signal => this.calls.run({ ...ctx, abort: signal }, async () => {
      try {
        const result = await this.capabilities.tools.call(name, args, {
          sessionID: ctx.sessionID, callID: randomUUID(), directory: ctx.directory, abort: signal,
          ask: async request => {
            const action = kinexPermissionAction(request.permission, await loadPermissionRules(ctx.directory))
            if (request.permission === "device_stop") return
            if (action === "deny") throw new PermissionDeniedError(request.permission)
            try { await ctx.ask({ permission: request.permission, patterns: [request.permission], always: [request.permission], metadata: { ...request.metadata, description: request.description } }) }
            catch { throw new PermissionDeniedError(request.permission) }
            signal.throwIfAborted()
          },
          questions: async () => { throw new QuestionDeclinedError() },
        })
        signal.throwIfAborted()
        return result
      } catch (error) {
        if (error instanceof PermissionDeniedError || error instanceof QuestionDeclinedError || signal.aborted) {
          this.block(ctx.sessionID, error instanceof Error ? error : new Error(String(error)))
          this.interrupt(ctx.sessionID)
          void this.input.client.session.abort({ path: { id: ctx.sessionID }, query: { directory: ctx.directory } }).catch(error => this.log(String(error)))
        }
        throw error
      }
    }), emergency)
  }

  observe(sessionID: string, id: string, completed: boolean) {
    const key = `${sessionID}:${id}:${completed}`
    if (this.observed.has(key)) return
    this.observed.add(key)
    this.runtime.observe({ type: "message", sessionID, id, completed })
  }

  async leave(sessionID: string) {
    this.interrupt(sessionID)
    await this.queue
    if (this.recordingSession === sessionID) { await this.runtime.recording.stop({ summary: "Chat session ended" }); this.recordingSession = undefined }
    this.blocked.delete(sessionID)
  }
  async log(message: string) {
    await this.input.client.app.log({ body: { service: "kinex", level: "warn", message } }).catch(() => {})
  }
  dispose(): Promise<void> {
    return this.disposed ??= (async () => {
      this.lifetime.abort(); this.interrupt()
      await this.runtime.dispose()
      await this.queue
      this.observed.clear()
    })()
  }
}
