import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { isolate, workspace, seed } from '../../../test/helpers.mjs'
const isolated = await isolate()
after(isolated.cleanup)
const { createCodexAdapter } = await import('../dist/index.js')
const { createKinexRuntime } = await import('@kinex/core')
const { coreContribution } = await import('@kinex/core/integration')
const { serveCommands, endpoints, requestCommand } = await import('../dist/ipc.js')

async function fixture(t, options = {}, elicit) {
  const directory = options.directory ?? await workspace(t)
  const adapter = await createCodexAdapter({ directory, ...options })
  t.after(() => adapter.dispose())
  const client = new Client({ name: 'test', version: '1' }, { capabilities: elicit ? { elicitation: { form: {} } } : {} })
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await adapter.connect(a)
  await client.connect(b)
  t.after(() => client.close())
  return { directory, adapter, client, call: (name, args = {}) => client.callTool({ name, arguments: args }), tool: (name, args = {}) => client.callTool({ name: 'kinex_call', arguments: { name, arguments: args } }) }
}
const output = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
const signal = () => new AbortController().signal

test('fixed MCP catalog discovers live tools, skills and workflows without creating Python or shadowing ancestors', async t => {
  const secretKey = 'KINEX_TEST_MCP_SECRET'
  const previous = process.env[secretKey]
  process.env[secretKey] = 'mcp-must-not-expose-inherited-credentials'
  t.after(() => { if (previous === undefined) delete process.env[secretKey]; else process.env[secretKey] = previous })
  const parent = await workspace(t)
  const core = createKinexRuntime({ directory: parent }); await seed(core); await core.dispose()
  const directory = path.join(parent, 'nested'); await mkdir(directory)
  const f = await fixture(t, { directory })
  assert.match(f.client.getInstructions(), /kinex-codex control --directory .* onboarding/)
  assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), ['kinex_tools', 'kinex_call', 'kinex_stop'])
  const discovered = await f.call('kinex_tools')
  assert.equal(JSON.stringify(discovered).includes(process.env[secretKey]), false)
  assert.equal(JSON.stringify(discovered).includes(secretKey), false)
  const discovery = discovered.structuredContent
  assert.equal('env' in JSON.parse(discovery.context.sections['core.python']), false)
  assert.ok(discovery.tools.some(tool => tool.name === 'device'))
  assert.ok(!discovery.tools.some(tool => tool.name === 'record'))
  assert.match(discovery.context.sections['core.devices'], /sensor/)
  assert.ok((await f.call('kinex_tools', { skill: 'setup-device' })).structuredContent.skill.content.length > 100)
  assert.match(output(await f.call('kinex_tools', { workflow: 'register', arguments: 'rgb' })), /rgb/)
  assert.equal((await f.call('kinex_tools', { workflow: 'load', arguments: 'sensor' })).isError, true)
  const dir = path.join(parent, '.kinex/tool'); await mkdir(dir)
  const file = path.join(dir, 'probe.js')
  const source = label => `export default { description: '${label}', execute: async () => ({title: 'probe', output: '${label}'}) }`
  await writeFile(file, source('first'))
  assert.match(output(await f.call('kinex_tools')), /probe/)
  assert.match(output(await f.tool('probe')), /first/)
  await writeFile(file, source('second'))
  assert.match(output(await f.tool('probe')), /second/)
  await rm(file)
  assert.equal((await f.tool('probe')).isError, true)
  await assert.rejects(stat(path.join(directory, '.kinex')), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(parent, '.kinex/python')), { code: 'ENOENT' })
})

test('core permissions require form approval, preserve denies and reread explicit allows', async t => {
  let accepted = false, asks = 0
  const f = await fixture(t, {}, async () => { asks++; return { action: accepted ? 'accept' : 'decline', ...(accepted ? { content: { allow: true } } : {}) } })
  await seed(f.adapter.runtime)
  const load = () => f.tool('device', { deviceID: 'sensor', action: 'load' })
  const denied = await load()
  assert.equal(denied.isError, true); assert.match(output(denied), /PermissionDeniedError/)
  assert.equal((await f.adapter.runtime.devices.list())[0].loaded, false)
  accepted = true
  assert.ok(!(await load()).isError)
  assert.equal(asks, 2)
  await writeFile(path.join(f.directory, 'kinex.json'), JSON.stringify({ permission: { device_act: 'deny' } }))
  assert.equal((await load()).isError, true); assert.equal(asks, 2)
  await writeFile(path.join(f.directory, 'kinex.json'), JSON.stringify({ permission: { device_act: 'allow' } }))
  assert.ok(!(await load()).isError); assert.equal(asks, 2)
  assert.equal((await f.tool('device', { deviceID: 5 })).isError, true)
})

test('clients without elicitation fail closed while stop remains available', async t => {
  const f = await fixture(t)
  await seed(f.adapter.runtime)
  assert.match(output(await f.tool('device', { deviceID: 'sensor', action: 'load' })), /PermissionDeniedError/)
  await f.adapter.command('load', 'sensor', { confirm: async () => false })
  const stopped = await f.call('kinex_stop', { deviceID: 'sensor' })
  assert.ok(!stopped.isError, output(stopped))
  assert.equal((await f.adapter.runtime.devices.dispatch('sensor', 'read')).data.stopped, true)
})

test('contributions retain questions, image bytes and dynamic routing', async t => {
  const directory = await workspace(t)
  const image = path.join(directory, 'image.png')
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  await writeFile(image, bytes)
  let enabled = true, cancelled = false
  const f = await fixture(t, { directory, contributions: runtime => [coreContribution(runtime), {
    id: 'extra', tools: {
      list: async () => ({ tools: enabled ? [{ name: 'interview', description: 'interview', inputSchema: { type: 'object' } }] : [], problems: [] }),
      call: async (_name, _args, ctx) => {
        const answer = await ctx.questions([{ header: 'Choose', question: 'Which?', multiple: true, options: [{ label: 'A' }, { label: 'B' }] }])
        return { title: 'image', output: JSON.stringify(answer), metadata: { captured: true }, attachments: [{ path: image, mime: 'image/png' }] }
      },
    },
  }] }, async () => cancelled ? { action: 'cancel' } : { action: 'accept', content: { choice_0: true, choice_1: false } })
  const result = await f.tool('interview')
  assert.match(output(result), /"Which\?":"A"/)
  assert.equal(result.content.find(item => item.type === 'image').data, bytes.toString('base64'))
  assert.equal(result.structuredContent.metadata.captured, true)
  await rm(image)
  assert.equal(result.content.find(item => item.type === 'image').data, bytes.toString('base64'))
  cancelled = true
  assert.match(output(await f.tool('interview')), /QuestionDeclinedError/)
  enabled = false
  assert.match(output(await f.tool('interview')), /Unknown Kinex tool/)
})

test('denial cancels queued siblings and emergency stop interrupts active work', async t => {
  let entered, executionCount = 0
  let ready = new Promise(resolve => { entered = resolve })
  let release
  const f = await fixture(t, { contributions: runtime => [coreContribution(runtime), {
    id: 'extra', tools: {
      list: async () => ({ tools: ['deny', 'wait'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })), problems: [] }),
      call: async (name, _args, ctx) => {
        executionCount++; entered()
        if (name === 'deny') { await new Promise(resolve => { release = resolve }); await ctx.ask({ permission: 'extra', description: 'extra' }) }
        else await new Promise((resolve, reject) => { ctx.abort.addEventListener('abort', () => reject(ctx.abort.reason), { once: true }) })
        return { title: 'done', output: 'done' }
      },
    },
  }] })
  await seed(f.adapter.runtime)
  const first = f.tool('deny'); await ready
  const sibling = f.tool('deny'); await delay(10); release()
  assert.equal((await first).isError, true)
  assert.match(output(await sibling), /queued operation cancelled/)
  assert.equal(executionCount, 1)
  ready = new Promise(resolve => { entered = resolve })
  const waiting = f.tool('wait'); await ready
  const stop = await f.call('kinex_stop')
  assert.ok(!stop.isError, output(stop))
  assert.equal((await waiting).isError, true)
})

test('MCP cancellation aborts active work and prevents queued execution', async t => {
  let entered, cancelled
  const ready = new Promise(resolve => { entered = resolve })
  const aborted = new Promise(resolve => { cancelled = resolve })
  let count = 0
  const f = await fixture(t, { contributions: runtime => [coreContribution(runtime), {
    id: 'extra', tools: {
      list: async () => ({ tools: [{ name: 'slow', description: 'slow', inputSchema: { type: 'object' } }], problems: [] }),
      call: async (_name, _args, ctx) => {
        count++; entered()
        await new Promise((resolve, reject) => ctx.abort.addEventListener('abort', () => { cancelled(); reject(ctx.abort.reason) }, { once: true }))
        return { title: 'done', output: 'done' }
      },
    },
  }] })
  const abort = new AbortController()
  const active = f.client.callTool({ name: 'kinex_call', arguments: { name: 'slow', arguments: {} } }, undefined, { signal: abort.signal })
  const rejected = assert.rejects(active)
  await ready
  const queued = f.tool('slow'); await delay(10)
  abort.abort(); await rejected; await aborted
  assert.equal((await queued).isError, true); assert.equal(count, 1)
})

test('private controls share recording and driver state, reject wrong workspace and cancel on disconnect', async t => {
  const f = await fixture(t)
  await seed(f.adapter.runtime)
  const ipc = await serveCommands(f.directory, (request, connection) => f.adapter.command(request.command, request.args, connection))
  t.after(() => ipc.dispose())
  const endpoint = (await endpoints(f.directory)).find(item => item.instance === ipc.endpoint.instance)
  const command = (name, args = '') => requestCommand(endpoint, { method: 'execute', directory: f.directory, command: name, args }, { signal: signal(), confirm: async () => false })
  await command('load', 'sensor')
  assert.ok(!(await f.tool('device', { deviceID: 'sensor' })).isError)
  await command('record', 'start sensor=20')
  assert.equal((await f.adapter.runtime.recording.status()).status, 'recording')
  assert.equal((await f.tool('record', { action: 'status' })).isError, true)
  await command('record', 'snap sensor')
  assert.match((await command('record', 'stop')).text, /stopped/)
  assert.equal((await command('unregister', 'sensor')).text, 'Cancelled')
  await assert.rejects(requestCommand(endpoint, { method: 'execute', directory: '/wrong', command: 'load', args: 'sensor' }, { signal: signal(), confirm: async () => false }), /workspace mismatch/)
  const abort = new AbortController()
  let asked
  const asking = new Promise(resolve => { asked = resolve })
  const pending = requestCommand(endpoint, { method: 'execute', directory: f.directory, command: 'unregister', args: 'sensor' }, {
    signal: abort.signal, confirm: async () => { asked(); return new Promise(() => {}) },
  })
  const rejected = assert.rejects(pending, /cancelled/)
  await asking; abort.abort(); await rejected
  assert.equal((await f.adapter.runtime.devices.list()).length, 1)
})

test('startup reserves persistent driver initialization and disposal finalizes recording and owned processes', async t => {
  const directory = await workspace(t)
  const core = createKinexRuntime({ directory }); await seed(core)
  await core.profiles.writeDevice({ name: 'sensor', loaded: true, access: { connection: { kind: 'process' }, driver: { interpreter: 'python3', persistent: true, actions: ['load', 'read', 'status', 'stop', 'unload'], timeout_s: 3 } } })
  const dir = path.join(directory, '.kinex/devices/sensor')
  await writeFile(path.join(dir, 'driver.py'), `import os,time\nfrom kinex.driver_protocol import run\nready=False\ndef dispatch(action,args):\n global ready\n if action=='load':\n  time.sleep(0.1)\n  ready=True\n if action=='read' and not ready: raise RuntimeError('not ready')\n return {'ok':True,'pid':os.getpid(),'ready':ready}\nrun(dispatch,lambda:None)\n`)
  await writeFile(path.join(directory, 'kinex.json'), JSON.stringify({ permission: { device_read: 'allow', record: 'allow' } }))
  await core.dispose()
  const f = await fixture(t, { directory, enableRecording: true })
  const first = await f.tool('device', { deviceID: 'sensor', compact: true })
  assert.ok(!first.isError, output(first))
  const reading = JSON.parse(first.structuredContent.output)
  assert.equal(reading.ready, true)
  const second = await f.tool('device', { deviceID: 'sensor', compact: true })
  assert.equal(JSON.parse(second.structuredContent.output).pid, reading.pid)
  assert.ok((await f.call('kinex_tools')).structuredContent.tools.some(tool => tool.name === 'record'))
  const capture = await f.adapter.command('record', 'start sensor=20', { confirm: async () => false })
  const recordID = JSON.parse(capture.text).manifest.id
  await delay(80)
  await f.adapter.dispose(); await f.adapter.dispose()
  assert.throws(() => process.kill(reading.pid, 0), { code: 'ESRCH' })
  const manifest = JSON.parse(await readFile(path.join(directory, '.kinex/recordings', recordID, 'recording.json'), 'utf8'))
  assert.equal(manifest.status, 'stopped'); assert.equal(manifest.endedBy, 'exit')
  await assert.rejects(stat(path.join(directory, '.kinex/python')), { code: 'ENOENT' })
})

test('context errors after an action retain its result and attachment omissions are explicit', async t => {
  let executed = 0
  const directory = await workspace(t)
  const { open } = await import('node:fs/promises')
  const large = path.join(directory, 'large.png')
  const file = await open(large, 'w'); await file.truncate(11 * 1024 * 1024); await file.close()
  const f = await fixture(t, { directory, contributions: runtime => [coreContribution(runtime), {
    id: 'extra', context: async () => {
      if (executed) throw new Error('context unavailable')
      return { instructions: '', sections: {} }
    }, tools: {
      list: async () => ({ tools: [{ name: 'action', description: 'action', inputSchema: { type: 'object' } }], problems: [] }),
      call: async () => { executed++; return { title: 'done', output: 'ACTION_COMPLETED', attachments: [{ path: large, mime: 'image/png' }, { path: path.join(directory, 'missing.png'), mime: 'image/png' }] } },
    },
  }] })
  const result = await f.tool('action')
  assert.ok(!result.isError)
  assert.match(output(result), /ACTION_COMPLETED/)
  assert.match(output(result), /image exceeds attachment limit/)
  assert.match(output(result), /ENOENT/)
  assert.match(output(result), /context refresh failed/)
  assert.equal(executed, 1)
})

test('disposal cancels initialization while a trusted command waits on its lane', { timeout: 10000 }, async t => {
  const directory = await workspace(t)
  const core = createKinexRuntime({ directory }); await seed(core)
  await core.profiles.writeDevice({ name: 'sensor', loaded: true, access: { connection: { kind: 'process' }, driver: { interpreter: 'python3', persistent: true, actions: ['load', 'read', 'unload'], timeout_s: 60 } } })
  await writeFile(path.join(directory, '.kinex/devices/sensor/driver.py'), `import time\nfrom kinex.driver_protocol import run\ndef dispatch(action,args):\n if action=='load': time.sleep(30)\n return {'ok':True}\nrun(dispatch,lambda:None)\n`)
  await core.dispose()
  const f = await fixture(t, { directory })
  const command = f.adapter.command('unload', 'sensor', { confirm: async () => false })
  const settled = Promise.allSettled([command])
  await delay(50)
  await f.adapter.dispose()
  await settled
})
