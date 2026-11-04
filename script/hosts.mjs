// Installs and refreshes this checkout's Kinex plugins in Pi, Claude Code and Codex.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { generate } from './generate.mjs'

export const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
export const HOSTS = ['pi', 'claude', 'codex']
const MARKER = '.kinex-plugins-marketplace.json'
const LEGACY = new Set(['.agents', '.claude-plugin', 'plugins'])
const exists = file => stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep)

export class HostError extends Error { name = 'HostError' }

// `npm run` prepends this checkout's pinned test hosts; they must never touch the user's configuration.
export function hostEnvironment(env = process.env) {
  const PATH = (env.PATH ?? '').split(path.delimiter).filter(dir => dir && !/node_modules[\\/]\.bin$|node-gyp-bin$/.test(dir)).join(path.delimiter)
  return { ...env, PATH }
}

export function hostBinary(host, env = process.env) {
  const override = env[`KINEX_${host.toUpperCase()}_BINARY`]
  if (override) return override
  for (const directory of hostEnvironment(env).PATH.split(path.delimiter)) {
    const file = path.join(directory, host)
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file } catch {}
  }
}

function invoke(binary, args, { env, dryRun = false, mutates = false, log = console.log }) {
  if (mutates) log(`${dryRun ? 'Would run' : 'Running'}: ${path.basename(binary)} ${args.join(' ')}`)
  if (dryRun && mutates) return ''
  try { return execFileSync(binary, args, { env: hostEnvironment(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (error) { throw new HostError(`${path.basename(binary)} ${args.join(' ')} failed: ${String(error.stderr || error.message).trim()}`) }
}
const parse = (text, command) => {
  try { return JSON.parse(text.slice(text.search(/[[{]/))) }
  catch { throw new HostError(`Unexpected ${command} output: ${text.slice(0, 200)}`) }
}

async function identity(checkout) {
  const release = await json(path.join(checkout, 'release.json'))
  const { version, engines } = await json(path.join(checkout, 'package.json'))
  return { name: release.name, marketplace: release.marketplace, version, engines, plugin: `${release.name}@${release.marketplace}` }
}

export function defaultMarketplace(env = process.env) {
  return path.join(env.XDG_DATA_HOME || path.join(env.HOME || homedir(), '.local/share'), 'kinex-plugins-marketplace')
}

async function files(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(directory, path.join(relative, entry.name)) : [path.join(relative, entry.name)]))).flat().sort()
}

async function ownable(target, checkout) {
  if (inside(target, checkout) || inside(checkout, target)) throw new HostError(`Refusing to use ${target}: it contains or is inside the plugin checkout`)
  const info = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HostError(`Refusing to replace ${target}: not a directory`)
  const entries = await readdir(target)
  if (!entries.length || entries.includes(MARKER)) return
  // Marketplaces copied by hand before this script existed hold exactly these entries.
  const marketplace = await json(path.join(target, '.claude-plugin/marketplace.json')).catch(() => undefined)
  if (entries.every(entry => LEGACY.has(entry)) && marketplace?.name === 'kinex-plugins') return
  throw new HostError(`Refusing to replace ${target}: it is not a Kinex plugins marketplace created by this script`)
}

// Builds a local marketplace whose MCP server runs this checkout with the current Node.
export async function writeMarketplace(target, { checkout = root, node = process.execPath, dryRun = false, log = console.log } = {}) {
  target = path.resolve(target)
  const info = await identity(checkout)
  for (const file of ['packages/mcp/dist/cli.js', 'packages/pi/dist/index.js']) {
    if (!await exists(path.join(checkout, file))) throw new HostError(`Build the checkout first: missing ${file}; run npm run build`)
  }
  await generate(checkout, true).catch(error => { throw new HostError(`${error.message}`) })
  const backup = `${target}.backup`
  // Recover from an interrupted swap before checking ownership.
  if (!dryRun && await exists(backup)) {
    if (await exists(target)) await rm(backup, { recursive: true, force: true })
    else await rename(backup, target)
  }
  await ownable(target, checkout)
  if (!dryRun) await mkdir(path.dirname(target), { recursive: true })
  const stage = await mkdtemp(dryRun ? path.join(tmpdir(), 'kinex-marketplace-') : `${target}.staging-`)
  try {
    for (const entry of LEGACY) await cp(path.join(checkout, entry), path.join(stage, entry), { recursive: true })
    const config = JSON.stringify({ mcpServers: { kinex: { command: node,
      args: [path.join(checkout, 'packages/mcp/bin/kinex-mcp.mjs'), 'serve', '--permission-mode', 'host'] } } }, null, 2) + '\n'
    for (const file of ['.mcp.json', 'mcp.json']) await writeFile(path.join(stage, 'plugins', info.name, file), config)
    // Hosts cache plugins by version: stamp content so every change is re-copied.
    const hash = createHash('sha256')
    for (const file of await files(stage)) hash.update(file).update('\0').update(await readFile(path.join(stage, file))).update('\0')
    const version = `${info.version}+${hash.digest('hex').slice(0, 12)}`
    for (const file of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const location = path.join(stage, 'plugins', info.name, file), manifest = await json(location)
      await writeFile(location, JSON.stringify({ ...manifest, version }, null, 2) + '\n')
    }
    const catalog = path.join(stage, '.claude-plugin/marketplace.json'), marketplace = await json(catalog)
    marketplace.plugins = marketplace.plugins.map(plugin => plugin.name === info.name ? { ...plugin, version } : plugin)
    await writeFile(catalog, JSON.stringify(marketplace, null, 2) + '\n')
    await writeFile(path.join(stage, MARKER), JSON.stringify({ name: info.marketplace, checkout, node, version }, null, 2) + '\n')
    const previous = await json(path.join(target, MARKER)).catch(() => undefined)
    log(`${dryRun ? 'Would write' : 'Writing'} marketplace ${target} (${info.plugin} ${version})`)
    if (dryRun) return { directory: target, version, previous: previous?.version }
    if (await exists(target)) await rename(target, backup)
    await rename(stage, target)
    await rm(backup, { recursive: true, force: true })
    return { directory: target, version, previous: previous?.version }
  } finally { await rm(stage, { recursive: true, force: true }) }
}

function older(version, minimum) {
  const [a, b] = [version, minimum].map(value => value.split('.').map(Number))
  const index = a.findIndex((part, i) => part !== b[i])
  return index >= 0 && a[index] < b[index]
}
// The local MCP configuration records this Node executable, so it must satisfy the plugin engines.
export function checkNode(range, log) {
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? '')?.[1]
  if (minimum && older(process.versions.node, minimum)) throw new HostError(`Node ${process.versions.node} does not satisfy ${range}; run nvm use first`)
  if (/[\\/]\.(nvm|volta|fnm|asdf)[\\/]/.test(process.execPath))
    log(`Note: plugins will launch ${process.execPath}. Rerun this command if you remove that Node version.`)
}

// Read-only queries normalized across the two plugin CLIs.
const cli = {
  claude: {
    marketplaces: (binary, env) => parse(invoke(binary, ['plugin', 'marketplace', 'list', '--json'], { env }), 'claude marketplace list')
      .map(item => ({ name: item.name, directory: item.path })),
    installed: (binary, env, plugin) => parse(invoke(binary, ['plugin', 'list', '--json'], { env }), 'claude plugin list').find(item => item.id === plugin),
  },
  codex: {
    marketplaces: (binary, env) => parse(invoke(binary, ['plugin', 'marketplace', 'list', '--json'], { env }), 'codex marketplace list').marketplaces
      .map(item => ({ name: item.name, directory: item.root })),
    installed: (binary, env, plugin) => parse(invoke(binary, ['plugin', 'list', '--json'], { env }), 'codex plugin list').installed.find(item => item.pluginId === plugin),
  },
}

// Directories where Claude Code or Codex already expect this marketplace.
async function registered(env, info, hosts, log) {
  const found = []
  for (const host of hosts.filter(host => host in cli)) {
    const binary = hostBinary(host, env)
    if (!binary) continue
    let marketplaces
    // One unusable host must not block refreshing the others.
    try { marketplaces = cli[host].marketplaces(binary, env) }
    catch (error) { log(`Warning: ${error.message}`); continue }
    for (const item of marketplaces) if (item.name === info.marketplace && item.directory) found.push({ host, directory: item.directory })
  }
  return found
}

function piSettings(env) {
  const agent = env.PI_CODING_AGENT_DIR || path.join(env.HOME || homedir(), '.pi/agent')
  return { agent, file: path.join(agent, 'settings.json') }
}
async function piPackages(env) {
  const { agent, file } = piSettings(env)
  const settings = await json(file).catch(error => { if (error.code === 'ENOENT') return {}; throw error })
  return (settings.packages ?? []).map(entry => typeof entry === 'string' ? entry : entry?.source).filter(Boolean)
    .map(source => /^(npm|git|https?):/.test(source) ? source : path.resolve(agent, source))
}

async function installHost(host, context) {
  const { env, info, directory, dryRun, log, checkout } = context
  const binary = hostBinary(host, env)
  if (!binary) throw new HostError(`${host} was not found on PATH; install it or set KINEX_${host.toUpperCase()}_BINARY`)
  const run = (args, mutates = true) => invoke(binary, args, { env, dryRun, mutates, log })
  if (host === 'pi') {
    const target = path.join(checkout, 'packages/pi'), packages = await piPackages(env)
    for (const other of packages.filter(source => source !== target && /kinex/i.test(source))) log(`Warning: Pi also loads ${other}; remove it with pi remove ${other}`)
    run(['install', target])
    return
  }
  const known = cli[host].marketplaces(binary, env).find(item => item.name === info.marketplace)
  if (known && path.resolve(known.directory) !== directory)
    throw new HostError(`${host} already uses ${info.marketplace} at ${known.directory}; rerun with --marketplace ${known.directory}, or run ${host} plugin marketplace remove ${info.marketplace}`)
  if (!known) run(['plugin', 'marketplace', 'add', directory, '--json'])
  if (host === 'claude') {
    if (cli.claude.installed(binary, env, info.plugin)) await refreshHost(host, context)
    else run(['plugin', 'install', info.plugin, '--json'])
  } else run(['plugin', 'add', info.plugin, '--json'])
}

async function refreshHost(host, { env, info, dryRun, log, checkout }) {
  const binary = hostBinary(host, env)
  if (!binary) return log(`${host}: not found on PATH; skipped`)
  const run = args => invoke(binary, args, { env, dryRun, mutates: true, log })
  if (host === 'pi') {
    if ((await piPackages(env)).includes(path.join(checkout, 'packages/pi'))) log('pi: loads this checkout in place; restart Pi to use the rebuilt plugin')
    else log('pi: Kinex is not installed; skipped')
    return
  }
  if (host === 'claude') {
    const installed = cli.claude.installed(binary, env, info.plugin)
    if (!installed) return log('claude: Kinex is not installed; skipped')
    run(['plugin', 'marketplace', 'update', info.marketplace, '--json'])
    run(['plugin', 'update', info.plugin, '--scope', installed.scope ?? 'user', '--json'])
    return
  }
  const installed = cli.codex.installed(binary, env, info.plugin)
  if (!installed) return log('codex: Kinex is not installed; skipped')
  // Re-adding replaces Codex's cached copy but also enables the plugin; respect a user's disable.
  if (installed.enabled === false) return log(`codex: Kinex is disabled; run codex plugin add ${info.plugin} to refresh it`)
  run(['plugin', 'add', info.plugin, '--json'])
}

export async function install({ hosts, marketplace, env = process.env, checkout = root, dryRun = false, log = console.log }) {
  const info = await identity(checkout)
  checkNode(info.engines?.node, log)
  const marketplaceHosts = hosts.filter(host => host !== 'pi')
  let directory
  if (marketplaceHosts.length) {
    const choices = marketplace ?? env.KINEX_MARKETPLACE
    const known = choices ? [] : await registered(env, info, marketplaceHosts, log)
    const distinct = [...new Set(known.map(item => path.resolve(item.directory)))]
    if (distinct.length > 1) throw new HostError(`Hosts use different ${info.marketplace} directories (${distinct.join(', ')}); pass --marketplace`)
    directory = path.resolve(choices ?? distinct[0] ?? defaultMarketplace(env))
    await writeMarketplace(directory, { checkout, dryRun, log })
  }
  const failures = []
  for (const host of hosts) {
    try { await installHost(host, { env, info, directory, dryRun, log, checkout }) }
    catch (error) { failures.push(`${host}: ${error.message}`) }
  }
  if (failures.length) throw new HostError(failures.join('\n'))
  log(`Restart ${hosts.join(', ')} sessions, then ask "Show Kinex status" to confirm the versions.`)
}

export async function refresh({ env = process.env, checkout = root, dryRun = false, log = console.log } = {}) {
  const info = await identity(checkout)
  checkNode(info.engines?.node, log)
  const directories = [...new Set((await registered(env, info, HOSTS, log)).map(item => path.resolve(item.directory)))]
  for (const directory of directories) await writeMarketplace(directory, { checkout, dryRun, log })
  const failures = []
  for (const host of HOSTS) {
    try { await refreshHost(host, { env, info, dryRun, log, checkout }) }
    catch (error) { failures.push(`${host}: ${error.message}`) }
  }
  if (failures.length) throw new HostError(`${failures.join('\n')}\nRetry with npm run install-plugins -- --host HOST after fixing the host.`)
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    host: { type: 'string', multiple: true }, marketplace: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
  const [command] = positionals
  if (values.help || !['install', 'refresh'].includes(command) || positionals.length > 1) {
    console.log('npm run install-plugins -- --host pi|claude|codex|all [--host ...] [--marketplace DIR] [--dry-run]\nnode script/hosts.mjs refresh [--dry-run]')
    if (!values.help) process.exitCode = 1
    return
  }
  const dryRun = values['dry-run'] === true
  if (command === 'refresh') return refresh({ dryRun })
  const requested = values.host ?? []
  if (!requested.length) throw new HostError('Choose hosts with --host pi, --host claude, --host codex or --host all')
  const hosts = requested.includes('all') ? HOSTS : [...new Set(requested)]
  const unknown = hosts.filter(host => !HOSTS.includes(host))
  if (unknown.length) throw new HostError(`Unknown host: ${unknown.join(', ')}`)
  await install({ hosts, marketplace: values.marketplace, dryRun })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof HostError ? error.message : error); process.exitCode = 1 })
}
