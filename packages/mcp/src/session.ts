import type { Context } from "@kinex/core"
import type { AskForm, RuntimeBundle, RuntimeOptions } from "./types.ts"

export type RuntimeState = "inactive" | "starting" | "active" | "stopping"
export class RuntimeSession {
  state: RuntimeState = "inactive"
  bundle?: RuntimeBundle
  error?: string
  private starting?: Promise<void>
  private stopping?: Promise<void>
  private lifetime = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()
  private generation = 0
  private pending = new Set<Promise<unknown>>()
  private controllers = new Set<AbortController>()
  constructor(readonly options: RuntimeOptions, private readonly form: AskForm) {}

  status() {
    return { state: this.state, directory: this.options.directory, permissionMode: this.options.permissionMode ?? "kinex", sessionID: this.bundle?.sessionID,
      activationFailures: this.bundle?.failures ?? [], ...(this.error ? { error: this.error } : {}) }
  }
  start(signal: AbortSignal, trusted = false): Promise<void> {
    signal.throwIfAborted()
    if (this.state === "active") return Promise.resolve()
    if (this.starting && this.state === "starting") return this.starting
    if (this.state !== "inactive") return Promise.reject(new Error(`Kinex is ${this.state}; cannot start`))
    this.state = "starting"; this.error = undefined; this.lifetime = new AbortController()
    const abort = AbortSignal.any([signal, this.lifetime.signal])
    const task = (async () => {
      let bundle: RuntimeBundle | undefined
      try {
        const adapter = await import("./kinex.ts")
        abort.throwIfAborted()
        if (!trusted) await adapter.authorizeStart(this.options, this.form, abort)
        abort.throwIfAborted()
        bundle = this.bundle = adapter.createRuntime(this.options, this.form)
        await bundle.activate(abort)
        abort.throwIfAborted()
        this.state = "active"
      } catch (error) {
        this.error = String(error)
        if (bundle) {
          // Disposal is memoized, so a concurrent shutdown observes the same cleanup result.
          try { await bundle.dispose() }
          catch (cleanup) { this.error = `${String(error)}; cleanup: ${String(cleanup)}` }
          finally { if (this.bundle === bundle) this.bundle = undefined }
        }
        if (this.state !== "stopping") this.state = "inactive"
        throw error
      }
    })()
    this.starting = task
    void task.finally(() => { if (this.starting === task) this.starting = undefined }).catch(() => {})
    return task
  }
  interrupt() {
    this.generation++
    for (const controller of this.controllers) controller.abort(new Error("Kinex operation cancelled"))
  }
  run<T>(signal: AbortSignal, urgent: boolean, action: (bundle: RuntimeBundle, context: Context) => Promise<T>): Promise<T> {
    if (this.state !== "active" || !this.bundle) return Promise.reject(new Error(`Kinex is ${this.state}. Ask the user to invoke Start Kinex.`))
    if (urgent) this.interrupt()
    const epoch = this.generation, bundle = this.bundle
    const controller = new AbortController()
    const abort = AbortSignal.any([signal, this.lifetime.signal, controller.signal])
    const invalidate = () => { if (epoch === this.generation) this.generation++ }
    abort.addEventListener("abort", invalidate, { once: true })
    const execute = async () => {
      abort.throwIfAborted()
      if (epoch !== this.generation) throw new Error("Kinex queued operation cancelled; wait for user direction")
      this.controllers.add(controller)
      try {
        const result = await bundle.invoke(abort, context => action(bundle, context))
        abort.throwIfAborted()
        return result
      } catch (error) {
        if (abort.aborted || (error instanceof Error && ["PermissionDeniedError", "QuestionDeclinedError"].includes(error.name))) invalidate()
        throw error
      } finally { this.controllers.delete(controller) }
    }
    const task = urgent ? execute() : this.queue.then(execute)
    this.queue = urgent ? Promise.allSettled([this.queue, task]) : task.catch(() => {})
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task); abort.removeEventListener("abort", invalidate) }).catch(() => {})
    return task
  }
  shutdown(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.state === "inactive") return Promise.resolve()
    this.state = "stopping"
    this.lifetime.abort(new Error("Kinex runtime ended")); this.interrupt()
    const bundle = this.bundle
    const task = (async () => {
      const [cleanup] = await Promise.allSettled([bundle?.dispose(), this.starting?.catch(() => {}), ...this.pending])
      if (this.bundle === bundle) this.bundle = undefined
      this.state = "inactive"; this.queue = Promise.resolve()
      // Core terminates its hosts and owned processes even when disposal reports a failure, so restart stays safe.
      if (cleanup?.status === "rejected") {
        this.error = `Kinex cleanup failed: ${String(cleanup.reason)}`
        throw new Error(this.error, { cause: cleanup.reason })
      }
    })()
    this.stopping = task
    void task.finally(() => { this.stopping = undefined }).catch(() => {})
    return task
  }
}
