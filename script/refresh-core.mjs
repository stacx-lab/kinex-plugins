import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = path.resolve(process.argv[2] ?? path.join(root, '../kinex'))
const run = (command, args, cwd = source) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const temporary = await mkdtemp(path.join(tmpdir(), 'kinex-snapshots-'))
try {
  const manifests = await Promise.all(['core', 'setup'].map(async name => JSON.parse(await readFile(path.join(source, 'packages', name, 'package.json'), 'utf8'))))
  assert.equal(manifests[0].name, '@kinex/core')
  assert.equal(manifests[1].name, '@kinex/setup')
  assert.equal(manifests[1].version, manifests[0].version, 'Core and setup versions must match')
  assert.equal(manifests[1].dependencies['@kinex/core'], manifests[0].version)
  execFileSync('npm', ['run', 'build:setup'], { cwd: source, stdio: 'inherit' })
  const provenance = { revision: run('git', ['rev-parse', 'HEAD']), dirty: !!run('git', ['status', '--porcelain', '--untracked-files=all']), capturedAt: new Date().toISOString() }
  const snapshots = []
  for (const manifest of manifests) {
    const name = manifest.name.slice('@kinex/'.length)
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], path.join(source, 'packages', name)))
    const archive = path.join(temporary, packed.filename)
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
    const file = `kinex-${name}-${manifest.version}-${sha256.slice(0, 16)}.tgz`
    let previous
    try { previous = JSON.parse(await readFile(path.join(root, 'vendor', `${name}.json`), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await cp(archive, path.join(root, 'vendor', file))
    snapshots.push({ name, previous, snapshot: { name: manifest.name, version: manifest.version, file, sha256, source: provenance } })
  }
  const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const { snapshot } of snapshots) project.devDependencies[snapshot.name] = `file:vendor/${snapshot.file}`
  await writeFile(path.join(root, 'package.json'), JSON.stringify(project, null, 2) + '\n')
  for (const name of ['mcp']) {
    const location = path.join(root, 'packages', name, 'package.json')
    const plugin = JSON.parse(await readFile(location, 'utf8'))
    for (const { snapshot } of snapshots) plugin.dependencies[snapshot.name] = snapshot.version
    await writeFile(location, JSON.stringify(plugin, null, 2) + '\n')
  }
  for (const { name, snapshot } of snapshots) await writeFile(path.join(root, 'vendor', `${name}.json`), JSON.stringify(snapshot, null, 2) + '\n')
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' })
  for (const { previous, snapshot } of snapshots) {
    if (previous && previous.file !== snapshot.file && path.basename(previous.file) === previous.file) await rm(path.join(root, 'vendor', previous.file))
    console.log(`Updated snapshot: ${snapshot.file}`)
  }
  console.log('Run npm run core:check, npm run typecheck and npm test before accepting the snapshots.')
} finally { await rm(temporary, { recursive: true, force: true }) }
