import { createServer, createConnection, type Socket } from "node:net"
import { mkdir, chmod, lstat, readdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"

const requestSchema = z.object({ method: z.enum(["describe", "execute"]), sessionID: z.string(), directory: z.string(), command: z.string().optional(), args: z.string().default("") }).strict()
const answerSchema = z.object({ confirm: z.string(), accepted: z.boolean() }).strict()
const endpointSchema = z.object({ socket: z.string(), directory: z.string(), instance: z.string(), pid: z.number() })
export type Request = z.infer<typeof requestSchema>
export type Endpoint = z.infer<typeof endpointSchema>
export interface Connection {
  signal: AbortSignal
  confirm(title: string, description: string): Promise<boolean>
}
const directory = () => path.join(tmpdir(), `kinex-oc-${process.getuid?.() ?? "user"}`)
const send = (socket: Socket, message: unknown) => socket.write(`${JSON.stringify(message)}\n`)

function readLines(socket: Socket, receive: (value: unknown) => void) {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", chunk => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > 1_048_576) { socket.destroy(new Error("Kinex IPC message too large")); return }
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      try { receive(JSON.parse(line)) } catch { socket.destroy(new Error("Invalid Kinex IPC message")); return }
    }
  })
}

export async function serveCommands(cwd: string, execute: (request: Request, connection: Connection) => Promise<unknown>) {
  const root = directory()
  await mkdir(root, { mode: 0o700, recursive: true })
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Unsafe Kinex IPC directory")
  await chmod(root, 0o700)
  const instance = randomUUID()
  const endpoint: Endpoint = { socket: path.join(root, `${instance}.sock`), directory: path.resolve(cwd), instance, pid: process.pid }
  const metadata = path.join(root, `${instance}.json`)
  const sockets = new Set<Socket>()
  const pending = new Set<Promise<void>>()
  const server = createServer(socket => {
    sockets.add(socket)
    const abort = new AbortController()
    let started = false
    let confirmation: { id: string; resolve(value: boolean): void } | undefined
    socket.on("error", () => {})
    socket.on("close", () => { sockets.delete(socket); abort.abort(); confirmation?.resolve(false) })
    readLines(socket, value => {
      const answer = answerSchema.safeParse(value)
      if (answer.success) {
        if (confirmation?.id === answer.data.confirm) { confirmation.resolve(answer.data.accepted); confirmation = undefined }
        return
      }
      if (started) { socket.destroy(); return }
      started = true
      const task = (async () => {
        try {
          const request = requestSchema.parse(value)
          if (path.resolve(request.directory) !== endpoint.directory) throw new Error("Kinex workspace mismatch")
          const result = await execute(request, {
            signal: abort.signal,
            confirm: (title, description) => new Promise(resolve => {
              if (abort.signal.aborted) { resolve(false); return }
              const id = randomUUID()
              confirmation = { id, resolve }
              send(socket, { confirm: id, title, description })
            }),
          })
          if (!socket.destroyed) send(socket, { result })
        } catch (error) { if (!socket.destroyed) send(socket, { error: error instanceof Error ? error.message : String(error) }) }
        finally { socket.end() }
      })()
      pending.add(task)
      void task.finally(() => pending.delete(task))
    })
  })
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socket, resolve) })
    await chmod(endpoint.socket, 0o600)
    await writeFile(metadata, JSON.stringify(endpoint), { mode: 0o600, flag: "wx" })
  } catch (error) {
    server.close()
    await rm(metadata, { force: true }); await rm(endpoint.socket, { force: true })
    throw error
  }
  return {
    endpoint,
    async dispose() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await Promise.allSettled(pending)
      await rm(metadata, { force: true }); await rm(endpoint.socket, { force: true })
    },
  }
}

export async function endpoints(cwd: string): Promise<Endpoint[]> {
  const root = directory()
  const files = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error })
  const result: Endpoint[] = []
  for (const file of files.filter(file => file.endsWith(".json"))) {
    const parsed = endpointSchema.safeParse(JSON.parse(await readFile(path.join(root, file), "utf8")))
    if (!parsed.success || path.resolve(cwd) !== parsed.data.directory || path.dirname(parsed.data.socket) !== root) continue
    try { process.kill(parsed.data.pid, 0) } catch { continue }
    result.push(parsed.data)
  }
  return result
}

export function requestCommand(endpoint: Endpoint, request: Request, connection: Connection): Promise<unknown> {
  return new Promise((resolve, reject) => {
    connection.signal.throwIfAborted()
    const socket = createConnection(endpoint.socket)
    let settled = false
    const abort = () => socket.destroy(new Error("Kinex command cancelled"))
    connection.signal.addEventListener("abort", abort, { once: true })
    socket.on("connect", () => send(socket, request))
    socket.on("error", reject)
    socket.on("close", () => { connection.signal.removeEventListener("abort", abort); if (!settled) reject(new Error("Kinex command connection closed")) })
    readLines(socket, value => {
      if (!value || typeof value !== "object") throw new Error("Invalid response")
      if ("confirm" in value && typeof value.confirm === "string" && "title" in value && typeof value.title === "string" && "description" in value && typeof value.description === "string") {
        const id = value.confirm
        void connection.confirm(value.title, value.description).then(accepted => { if (!socket.destroyed) send(socket, { confirm: id, accepted }) }, error => socket.destroy(error instanceof Error ? error : new Error(String(error))))
      } else if ("error" in value && typeof value.error === "string") { settled = true; reject(new Error(value.error)); socket.end() }
      else if ("result" in value) { settled = true; resolve(value.result); socket.end() }
    })
  })
}
