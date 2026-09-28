import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isolate, workspace, seed } from '../../../test/helpers.mjs'
import { entry } from './helpers.mjs'
const isolation = await isolate()
after(isolation.cleanup)
const { createKinexRuntime } = await import('@kinex/core')
const exec = promisify(execFile)

for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} cancels active driver work, finalizes capture and removes the control endpoint`, { timeout: 20000 }, async t => {
  const directory = await workspace(t)
  const core = createKinexRuntime({ directory }); await seed(core)
  await core.profiles.writeDevice({ name: 'sensor', loaded: true, access: { connection: { kind: 'process' }, driver: { interpreter: 'python3', persistent: true, actions: ['load', 'read', 'status', 'stop', 'unload'], timeout_s: 60 } } })
  const driver = path.join(directory, '.kinex/devices/sensor')
  await writeFile(path.join(driver, 'driver.py'), `import os,time\nfrom kinex.driver_protocol import run\ndef dispatch(action,args):\n if args.get('sleep'):\n  open('busy','w').write('busy')\n  time.sleep(30)\n return {'ok':True,'pid':os.getpid()}\nrun(dispatch,lambda:None)\n`)
  await writeFile(path.join(directory, 'kinex.json'), JSON.stringify({ permission: { device_read: 'allow' } }))
  await core.dispose()
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'serve', '--directory', directory], env: process.env, stderr: 'pipe' })
  const client = new Client({ name: 'shutdown', version: '1' })
  t.after(() => client.close())
  await client.connect(transport)
  const call = args => client.callTool({ name: 'kinex_call', arguments: { name: 'device', arguments: { deviceID: 'sensor', compact: true, ...args } } })
  const reading = await call({})
  assert.ok(!reading.isError)
  const pid = JSON.parse(reading.structuredContent.output).pid
  const command = (...args) => exec(process.execPath, [entry, 'control', '--directory', directory, ...args], { timeout: 5000 })
  const recording = JSON.parse((await command('record', 'start', 'sensor=10')).stdout)
  const pending = Promise.allSettled([call({ args: { sleep: true } })])
  const deadline = Date.now() + 5000
  let busy = false
  while (Date.now() < deadline && !busy) { busy = await readFile(path.join(driver, 'busy')).then(() => true, () => false); if (!busy) await delay(20) }
  assert.ok(busy)
  const closed = new Promise(resolve => { client.onclose = resolve })
  process.kill(transport.pid, signal)
  await closed; await pending; await client.close()
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const manifest = JSON.parse(await readFile(path.join(directory, '.kinex/recordings', recording.manifest.id, 'recording.json'), 'utf8'))
  assert.equal(manifest.status, 'stopped'); assert.equal(manifest.endedBy, 'exit')
  await assert.rejects(command('devices'), /No matching Kinex server/)
})
