import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const fixture = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
const python3 = () => execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()

export async function isolate() {
  const root = await mkdtemp(path.join(tmpdir(), 'kinex-sdk-'))
  process.env.KINEX_CONFIG_DIR = path.join(root, 'config')
  process.env.KINEX_DATA_DIR = path.join(root, 'data')
  // Kinex Python defaults to Pixi-provisioned ROS; tests use the uv provider and never provision it.
  await mkdir(process.env.KINEX_CONFIG_DIR, { recursive: true })
  await writeFile(path.join(process.env.KINEX_CONFIG_DIR, 'kinex.json'), JSON.stringify({ python: { provider: 'uv' } }))
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'config', 'agent')
  process.env.PI_SKIP_VERSION_CHECK = '1'
  process.env.PI_TELEMETRY = '0'
  for (const name of Object.keys(process.env)) if (name.endsWith('API_KEY') || name.endsWith('API_TOKEN')) delete process.env[name]
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

export async function fakeProvider(t, root) {
  const requests = []
  const steps = []
  const fake = { requests, steps, respond: undefined }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    requests.push(request)
    const step = steps.shift() ?? await fake.respond?.(request) ?? { text: 'FAKE_REPLY_OK' }
    if (step.status) { res.writeHead(step.status); res.end(step.body ?? 'retry'); return }
    if (step.wait) { await step.wait; if (res.destroyed) return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: `response-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'test' }
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (step.tool || step.tools) {
      const calls = step.tools ?? [{ name: step.tool, args: step.args }]
      send({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })) })
      send({}, 'tool_calls')
    } else { send({ role: 'assistant', content: step.text ?? 'FAKE_REPLY_OK' }); send({}, 'stop') }
    res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: step.inputTokens ?? 1000, completion_tokens: 20, total_tokens: (step.inputTokens ?? 1000) + 20, prompt_tokens_details: { cached_tokens: 800 } } })}\n\ndata: [DONE]\n\n`)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const config = path.join(root, 'config', 'agent')
  await mkdir(config, { recursive: true })
  await writeFile(path.join(config, 'models.json'), JSON.stringify({ providers: { fake: {
    api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fake-only',
    models: [{ id: 'test', name: 'Fake', input: ['text', 'image'], contextWindow: 128000, maxTokens: 4096, reasoning: false }],
  } } }))
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ defaultProvider: 'fake', defaultModel: 'test', cacheWarming: 'off', retry: { enabled: true, baseDelayMs: 1, maxRetries: 1, provider: { maxRetries: 0 } } }))
  return fake
}

export async function workspace(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'kinex-workspace-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

export async function bind(app, uiContext) {
  await app.host.session.bindExtensions({ mode: uiContext ? 'interactive' : 'print', uiContext, onError: error => { throw new Error(error.error) } })
}

const operation = (transport, direction, endpoint, type) => ({ description: '', transport, direction, endpoint, type })

async function protocolDevice(runtime, name, profile) {
  const directory = path.dirname(path.dirname((await runtime.python.status()).project))
  await runtime.profiles.writeManifest({ identity: { id: 'test', name: 'Test', kind: 'arm' } })
  const deviceDirectory = path.join(directory, '.kinex/devices', name)
  await mkdir(deviceDirectory, { recursive: true })
  const real = python3(), interpreter = path.join(deviceDirectory, 'test-python')
  await writeFile(interpreter, `#!${real}\nimport os\nos.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, '-u', ${JSON.stringify(fixture('protocol-host.py'))}])\n`, { mode: 0o755 })
  await runtime.profiles.writeDevice({ name, description: '', frames: { base: { parent: null, translation_m: null, rotation_xyzw: null } },
    runtime: { interpreter, nodes: [] }, ...profile })
  return deviceDirectory
}

// A strict ROS-typed profile whose node host is replaced by the JSON-lines stand-in.
export function seed(runtime, name = 'sensor', { loaded = false } = {}) {
  return protocolDevice(runtime, name, { type: 'other', loaded,
    operations: { read: operation('topic', 'output', '/test/read', 'std_msgs/msg/Float64'),
      write: operation('service', 'input', '/test/write', 'std_srvs/srv/Trigger'),
      stop: operation('service', 'input', '/test/stop', 'std_srvs/srv/Trigger') } })
}

// Recording requires one loaded world clock; its frame host runs in (fake) Kinex Python.
export function seedClock(runtime, name = 'world', { loaded = false } = {}) {
  return protocolDevice(runtime, name, { type: 'world', loaded,
    operations: { time: operation('topic', 'output', '/clock', 'rosgraph_msgs/msg/Clock') } })
}

// Installs a fake Kinex Python: host modules use stand-ins, exec runs the real interpreter.
export async function kinexPython(runtime) {
  const { executable } = await runtime.python.status()
  const real = python3()
  const hosts = { 'kinex.host.device': fixture('protocol-host.py'), 'kinex.host.recording': fixture('recording-host.py') }
  await mkdir(path.dirname(executable), { recursive: true })
  await rm(executable, { force: true })
  await writeFile(executable, `#!${real}
import os, sys
hosts = ${JSON.stringify(hosts)}
args = ['-u', hosts[sys.argv[-1]]] if sys.argv[-1] in hosts else sys.argv[1:]
os.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, *args])
`, { mode: 0o755 })
}
