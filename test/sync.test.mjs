import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { compareCatalogs, applyCandidate } from '../script/sync.mjs'
import { workspace } from './helpers.mjs'
test('compatibility report distinguishes additions, removals and schema changes', () => {
  const before = { tools: [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b' }], skills: [], workflows: [] }
  const after = { tools: [{ name: 'a', inputSchema: { type: 'string' } }, { name: 'c' }], skills: [{ name: 'new' }], workflows: [] }
  assert.deepEqual(compareCatalogs(before, after).tools, { added: ['c'], removed: ['b'], changed: ['a'] })
  assert.deepEqual(compareCatalogs(before, after).skills.added, ['new'])
})
test('candidate application refuses concurrent edits before changing any working file', async t => {
  const destination = await workspace(t), candidate = await workspace(t)
  await writeFile(path.join(destination, 'first'), 'old'); await writeFile(path.join(candidate, 'first'), 'new')
  await writeFile(path.join(destination, 'second'), 'user edit'); await writeFile(path.join(candidate, 'second'), 'candidate')
  await assert.rejects(applyCandidate(destination, candidate, ['first', 'second'], new Map([['first', Buffer.from('old')], ['second', undefined]])), /changed during validation/)
  assert.equal(await readFile(path.join(destination, 'first'), 'utf8'), 'old')
})

test('failed installation rolls candidate files back', async t => {
  const destination = await workspace(t), candidate = await workspace(t)
  await writeFile(path.join(destination, 'first'), 'old'); await writeFile(path.join(candidate, 'first'), 'new')
  await writeFile(path.join(candidate, 'added'), 'new file')
  await assert.rejects(applyCandidate(destination, candidate, ['first', 'added'], new Map([['first', Buffer.from('old')], ['added', undefined]]), async () => { throw new Error('install failed') }), /install failed/)
  assert.equal(await readFile(path.join(destination, 'first'), 'utf8'), 'old')
  await assert.rejects(readFile(path.join(destination, 'added')), { code: 'ENOENT' })
})
