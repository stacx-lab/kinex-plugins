import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { isolate, fakeProvider, workspace, seed } from '../../../test/helpers.mjs'
import { startOpenCode } from './helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const exec = promisify(execFile)

test('real OpenCode TUI loads the plugin and displays a direct device command', { timeout: 120000 }, async t => {
  const cwd = await workspace(t)
  const fake = await fakeProvider(t, isolation.root)
  const core = createKinexRuntime({ directory: cwd })
  await seed(core)
  await core.dispose()
  await mkdir(path.join(cwd, '.opencode'), { recursive: true })
  await writeFile(path.join(cwd, '.opencode/tui.json'), JSON.stringify({ plugin: [pathToFileURL(fileURLToPath(new URL('../dist/tui.js', import.meta.url))).href] }))
  const host = await startOpenCode(t, cwd, isolation.root)
  const pty = fileURLToPath(new URL('../../../test/fixtures/tui_pty.py', import.meta.url))
  const { stdout, stderr } = await exec('python3', [pty, host.binary, 'attach', host.baseUrl, '--session', host.session.id, '--dir', cwd], {
    cwd, timeout: 65000, maxBuffer: 8 * 1024 * 1024,
    env: { ...host.env, TERM: 'xterm-256color', TUI_TEST_TIMEOUT: '60', TUI_TEST_TRIGGER: 'Kinex connected', TUI_TEST_KEYS: JSON.stringify([
      [1, '/kinex-devices'], [0.7, '\r'], [1, '\x1b'],
      [0.5, '/kinex-load'], [0.7, '\r'], [0.7, '\r'], [1, '\x1b'],
      [0.5, '/kinex-unload'], [0.7, '\r'], [0.7, '\r'], [1, '\x1b'],
      [0.5, '\x03'], [0.5, '\x03'],
    ]) },
  })
  assert.match(stdout, /sensor/)
  assert.match(stdout, /unloaded/)
  assert.doesNotMatch(stdout + stderr, /TypeError|ReferenceError|MODULE_NOT_FOUND/)
  assert.equal(fake.requests.length, 0)
})
