import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveCommands, requestCommand } from '../dist/ipc.js'
import { workspace } from '../../../test/helpers.mjs'
import { serveInteraction, remoteForm } from '../dist/bridge.js'
const form = { message: 'Approve?', properties: { allow: { type: 'boolean', title: 'Allow' } }, required: ['allow'] }
test('private interaction bridge binds replies, declines invalid tokens and rejects malformed answers', async t => {
  const server = await serveInteraction(async () => ({ allow: true })); t.after(server.dispose)
  assert.deepEqual(await remoteForm(server.socketPath, server.token)(form, new AbortController().signal), { allow: true })
  assert.equal(await remoteForm(server.socketPath, 'wrong')(form, new AbortController().signal), undefined)
  const invalid = await serveInteraction(async () => ({ allow: 'yes' })); t.after(invalid.dispose)
  assert.equal(await remoteForm(invalid.socketPath, invalid.token)(form, new AbortController().signal), undefined)
})
test('disconnect cancels dialog and a late answer cannot grant permission', async t => {
  let entered, cancelled
  const ready = new Promise(resolve => { entered = resolve }), aborted = new Promise(resolve => { cancelled = resolve })
  const server = await serveInteraction(async (_form, signal) => { entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); cancelled(); return { allow: true } })
  t.after(server.dispose)
  const abort = new AbortController()
  const request = remoteForm(server.socketPath, server.token)(form, abort.signal)
  const rejected = assert.rejects(request, /cancelled/)
  await ready; abort.abort(); await rejected; await aborted
})

test('a duplicate control instance cannot remove another live instance socket', async t => {
  const directory = await workspace(t)
  const server = await serveCommands(directory, async () => ({ state: 'inactive' })); t.after(() => server.dispose())
  await assert.rejects(serveCommands(directory, async () => ({}), server.endpoint.instance), { code: 'EADDRINUSE' })
  assert.deepEqual(await requestCommand(server.endpoint, { method: 'execute', command: 'status', args: '', directory }, {
    signal: new AbortController().signal, confirm: async () => false,
  }), { state: 'inactive' })
})
