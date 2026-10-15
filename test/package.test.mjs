import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, rename, stat, cp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspace } from './helpers.mjs'
import { generate } from '../script/generate.mjs'
const exec = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url))

test('Pi package installs with shared MCP and relocates without standalone or other adapters', { timeout: 180000 }, async t => {
  const directory = await workspace(t)
  const pack = async name => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd: path.join(root, 'packages', name) })
    return path.join(directory, JSON.parse(stdout)[0].filename)
  }
  const snapshots = await Promise.all(['core', 'setup'].map(async name => path.join(root, 'vendor', JSON.parse(await readFile(path.join(root, 'vendor', `${name}.json`), 'utf8')).file)))
  const packages = await Promise.all(['mcp', 'pi'].map(pack))
  const install = path.join(directory, 'install'), moved = path.join(directory, 'relocated')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', install, ...snapshots, ...packages, '@earendil-works/pi-coding-agent@1.2.0'])
  await rename(install, moved)
  for (const name of ['kinex', '@kinex/codex', '@kinex/opencode']) await assert.rejects(stat(path.join(moved, 'node_modules', name)), { code: 'ENOENT' })
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import pi from '@kinex/pi';
    import { createKinexMcpServer } from '@kinex/mcp';
    assert.equal(typeof pi, 'function');
    const server = await createKinexMcpServer({ directory: process.cwd() });
    assert.equal((await server.status()).state, 'inactive');
    assert.equal(server.runtime, undefined);
    await server.dispose();
    console.log(import.meta.resolve('@kinex/mcp/cli'));
  `], { cwd: moved, timeout: 20000 })
  assert.ok(stdout.includes('relocated'))
  assert.ok((await readFile(path.join(moved, 'node_modules/@kinex/pi/skills/kinex-start/SKILL.md'), 'utf8')).includes('kinex_start'))
})

test('host bundles are reproducible, version-pinned and reference existing skills and MCP config', async () => {
  await generate(root, true)
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  for (const host of ['claude', 'codex']) {
    const manifest = JSON.parse(await readFile(path.join(root, `plugins/kinex/.${host}-plugin/plugin.json`), 'utf8'))
    assert.equal(manifest.version, version)
    await stat(path.join(root, 'plugins/kinex', manifest.skills))
    const mcp = JSON.parse(await readFile(path.join(root, 'plugins/kinex', manifest.mcpServers), 'utf8'))
    assert.ok(mcp.mcpServers.kinex.args.includes(`@kinex/mcp@${version}`))
    assert.ok(!mcp.mcpServers.kinex.args.some(arg => arg.includes('@latest')))
  }
})

test('Codex installs the generated marketplace plugin with its skills and MCP configuration', { timeout: 30000 }, async t => {
  const directory = await workspace(t)
  const binary = process.env.KINEX_CODEX_BINARY ?? path.join(root, 'node_modules/.bin/codex')
  const run = (...args) => exec(binary, ['plugin', ...args], { env: { PATH: process.env.PATH, CODEX_HOME: directory }, cwd: directory, timeout: 20000 })
  await run('marketplace', 'add', root)
  const result = JSON.parse((await run('add', 'kinex@kinex-plugins', '--json')).stdout)
  assert.equal(result.pluginId, 'kinex@kinex-plugins')
  const installed = JSON.parse((await run('list', '--json')).stdout).installed
  assert.equal(installed.find(plugin => plugin.pluginId === result.pluginId)?.enabled, true)
  await stat(path.join(result.installedPath, '.mcp.json'))
  assert.match(await readFile(path.join(result.installedPath, 'skills/kinex-start/SKILL.md'), 'utf8'), /kinex_start/)
})


test('generation propagates supporting skill files and removes retired skills', async t => {
  const directory = await workspace(t)
  for (const file of ['package.json', 'release.json', 'assets']) await cp(path.join(root, file), path.join(directory, file), { recursive: true })
  await writeFile(path.join(directory, 'assets/skills/kinex-start/example.txt'), 'supporting content')
  await generate(directory)
  assert.equal(await readFile(path.join(directory, 'packages/pi/skills/kinex-start/example.txt'), 'utf8'), 'supporting content')
  await rm(path.join(directory, 'assets/skills/kinex-start'), { recursive: true })
  await assert.rejects(generate(directory, true), /Obsolete generated artifact/)
  await generate(directory)
  await assert.rejects(stat(path.join(directory, 'plugins/kinex/skills/kinex-start/SKILL.md')), { code: 'ENOENT' })
  await generate(directory, true)
})
