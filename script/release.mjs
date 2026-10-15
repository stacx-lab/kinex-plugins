import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { packageSnapshots } from './core-snapshot.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const snapshots = await packageSnapshots()
const release = JSON.parse(await readFile(path.join(root, 'release.json'), 'utf8'))
await (await import('./generate.mjs')).generate(root, true)
const packages = await Promise.all(release.packages.map(async name => ({ name, manifest: JSON.parse(await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8')) })))
for (const { manifest } of packages) assert.equal(manifest.version, project.version, 'Plugin versions must match the plugin release')
const tag = process.argv.indexOf('--tag')
if (tag >= 0) assert.equal(process.argv[tag + 1], `v${project.version}`)
if (!process.argv.includes('--check')) {
  const output = process.argv[2]
  if (!output || output.startsWith('--')) throw new Error('Usage: npm run pack -- OUTPUT_DIRECTORY [--tag vVERSION]')
  const directory = path.resolve(output)
  if (directory === root || directory.startsWith(root + path.sep)) throw new Error('Pack outside the plugin project')
  await mkdir(directory, { recursive: true })
  const files = []
  for (const snapshot of snapshots) {
    const provenance = `${snapshot.name.slice('@kinex/'.length)}.json`
    await cp(snapshot.path, path.join(directory, snapshot.file))
    await cp(path.join(root, 'vendor', provenance), path.join(directory, provenance))
    files.push(snapshot.file, provenance)
  }
  for (const { name } of packages) {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', directory], { cwd: path.join(root, 'packages', name), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
    files.push(packed.filename)
  }
  const bundle = `kinex-host-plugins-${project.version}.tgz`
  execFileSync('tar', ['-czf', path.join(directory, bundle), 'plugins', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json'], { cwd: root })
  files.push(bundle)
  const sums = await Promise.all(files.map(async file => `${createHash('sha256').update(await readFile(path.join(directory, file))).digest('hex')}  ${file}`))
  await writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n')
}
