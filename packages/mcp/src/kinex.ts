// The only runtime-value dependency boundary with Kinex. Loaded on explicit start.
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { createKinexRuntime, PermissionDeniedError, QuestionDeclinedError, kinexPermissionAction, loadPermissionRules,
  type Context, type PermissionAction } from "@kinex/core"
import { coreContribution, composeContributions } from "@kinex/core/integration"
import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames, setupPermissionDefaults } from "@kinex/setup"
import type { AskForm, Form, RuntimeBundle, RuntimeOptions } from "./types.ts"

export async function authorizeStart(options: RuntimeOptions, form: AskForm, signal: AbortSignal) {
  await permissions(options, form, signal).ask({ permission: "runtime_start",
    metadata: {}, description: `Start Kinex in ${options.directory} and restore configured loaded devices?` })
}

function permissions(options: RuntimeOptions, form: AskForm, signal: AbortSignal, defaults: Record<string, PermissionAction> = {}): Pick<Context, "ask" | "questions"> {
  return {
    async ask(request) {
      signal.throwIfAborted()
      // Core resolves explicit rules before these defaults and retains its stop exception.
      // Host mode is selected at startup, never by a model-supplied tool argument.
      const policy: Record<string, PermissionAction> = options.permissionMode === "host" ? { [request.permission]: "allow" } : defaults
      const action = kinexPermissionAction(request.permission, await loadPermissionRules(options.directory), policy)
      if (action === "allow") return
      if (action === "deny") throw new PermissionDeniedError(request.permission)
      const result = await form({ message: `${request.permission}: ${request.description}`,
        properties: { allow: { type: "boolean", title: "Allow this operation?" } }, required: ["allow"] }, signal)
      signal.throwIfAborted()
      if (result?.allow !== true) throw new PermissionDeniedError(request.permission)
    },
    async questions(questions) {
      const answers: Record<string, string> = {}
      for (const question of questions) {
        const properties: Form["properties"] = {}
        const required: string[] = []
        let message = `${question.header}: ${question.question}`
        if (question.multiple && question.options.length) {
          for (const [index, option] of question.options.entries()) {
            properties[`choice_${index}`] = { type: "boolean", title: `${option.label}${option.description ? ` — ${option.description}` : ""}` }
            required.push(`choice_${index}`)
          }
        } else {
          properties.answer = { type: "string", title: "Your answer" }; required.push("answer")
          message += question.options.map(option => `\n- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("")
        }
        const answer = await form({ message, properties, required }, signal)
        signal.throwIfAborted()
        if (!answer || required.some(key => typeof answer[key] !== properties[key]?.type)) throw new QuestionDeclinedError()
        answers[question.question] = question.multiple && question.options.length
          ? question.options.filter((_, index) => answer[`choice_${index}`] === true).map(option => option.label).join(", ") : String(answer.answer)
      }
      return answers
    },
  }
}

export function createRuntime(options: RuntimeOptions, form: AskForm): RuntimeBundle {
  const calls = new AsyncLocalStorage<Context>()
  const sessionID = randomUUID()
  const composition = options.composition ?? { builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames,
    contributions: (runtime: ReturnType<typeof createKinexRuntime>) => [coreContribution(runtime), setupContribution(createKinexSetup(runtime))] }
  const defaults = options.composition ? {} : setupPermissionDefaults
  const runtime = createKinexRuntime({ directory: options.directory, enableRecording: options.enableRecording,
    builtinSkillRoots: composition.builtinSkillRoots ?? [], reservedToolNames: composition.reservedToolNames ?? [], host: {
      ask: request => calls.getStore()?.ask(request) ?? Promise.reject(new PermissionDeniedError(request.permission)),
      questions: questions => calls.getStore()?.questions(questions) ?? Promise.reject(new QuestionDeclinedError()),
    } })
  let disposed: Promise<void> | undefined
  const dispose = () => disposed ??= runtime.dispose()
  const failures: string[] = []
  // Composition is evaluated during activation so failures still dispose the owned runtime.
  let capabilities: ReturnType<typeof composeContributions> | undefined
  return {
    runtime, sessionID, failures, dispose,
    get capabilities() { if (!capabilities) throw new Error("Kinex is initializing"); return capabilities },
    async activate(signal) {
      signal.throwIfAborted()
      capabilities = composeContributions(composition.contributions(runtime))
      for (const activation of await runtime.devices.warmLoaded()) {
        void activation.ready.catch(error => {
          const message = `${activation.device.name}: ${String(error)}`
          failures.push(message); options.diagnostic?.(message)
        })
      }
      signal.throwIfAborted()
    },
    invoke(signal, action) {
      const context: Context = { directory: options.directory, sessionID, abort: signal, ...permissions(options, form, signal, defaults) }
      return calls.run(context, () => action(context))
    },
  }
}
