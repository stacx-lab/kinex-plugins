// Run in a fresh Node process; the workspace has no configured devices.
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const directory = await mkdtemp(path.join(tmpdir(), 'kinex-benchmark-'))
process.env.KINEX_CONFIG_DIR = path.join(directory, 'config')
process.env.KINEX_DATA_DIR = path.join(directory, 'data')
const measure = since => ({ elapsedMs: Math.round((performance.now() - since) * 100) / 100,
  rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024 * 100) / 100,
  heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100 })
let adapter
try {
  const before = performance.now()
  const { createKinexMcpServer } = await import('../packages/mcp/dist/index.js')
  adapter = await createKinexMcpServer({ directory })
  const inactive = measure(before)
  if (adapter.runtime || (await adapter.status()).state !== 'inactive') throw new Error('Benchmark unexpectedly activated robotics')
  const start = performance.now()
  await adapter.command('start', '', { signal: new AbortController().signal, confirm: async () => false })
  const active = measure(start)
  const end = performance.now(); await adapter.command('end', '', { confirm: async () => false })
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
    scenario: 'fresh process, empty workspace; module load and factory, then trusted start, then end',
    inactive, active, shutdown: measure(end) }, null, 2))
} finally { await adapter?.dispose(); await rm(directory, { recursive: true, force: true }) }
