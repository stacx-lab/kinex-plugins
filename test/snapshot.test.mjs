import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageSnapshots } from '../script/core-snapshot.mjs'
import { workspace } from './helpers.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
test('snapshot validation rejects corrupted archives and mismatched versions or provenance', async t => {
  const directory = await workspace(t)
  await cp(path.join(root, 'vendor'), path.join(directory, 'vendor'), { recursive: true })
  await cp(path.join(root, 'package.json'), path.join(directory, 'package.json'))
  for (const name of ['pi', 'opencode', 'codex']) {
    await mkdir(path.join(directory, 'packages', name), { recursive: true })
    await cp(path.join(root, 'packages', name, 'package.json'), path.join(directory, 'packages', name, 'package.json'))
  }
  assert.equal((await packageSnapshots(directory)).length, 2)
  for (const name of ['core', 'setup']) {
    const metadata = path.join(directory, 'vendor', `${name}.json`)
    const original = await readFile(metadata, 'utf8')
    const snapshot = JSON.parse(original)
    const archive = path.join(directory, 'vendor', snapshot.file)
    const bytes = await readFile(archive)
    await appendFile(archive, 'corruption')
    await assert.rejects(packageSnapshots(directory), /checksum mismatch/)
    await writeFile(archive, bytes)
    await writeFile(metadata, JSON.stringify({ ...snapshot, version: '0.0.0' }))
    await assert.rejects(packageSnapshots(directory), /Expected values to be strictly equal/)
    await writeFile(metadata, original)
  }
  const metadata = path.join(directory, 'vendor/setup.json')
  const snapshot = JSON.parse(await readFile(metadata, 'utf8'))
  snapshot.source.revision = 'different-revision'
  await writeFile(metadata, JSON.stringify(snapshot))
  await assert.rejects(packageSnapshots(directory), /same source capture/)
})
