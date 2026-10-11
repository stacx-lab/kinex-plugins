import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isolate, workspace, seed, fakeProvider } from '../../../test/helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const { coreContribution, composeContributions } = await import('@kinex/core/integration')
const { createOpenCodePlugin } = await import('../dist/server.js')
const { projectContext } = await import('../dist/context.js')
const { endpoints, requestCommand } = await import('../dist/ipc.js')
const { startOpenCode } = await import('./helpers.mjs')

function input(cwd) {
  return { directory: cwd, worktree: cwd, client: {
    session: { get: async () => ({ data: { directory: cwd } }), abort: async () => {}, messages: async () => ({ data: [] }) },
    app: { log: async () => {} },
  } }
}

test('OpenCode adapter composes two features, refreshes tools, and denies queued siblings', async t => {
  const cwd = await workspace(t)
  let runtime
  let available = true
  let executions = 0
  const hooks = await createOpenCodePlugin({ composition: { contributions: core => {
    runtime = core
    return [coreContribution(core), {
      id: 'world', tools: {
        list: async () => ({ tools: available ? [{ name: 'world', description: 'world', inputSchema: { type: 'object' } }] : [], problems: [] }),
        call: async (_name, _args, invocation) => { await invocation.ask({ permission: 'world', description: 'world' }); executions++; return { title: 'world', output: 'WORLD' } },
      },
      commands: [{ name: 'world-status', description: 'World status', arguments: '', kind: 'operation', execute: async () => ({ kind: 'output', text: 'WORLD_STATUS' }) }],
    }]
  } } })(input(cwd))
  t.after(() => hooks.dispose())
  await seed(runtime)
  const ctx = { directory: cwd, sessionID: 'ses_test', messageID: 'msg_test', abort: new AbortController().signal, ask: async () => { throw new Error('denied') } }
  const results = await Promise.allSettled([hooks.tool.kinex_call.execute({ name: 'world', arguments: {} }, ctx), hooks.tool.kinex_call.execute({ name: 'world', arguments: {} }, ctx)])
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(executions, 0)
  await hooks['chat.message']({ sessionID: ctx.sessionID })
  assert.equal((await hooks.tool.kinex_call.execute({ name: 'world', arguments: {} }, { ...ctx, ask: async () => {} })).output, 'WORLD')
  available = false
  assert.doesNotMatch(await hooks.tool.kinex_tools.execute({}, ctx), /"name":"world"/)
  await assert.rejects(hooks.tool.kinex_call.execute({ name: 'world', arguments: {} }, ctx), /Unknown/)
  const [endpoint] = await endpoints(cwd)
  const connection = { signal: ctx.abort, confirm: async () => false }
  const request = (command, args) => requestCommand(endpoint, { method: 'execute', directory: cwd, sessionID: ctx.sessionID, command, args }, connection)
  assert.equal((await request('world-status', '')).text, 'WORLD_STATUS')
  await request('load', 'sensor')
  assert.equal((await runtime.devices.list())[0].loaded, true)
  assert.equal((await request('unregister', 'sensor')).text, 'Cancelled')
  assert.equal((await runtime.devices.list()).length, 1)
  await assert.rejects(requestCommand(endpoint, { method: 'execute', directory: '/wrong', sessionID: ctx.sessionID, command: 'load', args: 'sensor' }, connection), /workspace mismatch/)
})

test('OpenCode context projection is append-only, survives reopen, and resets after compaction', async t => {
  const cwd = await workspace(t)
  const runtime = createKinexRuntime({ directory: cwd })
  t.after(() => runtime.dispose())
  const caps = composeContributions([coreContribution(runtime)])
  const user = { info: { id: 'msg_user', sessionID: 'ses_test', role: 'user', agent: 'build', model: { providerID: 'fake', modelID: 'test' }, time: { created: 1 } }, parts: [{ type: 'text', text: 'go' }] }
  const messages = [user]
  await projectContext(cwd, messages, caps)
  const first = structuredClone(messages)
  const assistant = { info: { id: 'msg_reply', sessionID: 'ses_test', role: 'assistant', time: { created: 2 } }, parts: [{ type: 'text', text: 'done' }] }
  await seed(runtime)
  await mkdir(path.join(cwd, '.kinex/tool'), { recursive: true })
  await writeFile(path.join(cwd, '.kinex/tool/context_probe.js'), "export default { description: 'context probe', execute: async () => ({ title: 'probe', output: 'ok' }) }")
  const next = [user, assistant]
  await projectContext(cwd, next, caps)
  assert.deepEqual(next.slice(0, first.length), first)
  assert.equal(next.length, 4)
  const resumed = [user, assistant]
  await projectContext(cwd, resumed, caps)
  assert.deepEqual(resumed, next)
  const compacted = [{ ...assistant, info: { ...assistant.info, id: 'msg_summary', summary: true } }, { ...user, info: { ...user.info, id: 'msg_continue' } }]
  await projectContext(cwd, compacted, caps)
  assert.equal(compacted.length, 3)
  assert.match(compacted.at(-1).parts[0].text, /context_probe/)
})

test('OpenCode context storage preserves ancestor robotics workspace discovery', async t => {
  const parent = await workspace(t)
  const core = createKinexRuntime({ directory: parent })
  await seed(core)
  await core.dispose()
  const cwd = path.join(parent, 'nested')
  await mkdir(cwd)
  const runtime = createKinexRuntime({ directory: cwd })
  t.after(() => runtime.dispose())
  const capabilities = composeContributions([coreContribution(runtime)])
  const before = await runtime.context()
  const user = { info: { id: 'msg_nested', sessionID: 'ses_nested', role: 'user', agent: 'build', model: { providerID: 'fake', modelID: 'test' }, time: { created: 1 } }, parts: [{ type: 'text', text: 'go' }] }
  await projectContext(cwd, [user], capabilities)
  assert.deepEqual(await runtime.context(), before)
  assert.equal((await runtime.devices.list())[0].name, 'sensor')
  await assert.rejects(stat(path.join(cwd, '.kinex')), { code: 'ENOENT' })
  assert.ok((await stat(path.join(parent, '.kinex/agent/opencode/context/ses_nested.json'))).isFile())
})

test('real OpenCode loads the server plugin, exposes tools, and runs direct commands without a model', { timeout: 120000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const core = createKinexRuntime({ directory: cwd })
  await seed(core)
  await core.dispose()
  const host = await startOpenCode(t, cwd, isolation.root)
  const response = await fetch(`${host.baseUrl}/experimental/tool/ids?directory=${encodeURIComponent(cwd)}`)
  const tools = await response.json()
  assert.ok(tools.includes('kinex_call'), JSON.stringify(tools) + host.logs())
  const [endpoint] = await endpoints(cwd)
  assert.ok(endpoint, host.logs())
  const connection = { signal: new AbortController().signal, confirm: async () => true }
  const request = (command, args) => requestCommand(endpoint, { method: 'execute', sessionID: host.session.id, directory: cwd, command, args }, connection)
  assert.match((await request('load', 'sensor')).text, /loaded/)
  assert.match((await request('devices', '')).text, /sensor.*loaded/)
  assert.match((await request('unload', 'sensor')).text, /unloaded/)
  assert.equal(fake.requests.length, 0)
  fake.steps.push({ tool: 'kinex_tools', args: {} }, { text: 'tools discovered' })
  await host.client.session.prompt({ path: { id: host.session.id }, body: { parts: [{ type: 'text', text: 'Discover the robotics tools' }] }, throwOnError: true })
  assert.ok(fake.requests.length >= 2, host.logs())
  assert.match(JSON.stringify(fake.requests.at(-1)), /kinex_context/)
  const start = fake.requests.length
  fake.steps.push(
    { tool: 'write', args: { filePath: path.join(cwd, '.kinex/tool/fresh.ts'), content: `export default {description:'fresh tool',execute:async()=>({title:'fresh',output:'OPENCODE_FRESH_OK'})}` } },
    { tool: 'kinex_call', args: { name: 'fresh', arguments: {} } },
    { text: 'fresh completed' },
  )
  await host.client.session.prompt({ path: { id: host.session.id }, body: { parts: [{ type: 'text', text: 'Create a new robotics tool and call it now' }] }, throwOnError: true })
  assert.equal(fake.requests.length - start, 3)
  assert.match(JSON.stringify(fake.requests.at(-1)), /OPENCODE_FRESH_OK/)
  assert.deepEqual(fake.requests[start].tools, fake.requests[start + 1].tools)
  assert.deepEqual(fake.requests[start + 1].messages.slice(0, fake.requests[start].messages.length), fake.requests[start].messages)
  await host.client.session.summarize({ path: { id: host.session.id }, body: { providerID: 'fake', modelID: 'test' }, throwOnError: true })
  await host.client.session.prompt({ path: { id: host.session.id }, body: { parts: [{ type: 'text', text: 'Continue after compaction' }] }, throwOnError: true })
  assert.match(JSON.stringify(fake.requests.at(-1)), /kinex_context[\s\S]*fresh/)
})

test('OpenCode command cancellation, confirmation cleanup and failed startup release resources', async t => {
  const cwd = await workspace(t)
  let started
  const running = new Promise(resolve => { started = resolve })
  let cancelled = false
  const hooks = await createOpenCodePlugin({ composition: { contributions: core => [coreContribution(core), {
    id: 'world', commands: [{ name: 'slow', arguments: '', description: 'slow command', kind: 'operation', execute: async (_args, context) => {
      started()
      await new Promise(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }))
      context.signal.throwIfAborted()
    } }],
  }] } })(input(cwd))
  const [endpoint] = await endpoints(cwd)
  const abort = new AbortController()
  const request = requestCommand(endpoint, { method: 'execute', sessionID: 'ses_test', directory: cwd, command: 'slow', args: '' }, { signal: abort.signal, confirm: async () => false })
  const rejected = assert.rejects(request, /cancelled|closed/)
  await running
  abort.abort()
  await rejected
  await hooks.dispose()
  assert.equal(cancelled, true)
  assert.deepEqual(await endpoints(cwd), [])
  await assert.rejects(createOpenCodePlugin({ composition: { contributions: () => [{ id: 'duplicate' }, { id: 'duplicate' }] } })(input(cwd)), /duplicate/i)
  assert.deepEqual(await endpoints(cwd), [])
})

test('OpenCode images retain bytes and active recordings remain owned by their session', async t => {
  const cwd = await workspace(t)
  const frame = path.join(cwd, 'frame.png')
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5KsAAAAASUVORK5CYII=', 'base64')
  await writeFile(frame, bytes)
  let runtime
  const hooks = await createOpenCodePlugin({ composition: { contributions: core => {
    runtime = core
    return [coreContribution(core), { id: 'vision', tools: {
      list: async () => ({ tools: [{ name: 'frame', description: 'frame', inputSchema: { type: 'object' } }], problems: [] }),
      call: async () => ({ title: 'frame', output: 'frame captured', attachments: [{ path: frame, mime: 'image/png' }] }),
    } }]
  } } })(input(cwd))
  t.after(() => hooks.dispose())
  const signal = new AbortController().signal
  const result = await hooks.tool.kinex_call.execute({ name: 'frame', arguments: {} }, { sessionID: 'ses_first', messageID: 'msg_frame', directory: cwd, abort: signal, ask: async () => {} })
  await writeFile(frame, 'changed')
  assert.equal(result.attachments[0].url, `data:image/png;base64,${bytes.toString('base64')}`)
  await seed(runtime)
  const [endpoint] = await endpoints(cwd)
  const command = (sessionID, name, args) => requestCommand(endpoint, { method: 'execute', sessionID, directory: cwd, command: name, args }, { signal, confirm: async () => true })
  await command('ses_first', 'load', 'sensor')
  await command('ses_first', 'record', 'start sensor=2 recording test')
  assert.ok(await runtime.recording.status())
  await assert.rejects(command('ses_second', 'record', 'stop'), /Another session/)
  await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'ses_first' } } } })
  assert.equal(await runtime.recording.status(), undefined)
})

test('default OpenCode composition exposes setup while retaining host approvals and lazy discovery', async t => {
  const cwd = await workspace(t)
  const hooks = await createOpenCodePlugin()(input(cwd))
  t.after(() => hooks.dispose())
  let permissions = []
  const ctx = { directory: cwd, sessionID: 'ses_setup', messageID: 'msg_setup', abort: new AbortController().signal, ask: async request => { permissions.push(request.permission) } }
  const discovery = JSON.parse(await hooks.tool.kinex_tools.execute({}, ctx))
  assert.ok(discovery.tools.some(tool => tool.name === 'setup_plan'))
  assert.ok(discovery.skills.some(skill => skill.name === 'onboard-ros2'))
  await assert.rejects(stat(path.join(cwd, '.kinex')), { code: 'ENOENT' })
  const [endpoint] = await endpoints(cwd)
  const { commands } = await requestCommand(endpoint, { method: 'describe', sessionID: '', directory: cwd, args: '' }, { signal: ctx.abort })
  assert.ok(commands.some(command => command.name === 'onboarding'))
  const result = await hooks.tool.kinex_call.execute({ name: 'setup_plan', arguments: { action: 'save', revision: 0, plan: { version: 1, nodes: [], task: null } } }, ctx)
  assert.ok(!result.metadata.kinex.isError)
  assert.deepEqual(permissions, ['setup_plan'])
  await writeFile(path.join(cwd, 'kinex.json'), JSON.stringify({ permission: { setup_plan: 'deny' } }))
  await assert.rejects(hooks.tool.kinex_call.execute({ name: 'setup_plan', arguments: { action: 'select', revision: result.metadata.revision, task: null } }, ctx), /PermissionDeniedError/)
  assert.deepEqual(permissions, ['setup_plan'])
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})
