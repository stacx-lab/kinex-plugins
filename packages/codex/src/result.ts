import { open } from "node:fs/promises"
import type { Result } from "@kinex/core"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export async function modelResult(result: Result): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [{ type: "text", text: result.output }]
  let remaining = 20 * 1024 * 1024
  for (const attachment of result.attachments ?? []) {
    try {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mime)) throw new Error("unsupported image type")
      const file = await open(attachment.path, "r")
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > Math.min(remaining, 10 * 1024 * 1024)) throw new Error("image exceeds attachment limit")
        const bytes = Buffer.alloc(stat.size + 1)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        if (bytesRead !== stat.size) throw new Error("image changed while reading")
        remaining -= bytesRead
        content.push({ type: "image", mimeType: attachment.mime, data: bytes.subarray(0, bytesRead).toString("base64") })
      } finally { await file.close() }
    } catch (error) {
      content.push({ type: "text", text: `Image omitted: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return { content, isError: result.isError, structuredContent: { title: result.title, output: result.output, metadata: result.metadata ?? {} } }
}
