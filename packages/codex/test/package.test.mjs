import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rename, stat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isolate, workspace, seed } from '../../../test/helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))

test('Core, setup and Codex tarballs install alone, relocate and dispose a shared recording on stdio EOF', { timeout: 120000 }, async t => {
  const directory = await workspace(t)
  const pack = async name => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: path.join(root, 'packages', name) })
    return path.join(directory, JSON.parse(stdout)[0].filename)
  }
  const snapshot = JSON.parse(await readFile(path.join(root, 'vendor/core.json'), 'utf8'))
  const core = path.join(root, 'vendor', snapshot.file), codex = await pack('codex')
  const setupSnapshot = JSON.parse(await readFile(path.join(root, 'vendor/setup.json'), 'utf8'))
  const setup = path.join(root, 'vendor', setupSnapshot.file)
  const original = path.join(directory, 'original'), moved = path.join(directory, 'moved')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', original, core, setup, codex])
  await rename(original, moved)
  for (const name of ['kinex', '@kinex/pi', '@kinex/opencode']) await assert.rejects(stat(path.join(moved, 'node_modules', name)), { code: 'ENOENT' })
  const cwd = path.join(directory, 'robot'); await mkdir(cwd)
  const runtime = createKinexRuntime({ directory: cwd }); await seed(runtime); await runtime.dispose()
  const entry = path.join(moved, 'node_modules/@kinex/codex/bin/kinex-codex.mjs')
  const manifestVersion = JSON.parse(await readFile(path.join(moved, 'node_modules/@kinex/codex/package.json'), 'utf8')).version
  assert.equal((await exec(process.execPath, [entry, '--version'])).stdout.trim(), manifestVersion)
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'))
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'serve', '--directory', cwd], cwd: moved, env, stderr: 'pipe' })
  const client = new Client({ name: 'package-test', version: '1' })
  t.after(() => client.close())
  await client.connect(transport)
  const result = await client.callTool({ name: 'kinex_tools', arguments: { skill: 'setup-device' } })
  assert.ok(result.structuredContent.skill.content.length > 100)
  assert.ok(result.structuredContent.tools.some(tool => tool.name === 'setup_plan'))
  assert.ok(result.structuredContent.workflows.some(command => command.name === 'onboarding'))
  const ros = await client.callTool({ name: 'kinex_tools', arguments: { skill: 'onboard-ros2' } })
  assert.ok(ros.structuredContent.skill.content.length > 100)
  const plan = await client.callTool({ name: 'kinex_call', arguments: { name: 'setup_plan', arguments: { action: 'read' } } })
  assert.ok(!plan.isError)
  assert.equal(client.getServerVersion().version, manifestVersion)
  const command = (...args) => exec(process.execPath, [entry, 'control', '--directory', cwd, ...args], { env, timeout: 10000 })
  await command('load', 'sensor')
  const reading = await client.callTool({ name: 'kinex_call', arguments: { name: 'device', arguments: { deviceID: 'sensor' } } })
  assert.ok(!reading.isError)
  const recording = JSON.parse((await command('record', 'start', 'sensor=20')).stdout)
  const processID = transport.pid
  await client.close()
  assert.throws(() => process.kill(processID, 0), { code: 'ESRCH' })
  const manifest = JSON.parse(await readFile(path.join(cwd, '.kinex/recordings', recording.manifest.id, 'recording.json'), 'utf8'))
  assert.equal(manifest.status, 'stopped'); assert.equal(manifest.endedBy, 'exit')
  await assert.rejects(command('devices'), /No matching Kinex server/)
  await assert.rejects(stat(path.join(cwd, '.kinex/python')), { code: 'ENOENT' })
})
