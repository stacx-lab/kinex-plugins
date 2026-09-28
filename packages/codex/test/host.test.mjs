import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolate, workspace, seed } from '../../../test/helpers.mjs'
import { codexHost, responsesProvider, entry } from './helpers.mjs'
const isolated = await isolate()
after(isolated.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const exec = promisify(execFile)

test('real Codex loads MCP, forwards approvals, calls tools and refreshes context across turns', { timeout: 120000 }, async t => {
  const directory = await workspace(t)
  const runtime = createKinexRuntime({ directory }); await seed(runtime); await runtime.dispose()
  const provider = await responsesProvider(t)
  const host = await codexHost(t, directory, provider)
  const tool = (name, args = {}) => host.request('mcpServer/tool/call', { threadId: host.thread.id, server: 'kinex', tool: name, arguments: args })
  const catalog = await tool('kinex_tools')
  assert.ok(catalog.structuredContent.tools.some(tool => tool.name === 'device'))
  let approvals = 0, allow = false
  host.handlers.set('mcpServer/elicitation/request', () => { approvals++; return allow ? { action: 'accept', content: { allow: true } } : { action: 'decline', content: null } })
  const load = () => tool('kinex_call', { name: 'device', arguments: { deviceID: 'sensor', action: 'load' } })
  assert.equal((await load()).isError, true)
  allow = true
  assert.ok(!(await load()).isError)
  assert.equal(approvals, 2)
  const control = (...args) => exec(process.execPath, [entry, 'control', '--directory', directory, ...args], { env: host.env, timeout: 10000 })
  assert.match((await control('devices')).stdout, /sensor: other, loaded/)
  assert.equal(provider.requests.length, 0)
  await control('record', 'start', 'sensor=20')
  const status = JSON.parse((await control('record', 'status')).stdout)
  assert.equal(status.active.status, 'recording')
  assert.ok(!(await tool('kinex_call', { name: 'device', arguments: { deviceID: 'sensor' } })).isError)
  await control('record', 'stop')
  const manifest = JSON.parse(await readFile(path.join(directory, '.kinex/recordings', status.active.id, 'recording.json'), 'utf8'))
  assert.equal(manifest.status, 'stopped')
  const pty = fileURLToPath(new URL('../../../test/fixtures/tui_pty.py', import.meta.url))
  const { stdout } = await exec('python3', [pty, process.execPath, entry, 'control', '--directory', directory, 'devices'], { env: host.env, timeout: 15000 })
  assert.match(stdout, /sensor: other, loaded/)
  assert.equal(provider.requests.length, 0)
  // Real model requests use a local Responses SSE provider, without credentials.
  provider.steps.push({ search: true }, { name: 'kinex_tools', arguments: {} }, { text: 'KINEX_CODEX_DONE' })
  const first = await host.request('turn/start', { threadId: host.thread.id, input: [{ type: 'text', text: 'Inspect current Kinex tools and devices.' }] })
  await host.wait(value => value.method === 'turn/completed' && value.params.turn.id === first.turn.id)
  assert.ok(provider.requests.length >= 2, JSON.stringify(host.notifications.slice(-10)))
  assert.match(JSON.stringify(provider.requests.at(-1).input.filter(item => item.type === 'function_call_output')), /core.devices|sensor/)
  await mkdir(path.join(directory, '.kinex/tool'), { recursive: true })
  await writeFile(path.join(directory, '.kinex/tool/live.js'), "export default { description: 'live', execute: async () => ({title:'live',output:'LIVE_CODEX_RESULT'}) }")
  provider.steps.push({ search: true }, { name: 'kinex_tools', arguments: {} }, { name: 'kinex_call', arguments: { name: 'live', arguments: {} } }, { text: 'REFRESH_DONE' })
  const second = await host.request('turn/start', { threadId: host.thread.id, input: [{ type: 'text', text: 'Refresh tools and invoke live.' }] })
  await host.wait(value => value.method === 'turn/completed' && value.params.turn.id === second.turn.id)
  assert.match(JSON.stringify(provider.requests.at(-1)), /LIVE_CODEX_RESULT/)
  const beforeDelete = provider.requests.length
  assert.match((await control('unregister', 'sensor')).stdout, /Cancelled/)
  const deleted = await exec('python3', [pty, process.execPath, entry, 'control', '--directory', directory, 'unregister', 'sensor'], {
    env: { ...host.env, TUI_TEST_TRIGGER: 'Type yes to confirm', TUI_TEST_KEYS: JSON.stringify([[0.1, 'yes\r']]) }, timeout: 15000,
  })
  assert.match(deleted.stdout, /sensor unregistered/)
  assert.equal(provider.requests.length, beforeDelete)
})
