import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isolate, fakeProvider, workspace } from '../../../test/helpers.mjs'
const isolation = await isolate(); after(isolation.cleanup)
const { createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager } = await import('@earendil-works/pi-coding-agent')
const { default: kinex } = await import('../dist/index.js')
const { endpoints, requestCommand } = await import('@kinex/mcp/control')

async function piSession(t, permissionMode) {
  const cwd = await workspace(t), fake = await fakeProvider(t, isolation.root)
  const agentDir = path.join(isolation.root, 'config/agent')
  // Deterministic permission extension using the same tool_call gate as pi-automode.
  const gate = { enabled: true, allow: true, calls: [] }
  const permissionExtension = pi => pi.on('tool_call', event => {
    if (!gate.enabled || event.toolName !== 'mcp__kinex__kinex_call') return
    gate.calls.push(structuredClone(event.input))
    if (!gate.allow) return { block: true, reason: 'Blocked by Pi permission gate' }
  })
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createMcpExtension(), { name: 'kinex-test', factory: kinex }, { name: 'permission-test', factory: permissionExtension }] })
  await loader.reload()
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory() })
  assert.deepEqual(extensionsResult.errors, [])
  if (permissionMode) session.extensionRunner.setFlagValue('kinex-permission-mode', permissionMode)
  const ui = { questions: 0, answer: 'Yes' }, errors = []
  await session.bindExtensions({ mode: 'interactive', uiContext: {
    notify() {}, setStatus() {}, select: async () => { ui.questions++; return ui.answer }, input: async () => 'answer',
  }, onError: error => errors.push(error.error) })
  t.after(async () => { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose() })
  for (let i = 0; i < 200 && !session.getAllTools().some(tool => tool.name === 'mcp__kinex__kinex_status'); i++) await delay(25)
  assert.ok(session.getAllTools().some(tool => tool.name === 'mcp__kinex__kinex_status'), JSON.stringify(errors))
  const endpoint = (await endpoints(cwd))[0]
  const control = command => requestCommand(endpoint, { method: 'execute', directory: cwd, command, args: '' }, { signal: new AbortController().signal, confirm: async () => false })
  const status = async () => JSON.parse((await control('status')).text)
  const call = async (tool, args = {}) => {
    fake.steps.push({ tool, args }, { text: 'DONE' })
    await session.prompt(tool === 'mcp__kinex__kinex_start' ? 'Start Kinex' : 'Run the requested Kinex operation.')
  }
  return { cwd, fake, session, gate, ui, errors, status, call }
}

test('real Pi starts inactive with host permissions and retains explicit Kinex dialogs', { timeout: 45000 }, async t => {
  const f = await piSession(t)
  assert.equal((await f.status()).state, 'inactive')
  assert.equal((await f.status()).permissionMode, 'host')
  await assert.rejects(stat(path.join(f.cwd, '.kinex')), { code: 'ENOENT' })
  await f.session.prompt('/kinex-start')
  assert.equal((await f.status()).state, 'active')
  assert.equal(f.fake.requests.length, 0)
  await f.session.prompt('/kinex-end')
  assert.equal((await f.status()).state, 'inactive')
  await f.call('mcp__kinex__kinex_start')
  assert.equal(f.ui.questions, 0)
  assert.equal((await f.status()).state, 'active')
  await f.session.prompt('/kinex-end')
  await writeFile(path.join(f.cwd, 'kinex.json'), JSON.stringify({ permission: { runtime_start: 'ask' } }))
  await f.call('mcp__kinex__kinex_start')
  assert.equal(f.ui.questions, 1)
  assert.equal((await f.status()).state, 'active')
  assert.equal(f.errors.length, 0, JSON.stringify(f.errors))
  await f.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.equal((await endpoints(f.cwd)).length, 0)
})

test('Pi permission hooks see complete exec input and can approve or block without a second Kinex prompt', { timeout: 45000 }, async t => {
  const f = await piSession(t)
  await f.call('mcp__kinex__kinex_start')
  const input = { name: 'exec', arguments: { interpreter: 'python3', python: 'with open("executed", "a") as file: file.write("x")' } }
  const exec = () => f.call('mcp__kinex__kinex_call', input)
  const marker = path.join(f.cwd, 'executed')
  f.gate.allow = false
  await exec()
  await assert.rejects(stat(marker), { code: 'ENOENT' })
  await assert.rejects(stat(path.join(f.cwd, '.kinex/python')), { code: 'ENOENT' })
  assert.deepEqual(f.gate.calls[0], input)
  f.gate.allow = true
  await exec(); await exec()
  assert.equal(await readFile(marker, 'utf8'), 'xx')
  assert.equal(f.ui.questions, 0)
  f.gate.allow = false
  await exec()
  assert.equal(await readFile(marker, 'utf8'), 'xx')
  f.gate.enabled = false // Native Pi allows calls when no permission extension blocks them.
  await exec()
  assert.equal(await readFile(marker, 'utf8'), 'xxx')
  assert.equal(f.ui.questions, 0)
  await writeFile(path.join(f.cwd, 'kinex.json'), JSON.stringify({ permission: { python_tool_controller: 'deny' } }))
  await exec()
  assert.equal(await readFile(marker, 'utf8'), 'xxx')
  assert.equal(f.ui.questions, 0)
  assert.deepEqual(f.errors, [])
})

test('Pi can opt back into Kinex-managed permissions', { timeout: 45000 }, async t => {
  const f = await piSession(t, 'kinex')
  assert.equal((await f.status()).permissionMode, 'kinex')
  await f.call('mcp__kinex__kinex_start')
  assert.equal(f.ui.questions, 1)
  f.ui.answer = 'No'
  await f.call('mcp__kinex__kinex_call', { name: 'exec', arguments: { interpreter: 'python3', python: 'open("executed", "w").close()' } })
  assert.equal(f.ui.questions, 2)
  await assert.rejects(stat(path.join(f.cwd, 'executed')), { code: 'ENOENT' })
})
