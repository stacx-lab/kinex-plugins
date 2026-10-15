import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatedArtifactPaths } from './generate.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
export function compareCatalogs(before, after) {
  return Object.fromEntries(['tools', 'skills', 'workflows'].map(kind => {
    const old = new Map(before[kind].map(item => [item.name, item])), next = new Map(after[kind].map(item => [item.name, item]))
    return [kind, { added: [...next.keys()].filter(name => !old.has(name)), removed: [...old.keys()].filter(name => !next.has(name)),
      changed: [...next.keys()].filter(name => old.has(name) && JSON.stringify(old.get(name)) !== JSON.stringify(next.get(name))) }]
  }))
}
// Only validated dependency/generated outputs cross back from staging. Roll back a partial write.
export async function applyCandidate(destination, candidate, paths, originals, install = async () => {}) {
  for (const relative of paths) {
    const now = await read(path.join(destination, relative)), before = originals.get(relative)
    if ((before === undefined) !== (now === undefined) || (before && now && !before.equals(now))) {
      throw new Error(`Working file changed during validation: ${relative}`)
    }
  }
  const written = []
  try {
    for (const relative of paths) {
      const target = path.join(destination, relative), bytes = await read(path.join(candidate, relative))
      written.push(relative)
      if (bytes) { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes) }
      else await rm(target, { force: true })
    }
    await install()
  } catch (error) {
    for (const relative of written.reverse()) {
      const target = path.join(destination, relative), bytes = originals.get(relative)
      if (bytes) await writeFile(target, bytes); else await rm(target, { force: true })
    }
    throw error
  }
}

export async function synchronize(source, destination = root) {
  const stage = await mkdtemp(path.join(tmpdir(), 'kinex-sync-'))
  const run = (command, args, cwd, capture = false) => execFileSync(command, args, { cwd,
    env: { ...process.env, KINEX_SYNC_VALIDATION: '1' }, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
  try {
    const excluded = new Set(['.git', 'node_modules', 'dist'])
    await cp(destination, stage, { recursive: true, filter: file => !path.relative(destination, file).split(path.sep).some(part => excluded.has(part)) })
    const baseline = JSON.parse(run(process.execPath, ['script/catalog.mjs'], destination, true))
    const candidates = ['package.json', 'package-lock.json', 'packages/mcp/package.json', 'compatibility-report.json',
      'vendor/core.json', 'vendor/setup.json', ...await generatedArtifactPaths(destination)]
    const oldSnapshots = await Promise.all(['core', 'setup'].map(async name => JSON.parse(await readFile(path.join(destination, 'vendor', `${name}.json`), 'utf8'))))
    candidates.push(...oldSnapshots.map(snapshot => `vendor/${snapshot.file}`))
    const originals = new Map(await Promise.all(candidates.map(async relative => [relative, await read(path.join(destination, relative))])))
    run(process.execPath, ['script/refresh-core.mjs', path.resolve(source)], stage)
    run('npm', ['run', 'core:check'], stage)
    run('npm', ['run', 'typecheck'], stage)
    run('npm', ['test'], stage)
    run(process.execPath, ['script/release.mjs', '--check'], stage)
    const after = JSON.parse(run(process.execPath, ['script/catalog.mjs'], stage, true))
    const snapshots = await Promise.all(['core', 'setup'].map(async name => JSON.parse(await readFile(path.join(stage, 'vendor', `${name}.json`), 'utf8'))))
    const report = { snapshots, changes: compareCatalogs(baseline, after), checks: ['snapshot integrity', 'typecheck/build', 'shared and host tests', 'packaging'],
      hosts: JSON.parse(await readFile(path.join(stage, 'release.json'), 'utf8')).hosts }
    await writeFile(path.join(stage, 'compatibility-report.json'), JSON.stringify(report, null, 2) + '\n')
    for (const snapshot of snapshots) {
      const relative = `vendor/${snapshot.file}`
      if (!originals.has(relative)) { candidates.push(relative); originals.set(relative, undefined) }
    }
    try {
      await applyCandidate(destination, stage, candidates, originals, async () => {
        run('npm', ['ci'], destination)
        run('npm', ['run', 'build'], destination)
      })
    } catch (error) {
      // Dependency installation can fail after files are restored. Restore the prior install too.
      try { run('npm', ['ci'], destination); run('npm', ['run', 'build'], destination) }
      catch (recovery) { throw new AggregateError([error, recovery], 'Update rolled back, but dependency recovery failed; run npm ci and npm run build') }
      throw error
    }
    console.log(JSON.stringify(report, null, 2))
    console.log('Validated update applied and installed. No source adapters were rewritten.')
  } finally { await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: npm run kinex:sync -- PATH_TO_KINEX')
  await synchronize(process.argv[2])
}
