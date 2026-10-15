import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))
async function filesUnder(directory, relative) {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(directory, path.join(relative, entry.name)) : [path.join(relative, entry.name)]))).flat()
}
export async function generatedArtifactPaths(directory = root) {
  const release = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'))
  return [...new Set([...await generatedFiles(directory).then(files => [...files.keys()]),
    ...await filesUnder(directory, `plugins/${release.name}/skills`), ...await filesUnder(directory, 'packages/pi/skills')])]
}
export async function generatedFiles(directory = root) {
  const release = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'))
  const { version } = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const files = new Map(), json = value => JSON.stringify(value, null, 2) + '\n'
  const plugin = `plugins/${release.name}`
  const identity = { name: release.name, version, description: release.description, author: { name: release.author }, repository: release.repository, license: 'Apache-2.0' }
  const mcp = { mcpServers: { kinex: { command: 'npx', args: ['-y', `@kinex/mcp@${version}`, 'serve'] } } }
  files.set(`${plugin}/plugin.json`, json(identity))
  files.set(`${plugin}/mcp.json`, json(mcp))
  files.set(`${plugin}/.mcp.json`, json(mcp))
  files.set(`${plugin}/.claude-plugin/plugin.json`, json({ ...identity, skills: './skills/', mcpServers: './.mcp.json' }))
  files.set(`${plugin}/.codex-plugin/plugin.json`, json({ ...identity, skills: './skills/', mcpServers: './.mcp.json',
    interface: { displayName: 'Kinex', shortDescription: 'Robotics in your coding agent', longDescription: release.description,
      developerName: release.author, category: 'Developer Tools', capabilities: ['Read', 'Write'], defaultPrompt: ['Start Kinex', 'Inspect my robot workspace'] } }))
  files.set('.claude-plugin/marketplace.json', json({ name: release.marketplace, owner: { name: release.author },
    plugins: [{ name: release.name, source: `./${plugin}`, description: release.description, version }] }))
  files.set('.agents/plugins/marketplace.json', json({ name: release.marketplace, interface: { displayName: 'Kinex' },
    plugins: [{ name: release.name, source: { source: 'local', path: `./${plugin}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }] }))
  for (const source of (await filesUnder(directory, 'assets/skills')).sort()) {
    const content = await readFile(path.join(directory, source))
    for (const target of [plugin, 'packages/pi']) files.set(`${target}/skills/${path.relative('assets/skills', source)}`, content)
  }
  return files
}
export async function generate(directory = root, check = false) {
  const files = await generatedFiles(directory)
  for (const relative of await generatedArtifactPaths(directory)) {
    if (files.has(relative)) continue
    if (check) throw new Error(`Obsolete generated artifact: ${relative}; run npm run generate`)
    await rm(path.join(directory, relative), { force: true })
  }
  for (const [relative, content] of files) {
    const file = path.join(directory, relative)
    if (check) {
      if (!Buffer.from(content).equals(await readFile(file).catch(() => Buffer.alloc(0)))) throw new Error(`Stale generated artifact: ${relative}; run npm run generate`)
    } else { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content) }
  }
  return [...files.keys()]
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generate(root, process.argv.includes('--check'))
