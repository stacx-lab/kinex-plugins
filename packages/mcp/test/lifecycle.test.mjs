import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { isolate, workspace } from '../../../test/helpers.mjs'
const isolated = await isolate(); after(isolated.cleanup)
const { createKinexMcpServer } = await import('../dist/index.js')
const { coreContribution } = await import('@kinex/core/integration')
async function connect(t, options = {}, elicit) {
  const directory = await workspace(t)
  const server = await createKinexMcpServer({ directory, ...options })
  t.after(() => server.dispose().catch(error => { if (error.message !== "Error: cleanup failed") throw error }))
  const client = new Client({ name: 'lifecycle', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} })
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit)
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b)
  t.after(() => client.close())
  return { server, directory, call: (name, args = {}) => client.callTool({ name, arguments: args }) }
}
const user = { confirm: async () => false }
test('inactive startup is inert; activation is explicit, repeatable, and reset on end', async t => {
  let creations = 0
  const f = await connect(t, { composition: { contributions: runtime => { creations++; return [coreContribution(runtime)] } } })
  assert.equal((await f.call('kinex_status')).structuredContent.state, 'inactive')
  assert.equal((await f.call('kinex_tools')).isError, true)
  assert.equal((await f.call('kinex_call', { name: 'device', arguments: {} })).isError, true)
  assert.equal((await f.call('kinex_start')).isError, true)
  assert.equal(creations, 0); assert.equal(f.server.runtime, undefined)
  assert.equal((await f.call('kinex_stop')).structuredContent.state, 'inactive')
  await assert.rejects(stat(path.join(f.directory, '.kinex')), { code: 'ENOENT' })
  await Promise.all([f.server.command('start', '', user), f.server.command('start', '', user)])
  const identity = f.server.sessionID
  await f.call('kinex_start')
  assert.equal(creations, 1)
  assert.equal((await f.call('kinex_shutdown')).structuredContent.state, 'inactive')
  await f.call('kinex_shutdown')
  assert.equal(f.server.runtime, undefined)
  await f.server.command('start', '', user)
  assert.equal(creations, 2); assert.notEqual(f.server.sessionID, identity)
  await assert.rejects(stat(path.join(f.directory, '.kinex/python')), { code: 'ENOENT' })
})
test('concurrent model starts share one approval and explicit rules are honored', async t => {
  let approvals = 0
  const f = await connect(t, {}, async () => { approvals++; return { action: 'accept', content: { allow: true } } })
  const results = await Promise.all([f.call('kinex_start'), f.call('kinex_start')])
  assert.equal(approvals, 1); assert.ok(results.every(result => result.structuredContent.state === 'active'))
  await f.call('kinex_shutdown')
  await writeFile(path.join(f.directory, 'kinex.json'), JSON.stringify({ permission: { runtime_start: 'deny' } }))
  assert.equal((await f.call('kinex_start')).isError, true); assert.equal(approvals, 1)
})
test('shutdown cancels pending activation approval without constructing a runtime', async t => {
  let asked
  const ready = new Promise(resolve => { asked = resolve })
  const f = await connect(t, { interaction: (_form, signal) => new Promise((resolve, reject) => {
    asked(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  const start = f.call('kinex_start'); await ready
  assert.equal((await f.call('kinex_shutdown')).structuredContent.state, 'inactive')
  assert.equal((await start).isError, true); assert.equal(f.server.runtime, undefined)
})
test('new contributions are exposed without changing host adapters and discovery stays scoped', async t => {
  const f = await connect(t, { composition: { contributions: runtime => [coreContribution(runtime), {
    id: 'new-feature', tools: { list: async () => ({ tools: [{ name: 'new_tool', description: 'new', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }], problems: [] }),
      call: async (_name, args) => ({ title: 'new', output: args.value, attachments: [{ mime: 'image/png', data: 'aGVsbG8=' }] }) },
    skills: { list: async () => [{ name: 'new-skill', description: 'New skill' }], load: async () => ({ info: { name: 'new-skill' }, content: 'NEW_GUIDANCE' }) },
    context: async () => ({ instructions: 'new instructions', sections: { state: 'new state' } }),
  }] } })
  await f.server.command('start', '', user)
  const catalog = (await f.call('kinex_tools')).structuredContent
  assert.ok(catalog.tools.some(tool => tool.name === 'new_tool')); assert.ok(catalog.tools.every(tool => !tool.inputSchema))
  assert.equal((await f.call('kinex_tools', { tool: 'new_tool' })).structuredContent.tool.inputSchema.properties.value.type, 'string')
  assert.equal((await f.call('kinex_tools', { skill: 'new-skill' })).structuredContent.skill.content, 'NEW_GUIDANCE')
  const context = (await f.call('kinex_tools', { context: ['new-feature.state'] })).structuredContent.context
  assert.deepEqual(context.sections, { 'new-feature.state': 'new state' })
  const call = await f.call('kinex_call', { name: 'new_tool', arguments: { value: 'NEW_RESULT' } })
  assert.equal(call.structuredContent.output, 'NEW_RESULT'); assert.equal(call.content[1].type, 'image')
})
test('failed composition cleans up; failed disposal prevents restart', async t => {
  const f = await connect(t, { composition: { contributions: () => { throw new Error('invalid contribution') } } })
  await assert.rejects(f.server.command('start', '', user), /invalid contribution/)
  assert.equal((await f.server.status()).state, 'inactive'); assert.equal(f.server.runtime, undefined)
  const g = await connect(t)
  await g.server.command('start', '', user)
  const dispose = g.server.runtime.dispose.bind(g.server.runtime)
  g.server.runtime.dispose = async () => { await dispose(); throw new Error('cleanup failed') }
  assert.equal((await g.call('kinex_shutdown')).isError, true)
  assert.equal((await g.call('kinex_status')).structuredContent.state, 'failed')
  assert.equal((await g.call('kinex_start')).isError, true)
  // Disposal still closes the transport; the deliberate error is asserted here.
  await assert.rejects(g.server.dispose(), /cleanup failed/)
})


test('host mode delegates default start approval but retains explicit rules and rejects model mode changes', async t => {
  const f = await connect(t, { permissionMode: 'host' })
  assert.equal((await f.call('kinex_status')).structuredContent.permissionMode, 'host')
  assert.equal((await f.call('kinex_start')).structuredContent.state, 'active')
  await f.call('kinex_shutdown')
  for (const rule of ['deny', 'ask', 'malformed']) {
    await writeFile(path.join(f.directory, 'kinex.json'), JSON.stringify({ permission: { runtime_start: rule } }))
    assert.equal((await f.call('kinex_start')).isError, true)
    assert.equal(f.server.runtime, undefined)
  }
  const g = await connect(t)
  assert.equal((await g.call('kinex_status')).structuredContent.permissionMode, 'kinex')
  assert.equal((await g.call('kinex_start', { permissionMode: 'host' })).isError, true)
  assert.equal((await g.call('kinex_start')).isError, true)
  await assert.rejects(createKinexMcpServer({ directory: f.directory, permissionMode: 'invalid' }))
})
