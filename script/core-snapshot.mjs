import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function packageSnapshots(directory = root) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const snapshots = []
  for (const name of ['core', 'setup']) {
    const snapshot = JSON.parse(await readFile(path.join(directory, 'vendor', `${name}.json`), 'utf8'))
    assert.equal(snapshot.name, `@kinex/${name}`)
    assert.equal(path.basename(snapshot.file), snapshot.file, 'Snapshot must be a vendor filename')
    const file = path.join(directory, 'vendor', snapshot.file)
    const bytes = await readFile(file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.sha256, `${name} snapshot checksum mismatch`)
    const packed = JSON.parse(execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }))
    assert.equal(packed.name, snapshot.name)
    assert.equal(packed.version, snapshot.version)
    assert.equal(manifest.devDependencies[snapshot.name], `file:vendor/${snapshot.file}`)
    for (const pluginName of ['pi', 'opencode', 'codex']) {
      const plugin = JSON.parse(await readFile(path.join(directory, 'packages', pluginName, 'package.json'), 'utf8'))
      assert.equal(plugin.dependencies[snapshot.name], snapshot.version, `${pluginName} must use the ${name} snapshot version`)
    }
    snapshots.push({ ...snapshot, path: file, manifest: packed })
  }
  const [core, setup] = snapshots
  assert.equal(setup.version, core.version, 'Core and setup versions must match')
  assert.equal(setup.manifest.dependencies['@kinex/core'], core.version, 'Setup must depend on the exact core version')
  assert.deepEqual(setup.source, core.source, 'Core and setup must come from the same source capture')
  return snapshots
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const snapshot of await packageSnapshots()) {
    const installed = path.join(root, 'node_modules', snapshot.name)
    assert.equal(await realpath(installed), installed, 'Packages must be installed from snapshots, not linked to a checkout')
    const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
    assert.equal(manifest.version, snapshot.version)
    if (snapshot.name === '@kinex/setup') assert.equal(manifest.dependencies['@kinex/core'], snapshot.version)
    console.log(`${snapshot.name} ${snapshot.version}: verified ${snapshot.sha256}`)
  }
}
