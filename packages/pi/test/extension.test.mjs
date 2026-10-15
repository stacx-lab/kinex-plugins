import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isolate, fakeProvider, workspace } from '../../../test/helpers.mjs'
const isolation = await isolate(); after(isolation.cleanup)
const { createAgentSession, createMcpExtension, DefaultResourceLoader, SessionManager } = await import('@earendil-works/pi-coding-agent')
const { default: kinex } = await import('../dist/index.js')
const { endpoints, requestCommand } = await import('@kinex/mcp/control')

test('real Pi registers shared MCP, starts inactive, uses direct lifecycle commands and permission dialogs', { timeout: 45000 }, async t => {
  const cwd = await workspace(t), fake = await fakeProvider(t, isolation.root)
  const agentDir = path.join(isolation.root, 'config/agent')
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createMcpExtension(), { name: 'kinex-test', factory: kinex }] })
  await loader.reload()
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory() })
  assert.deepEqual(extensionsResult.errors, [])
  let questions = 0
  const errors = []
  await session.bindExtensions({ mode: 'interactive', uiContext: {
    notify() {}, setStatus() {}, select: async () => { questions++; return 'Yes' }, input: async () => 'answer',
  }, onError: error => errors.push(error.error) })
  t.after(async () => { await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose() })
  for (let i = 0; i < 200 && !session.getAllTools().some(tool => tool.name === 'mcp__kinex__kinex_status'); i++) await delay(25)
  assert.ok(session.getAllTools().some(tool => tool.name === 'mcp__kinex__kinex_status'), JSON.stringify(errors))
  const endpoint = (await endpoints(cwd))[0]
  const control = command => requestCommand(endpoint, { method: 'execute', directory: cwd, command, args: '' }, { signal: new AbortController().signal, confirm: async () => false })
  assert.equal(JSON.parse((await control('status')).text).state, 'inactive')
  await assert.rejects(stat(path.join(cwd, '.kinex')), { code: 'ENOENT' })
  await session.prompt('/kinex-start')
  assert.equal(JSON.parse((await control('status')).text).state, 'active')
  assert.equal(fake.requests.length, 0)
  await session.prompt('/kinex-end')
  assert.equal(JSON.parse((await control('status')).text).state, 'inactive')
  fake.steps.push({ tool: 'mcp__kinex__kinex_start', args: {} }, { text: 'STARTED' })
  await session.prompt('Start Kinex')
  assert.equal(questions, 1)
  assert.equal(JSON.parse((await control('status')).text).state, 'active')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
  assert.equal((await endpoints(cwd)).length, 0)
})
