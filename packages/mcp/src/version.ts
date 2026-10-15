import { readFile } from "node:fs/promises"
import { z } from "zod"

const manifest = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")))
export const version = manifest.version
