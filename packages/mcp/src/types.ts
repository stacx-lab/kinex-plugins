import type { Context, KinexRuntime } from "@kinex/core"
import type { KinexCapabilities } from "@kinex/core/integration"
import type { KinexComposition } from "./composition.ts"

export interface Form {
  message: string
  properties: Record<string, { type: "boolean"; title: string } | { type: "string"; title: string }>
  required: string[]
}
export type FormAnswer = Record<string, string | boolean> | undefined
export type AskForm = (form: Form, signal: AbortSignal) => Promise<FormAnswer>
export interface RuntimeOptions {
  directory: string
  enableRecording?: boolean
  composition?: KinexComposition
  diagnostic?(message: string): void
}
export interface RuntimeBundle {
  runtime: KinexRuntime
  capabilities: KinexCapabilities
  sessionID: string
  failures: string[]
  activate(signal: AbortSignal): Promise<void>
  invoke<T>(signal: AbortSignal, action: (context: Context) => Promise<T>): Promise<T>
  dispose(): Promise<void>
}
