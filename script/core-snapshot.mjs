import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
export async function coreSnapshot() {
  const snapshot = JSON.parse(await readFile(path.join(root, 'vendor/core.json'), 'utf8'))
  assert.equal(path.basename(snapshot.file), snapshot.file, 'Snapshot must be a vendor filename')
  const file = path.join(root, 'vendor', snapshot.file)
  const bytes = await readFile(file)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), snapshot.sha256, 'Core snapshot checksum mismatch')
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(manifest.devDependencies['@kinex/core'], `file:vendor/${snapshot.file}`)
  for (const name of ['pi', 'opencode', 'codex']) {
    const plugin = JSON.parse(await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8'))
    assert.equal(plugin.dependencies['@kinex/core'], snapshot.version, `${name} must use the snapshot version`)
  }
  return { ...snapshot, path: file }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = await coreSnapshot()
  const installed = path.join(root, 'node_modules/@kinex/core')
  assert.equal(await realpath(installed), installed, 'Core must be installed from the snapshot, not linked to a checkout')
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.version, snapshot.version)
  console.log(`Core ${snapshot.version}: verified ${snapshot.sha256}`)
}
