import { readFile } from "node:fs/promises"
import { z } from "zod"

const manifest = z.object({ name: z.string(), version: z.string() })
async function packageVersion(file: URL, name: string) {
  const parsed = manifest.parse(JSON.parse(await readFile(file, "utf8")))
  if (parsed.name !== name) throw new Error(`Expected ${name} at ${file.href}, found ${parsed.name}`)
  return parsed.version
}

export const version = await packageVersion(new URL("../package.json", import.meta.url), "@kinex/mcp")
let installed: Promise<{ mcp: string; core: string; setup: string }> | undefined
// Resolve installed Kinex packages without evaluating them; runtime modules load only on start.
export function kinexVersions() {
  return installed ??= (async () => ({ mcp: version,
    core: await packageVersion(new URL("../package.json", import.meta.resolve("@kinex/core")), "@kinex/core"),
    setup: await packageVersion(new URL("../package.json", import.meta.resolve("@kinex/setup")), "@kinex/setup") }))()
}
