import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const entry = fileURLToPath(new URL('../bin/kinex-codex.mjs', import.meta.url))

export async function responsesProvider(t) {
  const requests = [], steps = []
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body); requests.push(request)
    const step = steps.shift() ?? { text: 'KINEX_CODEX_DONE' }
    const id = `resp_${requests.length}`
    const advertised = [...request.tools, ...request.input.filter(item => item.type === 'tool_search_output').flatMap(item => item.tools ?? [])]
      .flatMap(item => item.type === 'namespace' ? item.tools.map(tool => ({ ...tool, namespace: item.name })) : [item])
    const selected = advertised.find(tool => tool.name === step.name || tool.name?.endsWith(`__${step.name}`))
    const item = step.search ? { type: 'tool_search_call', id: `ts_${requests.length}`, call_id: `search_${requests.length}`, execution: 'client', status: 'completed', arguments: { query: 'kinex kinex_tools kinex_call robotics', limit: 3 } }
      : step.name ? { type: 'function_call', id: `fc_${requests.length}`, call_id: `call_${requests.length}`, name: selected?.name ?? step.name, ...(selected?.namespace ? { namespace: selected.namespace } : {}), arguments: JSON.stringify(step.arguments ?? {}), status: 'completed' }
      : { type: 'message', id: `msg_${requests.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`)
    send('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(step.name ? { arguments: '' } : step.search ? {} : { content: [] }) } })
    if (!step.name && !step.search) send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: step.text })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } } })
    res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { requests, steps, url: `http://127.0.0.1:${server.address().port}/v1` }
}

export async function codexHost(t, directory, provider, extra = '') {
  const home = path.join(directory, 'codex-home')
  await mkdir(home)
  await writeFile(path.join(home, 'config.toml'), `model = "gpt-5.4"
model_provider = "fake"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
[model_providers.fake]
name = "Local test"
base_url = ${JSON.stringify(provider.url)}
wire_api = "responses"
requires_openai_auth = false
[mcp_servers.kinex]
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([entry, 'serve', '--directory', directory])}
required = true
startup_timeout_sec = 30
tool_timeout_sec = 30
${extra}
`)
  const env = { ...process.env, CODEX_HOME: home }
  for (const key of Object.keys(env)) if (/API_KEY|API_TOKEN|OPENAI_BASE_URL|CODEX_THREAD_ID/.test(key)) delete env[key]
  const proc = spawn(process.env.KINEX_CODEX_BINARY ?? fileURLToPath(new URL('../../../node_modules/.bin/codex', import.meta.url)), ['app-server'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let logs = '', buffer = '', sequence = 0
  const pending = new Map(), notifications = [], handlers = new Map(), waiters = new Set()
  proc.stderr.on('data', chunk => { logs += chunk })
  const send = value => proc.stdin.write(JSON.stringify(value) + '\n')
  proc.stdout.on('data', chunk => {
    buffer += chunk
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      const value = JSON.parse(line)
      if (value.method && value.id !== undefined) {
        Promise.resolve(handlers.get(value.method)?.(value.params) ?? { action: 'decline', content: null }).then(result => send({ id: value.id, result }))
      } else if (value.id !== undefined) {
        const item = pending.get(value.id); pending.delete(value.id)
        if (!item) continue
        clearTimeout(item.timeout)
        if (value.error) item.reject(new Error(JSON.stringify(value.error))); else item.resolve(value.result)
      } else {
        notifications.push(value)
        for (const waiter of waiters) if (waiter.predicate(value)) { waiters.delete(waiter); clearTimeout(waiter.timeout); waiter.resolve(value) }
      }
    }
  })
  const exited = once(proc, 'exit')
  proc.on('exit', () => {
    for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error(`Codex exited: ${logs}`)) }
    pending.clear()
  })
  t.after(async () => {
    proc.stdin.end()
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
    await exited; clearTimeout(timer)
    for (const waiter of waiters) clearTimeout(waiter.timeout)
  })
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}\n${logs}`)) }, 45000)
    pending.set(id, { resolve, reject, timeout }); send({ id, method, params })
  })
  const wait = predicate => {
    const previous = notifications.find(predicate)
    if (previous) return Promise.resolve(previous)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timeout: setTimeout(() => { waiters.delete(waiter); reject(new Error(`Notification timeout: ${logs}`)) }, 45000) }
      waiters.add(waiter)
    })
  }
  await request('initialize', { clientInfo: { name: 'kinex_test', version: '1.0.0' }, capabilities: { experimentalApi: true } })
  send({ method: 'initialized' })
  const { thread } = await request('thread/start', { cwd: directory, ephemeral: true, approvalPolicy: 'on-request', sandbox: 'danger-full-access' })
  const status = await request('mcpServerStatus/list', { threadId: thread.id })
  if (!status.data?.some(item => item.name === 'kinex' && Object.keys(item.tools).length)) throw new Error(`Kinex did not initialize: ${JSON.stringify(status)}\n${logs}`)
  return { request, wait, thread, handlers, notifications, proc, env, logs: () => logs }
}
