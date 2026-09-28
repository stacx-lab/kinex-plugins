import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk'

export async function startOpenCode(t, cwd, root, extra = {}) {
  const config = JSON.parse(await readFile(path.join(root, 'config/agent/models.json'), 'utf8'))
  const fake = config.providers.fake
  const state = path.join(cwd, 'host-state')
  await mkdir(state, { recursive: true })
  const plugin = fileURLToPath(new URL('../dist/server.js', import.meta.url))
  const configuration = {
    plugin: [pathToFileURL(plugin).href],
    model: 'fake/test', small_model: 'fake/test',
    provider: { fake: { npm: '@ai-sdk/openai-compatible', name: 'Fake', options: { baseURL: fake.baseUrl, apiKey: 'fake-only' }, models: { test: { name: 'Fake', limit: { context: 128000, output: 4096 } } } } },
    agent: { title: { disable: true }, summary: { disable: true } },
    permission: { '*': 'allow' },
    ...extra,
  }
  const binary = fileURLToPath(new URL('../../../node_modules/.bin/opencode', import.meta.url))
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(state, 'config'), XDG_DATA_HOME: path.join(state, 'data'), XDG_CACHE_HOME: path.join(state, 'cache'), XDG_STATE_HOME: path.join(state, 'state'), OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
  const proc = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
  let logs = ''
  for (const stream of [proc.stdout, proc.stderr]) stream.on('data', chunk => { logs += chunk })
  const exited = once(proc, 'exit')
  t.after(async () => {
    proc.kill('SIGTERM')
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timeout)
  })
  let baseUrl
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    baseUrl = /listening on (http:\/\/[^\s]+)/.exec(logs)?.[1]
    if (baseUrl) break
    if (proc.exitCode !== null) throw new Error(logs)
    await delay(50)
  }
  if (!baseUrl) throw new Error(`OpenCode did not start: ${logs}`)
  const client = createOpencodeClient({ baseUrl, directory: cwd })
  const { data: session } = await client.session.create({ body: { title: 'Kinex test' }, throwOnError: true })
  if (!session) throw new Error(`No session: ${logs}`)
  return { client, session, baseUrl, logs: () => logs, proc, env, binary }
}
