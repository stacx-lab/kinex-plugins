import { createServer, createConnection, type Socket } from "node:net"
import { randomUUID } from "node:crypto"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { z } from "zod"
import { readLines } from "./ipc.ts"
import type { AskForm, FormAnswer } from "./types.ts"
export type { AskForm, Form, FormAnswer } from "./types.ts"
const field = z.discriminatedUnion("type", [z.object({ type: z.literal("boolean"), title: z.string() }).strict(), z.object({ type: z.literal("string"), title: z.string() }).strict()])
const formSchema = z.object({ message: z.string(), properties: z.record(z.string(), field), required: z.array(z.string()) }).strict()
const requestSchema = z.object({ token: z.string(), id: z.string(), form: formSchema }).strict()
const responseSchema = z.object({ id: z.string(), answer: z.record(z.string(), z.union([z.string(), z.boolean()])).optional() }).strict()

export async function serveInteraction(handler: AskForm) {
  const root = await mkdtemp(path.join(tmpdir(), "kinex-ui-"))
  await chmod(root, 0o700)
  const socketPath = path.join(root, "ui.sock"), token = randomUUID()
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    const abort = new AbortController()
    socket.on("error", () => {})
    socket.on("close", () => { sockets.delete(socket); abort.abort(new Error("Kinex interaction disconnected")) })
    let received = false
    readLines(socket, value => {
      if (received) { socket.destroy(); return }
      received = true
      const request = requestSchema.parse(value)
      if (request.token !== token) { socket.destroy(); return }
      void handler(request.form, abort.signal).then(answer => {
        if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id, answer }) + "\n")
      }, () => { if (!socket.destroyed) socket.end(JSON.stringify({ id: request.id }) + "\n") })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
    await chmod(socketPath, 0o600)
  } catch (error) { server.close(); await rm(root, { recursive: true, force: true }); throw error }
  let disposed: Promise<void> | undefined
  return { socketPath, token, dispose: () => disposed ??= (async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })() }
}

export function remoteForm(socketPath: string, token: string): AskForm {
  return (form, signal) => new Promise<FormAnswer>((resolve, reject) => {
    signal.throwIfAborted()
    const id = randomUUID(), socket = createConnection(socketPath)
    let settled = false
    const abort = () => socket.destroy(new Error("Kinex interaction cancelled"))
    signal.addEventListener("abort", abort, { once: true })
    socket.setTimeout(300_000, () => socket.destroy(new Error("Kinex interaction timed out")))
    socket.on("connect", () => socket.write(JSON.stringify({ id, token, form }) + "\n"))
    socket.on("error", error => { if (!settled) { settled = true; reject(error) } })
    socket.on("close", () => {
      signal.removeEventListener("abort", abort)
      if (!settled) { settled = true; resolve(undefined) }
    })
    readLines(socket, value => {
      const response = responseSchema.parse(value)
      if (response.id !== id || signal.aborted) { abort(); return }
      const valid = response.answer && form.required.every(key => typeof response.answer?.[key] === form.properties[key]?.type)
      settled = true; resolve(valid ? response.answer : undefined); socket.end()
    })
  })
}
