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
const temporary = await mkdtemp(path.join(tmpdir(), 'kinex-core-snapshot-'))
try {
  const core = path.join(source, 'packages/core')
  const manifest = JSON.parse(await readFile(path.join(core, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@kinex/core')
  execFileSync('npm', ['run', 'build:core'], { cwd: source, stdio: 'inherit' })
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary], core))
  const archive = path.join(temporary, packed.filename)
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  // A content-addressed filename avoids stale npm caches for unreleased work
  // whose package version has not changed.
  const file = `kinex-core-${manifest.version}-${sha256.slice(0, 16)}.tgz`
  let previous
  try { previous = JSON.parse(await readFile(path.join(root, 'vendor/core.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  await cp(archive, path.join(root, 'vendor', file))
  const snapshot = {
    name: manifest.name, version: manifest.version, file, sha256,
    source: { revision: run('git', ['rev-parse', 'HEAD']), dirty: !!run('git', ['status', '--porcelain', '--untracked-files=all']), capturedAt: new Date().toISOString() },
  }
  const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  project.devDependencies['@kinex/core'] = `file:vendor/${file}`
  await writeFile(path.join(root, 'package.json'), JSON.stringify(project, null, 2) + '\n')
  for (const name of ['pi', 'opencode', 'codex']) {
    const location = path.join(root, 'packages', name, 'package.json')
    const plugin = JSON.parse(await readFile(location, 'utf8'))
    plugin.dependencies['@kinex/core'] = manifest.version
    await writeFile(location, JSON.stringify(plugin, null, 2) + '\n')
  }
  await writeFile(path.join(root, 'vendor/core.json'), JSON.stringify(snapshot, null, 2) + '\n')
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' })
  if (previous && previous.file !== file && path.basename(previous.file) === previous.file) await rm(path.join(root, 'vendor', previous.file))
  console.log(`Updated core snapshot: ${file}. Run npm run typecheck and npm test before accepting it.`)
} finally { await rm(temporary, { recursive: true, force: true }) }
