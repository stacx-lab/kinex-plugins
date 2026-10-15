import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cp, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolate, workspace, seed } from '../../../test/helpers.mjs'
import { entry } from './helpers.mjs'
const isolated = await isolate(); after(isolated.cleanup)
const exec = promisify(execFile), root = fileURLToPath(new URL('../../../', import.meta.url))
const { createKinexRuntime } = await import('@kinex/core')
const { endpoints } = await import('../dist/ipc.js')

test('real Claude plugin loads skills and MCP, starts explicitly, ends/restarts, and cleans recording on exit', { timeout: 90000 }, async t => {
  const directory = await workspace(t), plugin = path.join(directory, 'plugin')
  await cp(path.join(root, 'plugins/kinex'), plugin, { recursive: true })
  // Test the release plugin with the local unpublished server instead of contacting npm.
  const configFile = path.join(plugin, '.mcp.json')
  const mcpConfig = JSON.parse(await readFile(configFile, 'utf8'))
  const server = mcpConfig.mcpServers.kinex
  server.command = process.execPath
  server.args = [entry, ...server.args.slice(server.args.indexOf('serve')), '--directory', directory]
  await writeFile(configFile, JSON.stringify(mcpConfig))
  const runtime = createKinexRuntime({ directory }); await seed(runtime); await runtime.dispose()
  const steps = [ ['kinex_status', {}], ['kinex_start', {}], ['kinex_call', { name: 'device', arguments: { deviceID: 'sensor', action: 'load' } }],
    ['kinex_tools', {}], ['kinex_shutdown', {}], ['kinex_status', {}], ['kinex_start', {}] ]
  const requests = [], failures = []
  let recordingID
  const provider = createServer(async (req, res) => {
    try {
      if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return }
      let body = ''; for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      const agentRequest = request.tools?.some(tool => tool.name.endsWith("__kinex_status"))
      if (agentRequest) requests.push(request)
      const step = agentRequest ? steps.shift() : undefined, id = `msg_${requests.length}`
      const name = step && request.tools?.find(tool => tool.name.endsWith(`__${step[0]}`))?.name
      if (step && !name) throw new Error(`Missing ${step[0]} in ${request.tools?.map(tool => tool.name)}`)
      if (agentRequest && !step && !recordingID) {
        const { stdout } = await exec(process.execPath, [entry, 'control', '--directory', directory, 'record', 'start', 'sensor=10'], { timeout: 10000 })
        recordingID = JSON.parse(stdout).manifest.id
      }
      const block = step ? { type: 'tool_use', id: `tool_${requests.length}`, name, input: step[1] } : { type: 'text', text: 'KINEX_CLAUDE_DONE' }
      const message = { id, type: 'message', role: 'assistant', model: request.model, content: [block], stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
      if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
      send('message_start', { message: { ...message, content: [], stop_reason: null } })
      send('content_block_start', { index: 0, content_block: step ? { ...block, input: {} } : { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: step ? { type: 'input_json_delta', partial_json: JSON.stringify(step[1]) } : { type: 'text_delta', text: block.text } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } })
      send('message_stop', {}); res.end()
    } catch (error) { failures.push(String(error)); res.writeHead(400); res.end(String(error)) }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); return new Promise(resolve => provider.close(resolve)) })
  const config = path.join(directory, 'claude-config'); await mkdir(config)
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8', CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'fake-test-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', ENABLE_TOOL_SEARCH: 'false',
    KINEX_CONFIG_DIR: process.env.KINEX_CONFIG_DIR, KINEX_DATA_DIR: process.env.KINEX_DATA_DIR }
  const binary = process.env.KINEX_CLAUDE_BINARY ?? path.join(root, 'node_modules/.bin/claude')
  const child = exec(binary, ['-p', '--output-format', 'json', '--model', 'claude-sonnet-4-6',
    '--plugin-dir', plugin, '--permission-mode', 'default', '--setting-sources', '', '--tools', 'Skill', '--allowedTools', ['kinex_status', 'kinex_start', 'kinex_call', 'kinex_tools', 'kinex_shutdown'].map(name => `mcp__plugin_kinex_kinex__${name}`).join(','), '--no-session-persistence', '--max-turns', '12',
    '--', 'Start Kinex, inspect devices, end Kinex, then start again.'], { cwd: directory, env, timeout: 45000, maxBuffer: 5 * 1024 * 1024 })
  child.child.stdin.end()
  const { stdout } = await child.catch(error => { throw new Error(`${error.message}\nProvider failures: ${JSON.stringify(failures)}\nRequests: ${requests.length}\n${error.stdout}`) })
  assert.deepEqual(failures, [])
  assert.match(stdout, /KINEX_CLAUDE_DONE/)
  assert.equal(steps.length, 0)
  assert.match(JSON.stringify(requests[0]), /kinex-start/)
  const outputs = JSON.stringify(requests.at(-1).messages)
  assert.match(outputs, /permissionMode.*host/)
  assert.doesNotMatch(outputs, /PermissionDeniedError/)
  assert.match(outputs, /inactive/); assert.match(outputs, /active/); assert.match(outputs, /setup_plan/)
  assert.equal((await endpoints(directory)).length, 0)
  const manifest = JSON.parse(await readFile(path.join(directory, '.kinex/recordings', recordingID, 'recording.json'), 'utf8'))
  assert.equal(manifest.status, 'stopped')
})
