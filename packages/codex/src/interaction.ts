import { PermissionDeniedError, QuestionDeclinedError, kinexPermissionAction, loadPermissionRules, type Context } from "@kinex/core"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"

export function interaction(server: Server, directory: string, signal: AbortSignal): Pick<Context, "ask" | "questions"> {
  const form = async (message: string, properties: Record<string, { type: "boolean"; title: string } | { type: "string"; title: string }>, required: string[]) => {
    signal.throwIfAborted()
    const capability = server.getClientCapabilities()?.elicitation
    if (!capability || (!("form" in capability) && Object.keys(capability).length > 0)) return undefined
    const result = await server.elicitInput({ mode: "form", message, requestedSchema: { type: "object", properties, required } }, { signal })
    signal.throwIfAborted()
    return result.action === "accept" ? result.content : undefined
  }
  return {
    async ask(request) {
      signal.throwIfAborted()
      const action = kinexPermissionAction(request.permission, await loadPermissionRules(directory))
      if (action === "allow") return
      if (action === "deny") throw new PermissionDeniedError(request.permission)
      const answer = await form(`${request.permission}: ${request.description}`, { allow: { type: "boolean", title: "Allow this operation?" } }, ["allow"])
      if (answer?.allow !== true) throw new PermissionDeniedError(request.permission)
    },
    async questions(questions) {
      const answers: Record<string, string> = {}
      for (const question of questions) {
        const properties: Record<string, { type: "boolean"; title: string } | { type: "string"; title: string }> = {}
        const required: string[] = []
        let message = `${question.header}: ${question.question}`
        if (question.multiple && question.options.length) {
          for (const [index, option] of question.options.entries()) {
            properties[`choice_${index}`] = { type: "boolean", title: `${option.label}${option.description ? ` — ${option.description}` : ""}` }
            required.push(`choice_${index}`)
          }
        } else {
          properties.answer = { type: "string", title: "Your answer" }
          required.push("answer")
          message += question.options.map(option => `\n- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("")
        }
        const answer = await form(message, properties, required)
        if (!answer || required.some(key => typeof answer[key] !== properties[key]?.type)) throw new QuestionDeclinedError()
        answers[question.question] = question.multiple && question.options.length
          ? question.options.filter((_, index) => answer[`choice_${index}`] === true).map(option => option.label).join(", ")
          : String(answer.answer)
      }
      return answers
    },
  }
}
