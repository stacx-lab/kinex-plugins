import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspace } from './helpers.mjs'
import { generate } from '../script/generate.mjs'
import { writeMarketplace } from '../script/hosts.mjs'
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))

// Every host and Kinex location is private to the test; the pinned CLIs stand in for user installs.
async function hostEnvironment(t) {
  const directory = await workspace(t)
  for (const name of ['home', 'codex', 'tmp']) await mkdir(path.join(directory, name))
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: path.join(directory, 'home'),
    TMPDIR: path.join(directory, 'tmp'), XDG_DATA_HOME: path.join(directory, 'data'), CLAUDE_CONFIG_DIR: path.join(directory, 'claude'),
    CODEX_HOME: path.join(directory, 'codex'), PI_CODING_AGENT_DIR: path.join(directory, 'pi'), PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
  for (const host of ['claude', 'codex', 'pi']) env[`KINEX_${host.toUpperCase()}_BINARY`] = path.join(root, 'node_modules/.bin', host)
  const host = async (name, ...args) => JSON.parse((await exec(env[`KINEX_${name.toUpperCase()}_BINARY`], args, { env, timeout: 30000 })).stdout.replace(/^[^[{]*/, ''))
  return { directory, env, host }
}

// A built copy whose skills the test can change without touching this checkout.
async function checkoutCopy(directory) {
  const copy = path.join(directory, 'checkout')
  for (const entry of ['package.json', 'release.json', 'assets', '.agents', '.claude-plugin', 'plugins', 'script',
    'packages/mcp/package.json', 'packages/mcp/bin', 'packages/mcp/dist', 'packages/pi/package.json', 'packages/pi/dist', 'packages/pi/skills']) {
    await cp(path.join(root, entry), path.join(copy, entry), { recursive: true })
  }
  return copy
}

test('install and refresh keep Claude, Codex and Pi on the current plugin content', { timeout: 180000 }, async t => {
  const { directory, env, host } = await hostEnvironment(t)
  const checkout = await checkoutCopy(directory)
  const script = (...args) => exec(process.execPath, [path.join(checkout, 'script/hosts.mjs'), ...args], { env, timeout: 120000 })
  await script('install', '--host', 'all')
  const marketplace = path.join(env.XDG_DATA_HOME, 'kinex-plugins-marketplace')
  const config = JSON.parse(await readFile(path.join(marketplace, 'plugins/kinex/.mcp.json'), 'utf8')).mcpServers.kinex
  assert.equal(config.command, process.execPath)
  assert.deepEqual(config.args, [path.join(checkout, 'packages/mcp/bin/kinex-mcp.mjs'), 'serve', '--permission-mode', 'host'])
  const installed = async () => ({ claude: (await host('claude', 'plugin', 'list', '--json')).find(item => item.id === 'kinex@kinex-plugins'),
    codex: (await host('codex', 'plugin', 'list', '--json')).installed.find(item => item.pluginId === 'kinex@kinex-plugins') })
  const first = await installed()
  assert.match(first.claude.version, /^1\.1\.0\+[0-9a-f]{12}$/)
  assert.equal(first.codex.version, first.claude.version)
  assert.ok(JSON.parse(await readFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8')).packages
    .some(source => path.resolve(env.PI_CODING_AGENT_DIR, source) === path.join(checkout, 'packages/pi')))
  // Installing again is idempotent and keeps the same content stamp.
  await script('install', '--host', 'all')
  assert.equal((await installed()).claude.version, first.claude.version)

  await appendFile(path.join(checkout, 'assets/skills/kinex-start/SKILL.md'), '\nREFRESHED_SKILL\n')
  await generate(checkout)
  const { stdout } = await script('refresh')
  assert.match(stdout, /pi: loads this checkout in place/)
  const second = await installed()
  assert.notEqual(second.claude.version, first.claude.version)
  assert.match(await readFile(path.join(second.claude.installPath, 'skills/kinex-start/SKILL.md'), 'utf8'), /REFRESHED_SKILL/)
  assert.equal(second.codex.version, second.claude.version)
  const codex = path.join(env.CODEX_HOME, 'plugins/cache/kinex-plugins/kinex', second.codex.version)
  assert.match(await readFile(path.join(codex, 'skills/kinex-start/SKILL.md'), 'utf8'), /REFRESHED_SKILL/)
})

test('marketplace replacement refuses directories it does not own and migrates hand-copied ones', async t => {
  const directory = await workspace(t), log = () => {}
  const foreign = path.join(directory, 'foreign')
  await mkdir(foreign); await writeFile(path.join(foreign, 'notes.txt'), 'keep')
  await assert.rejects(writeMarketplace(foreign, { log }), /not a Kinex plugins marketplace/)
  assert.equal(await readFile(path.join(foreign, 'notes.txt'), 'utf8'), 'keep')
  await assert.rejects(writeMarketplace(root, { log }), /plugin checkout/)
  await assert.rejects(writeMarketplace(path.join(root, 'local-marketplace'), { log }), /plugin checkout/)
  const legacy = path.join(directory, 'legacy')
  for (const entry of ['.agents', '.claude-plugin', 'plugins']) await cp(path.join(root, entry), path.join(legacy, entry), { recursive: true })
  await writeFile(path.join(legacy, 'plugins/kinex/skills/retired.md'), 'retired')
  const { version } = await writeMarketplace(legacy, { log })
  assert.equal(JSON.parse(await readFile(path.join(legacy, '.kinex-plugins-marketplace.json'), 'utf8')).version, version)
  await assert.rejects(readFile(path.join(legacy, 'plugins/kinex/skills/retired.md')), { code: 'ENOENT' })
  assert.deepEqual(await writeMarketplace(legacy, { log }).then(result => result.version), version)
})

test('update refuses to rebuild under live Kinex servers unless forced', { timeout: 120000 }, async t => {
  const { env } = await hostEnvironment(t)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = env.TMPDIR
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous })
  const { serveCommands } = await import('../packages/mcp/dist/ipc.js')
  const workspaceDirectory = await workspace(t)
  const server = await serveCommands(workspaceDirectory, async () => ({}))
  t.after(() => server.dispose())
  const update = (...args) => exec(process.execPath, [path.join(root, 'script/update.mjs'), '--no-pull', '--dry-run', ...args], { env, timeout: 90000 })
  await assert.rejects(update(), error => error.code === 1 && error.stderr.includes(workspaceDirectory) && /End Kinex/.test(error.stderr))
  const { stdout } = await update('--force')
  assert.match(stdout, /Would run: npm ci/)
  assert.match(stdout, /Would update Kinex plugins/)
})
