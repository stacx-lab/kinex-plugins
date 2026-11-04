// Updates this checkout and every host where its Kinex plugins are installed.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { checkNode, HostError, refresh, root } from './hosts.mjs'

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const attempt = (...args) => { try { return git(...args) } catch { return undefined } }
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' })

async function versions(revision) {
  const read = async file => JSON.parse(revision ? git('show', `${revision}:${file}`) : await readFile(path.join(root, file), 'utf8'))
  return { plugins: (await read('package.json')).version, core: (await read('vendor/core.json')).version, setup: (await read('vendor/setup.json')).version }
}

// Rebuilding replaces files that running Kinex MCP servers load lazily.
async function liveServers() {
  const ipc = path.join(root, 'packages/mcp/dist/ipc.js')
  if (!existsSync(ipc)) return []
  return (await import(pathToFileURL(ipc).href)).liveEndpoints()
}

function preflight(pull) {
  if (!pull) return
  if (!attempt('rev-parse', '--is-inside-work-tree')) throw new HostError(`${root} is not a git checkout; reinstall from a clone or use --no-pull`)
  if (!attempt('symbolic-ref', '-q', 'HEAD')) throw new HostError('The checkout is not on a branch; switch to a branch or use --no-pull')
  if (!attempt('rev-parse', '--abbrev-ref', '@{u}')) throw new HostError('The current branch has no upstream; set one or use --no-pull')
  if (git('status', '--porcelain', '--untracked-files=no')) throw new HostError('Commit or stash tracked changes first, or use --no-pull')
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, allowNegative: true, options: { pull: { type: 'boolean', default: true },
    force: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, from: { type: 'string' }, help: { type: 'boolean', short: 'h' } } })
  if (values.help) { console.log('npm run update [-- --no-pull] [--force] [--dry-run]'); return }
  const dryRun = values['dry-run'] === true
  checkNode(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).engines?.node, () => {})
  preflight(values.pull)
  const servers = await liveServers()
  if (servers.length && !values.force) {
    throw new HostError(`End Kinex and close these host sessions first, then run the update from a plain terminal:\n${servers.map(server => `  ${server.directory} (pid ${server.pid})`).join('\n')}\nUse --force only if those servers do not use this checkout.`)
  }
  const from = values.from ?? attempt('rev-parse', 'HEAD')
  if (values.pull && !dryRun) {
    run('git', ['pull', '--ff-only'])
    // Continue with the pulled updater so new update steps apply immediately.
    try { execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--no-pull', '--force', '--from', from], { cwd: root, stdio: 'inherit' }) }
    catch (error) { process.exitCode = error.status ?? 1 }
    return
  }
  if (values.pull) console.log('Would run: git pull --ff-only, then continue with the pulled updater')
  const before = await versions(from)
  const recovery = from ? `git reset --keep ${from.slice(0, 12)} && npm ci && npm run build` : 'npm ci && npm run build'
  for (const args of [['ci'], ['run', 'build']]) {
    if (dryRun) { console.log(`Would run: npm ${args.join(' ')}`); continue }
    try { run('npm', args) }
    catch { throw new HostError(`npm ${args.join(' ')} failed. Fix the error and rerun npm run update -- --no-pull, or restore the previous version with:\n  ${recovery}`) }
  }
  await refresh({ dryRun })
  const after = await versions()
  console.log(`${dryRun ? 'Would update' : 'Updated'} Kinex plugins ${before.plugins} → ${after.plugins} (core ${before.core} → ${after.core}, setup ${before.setup} → ${after.setup}).`)
  console.log('Restart your host sessions, then ask "Show Kinex status" to confirm the versions.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error instanceof HostError ? error.message : error); process.exitCode = 1 })
}
