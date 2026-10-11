import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

for (const name of ['pi', 'opencode']) test(`${name} tarball installs alone with core and setup snapshots and relocates`, { timeout: 180000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kinex-plugins-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pack = async cwd => {
    const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', directory], { cwd })
    return path.join(directory, JSON.parse(stdout)[0].filename)
  }
  const snapshot = JSON.parse(await readFile(path.join(root, 'vendor/core.json'), 'utf8'))
  const core = path.join(root, 'vendor', snapshot.file)
  const setupSnapshot = JSON.parse(await readFile(path.join(root, 'vendor/setup.json'), 'utf8'))
  const setup = path.join(root, 'vendor', setupSnapshot.file)
  const plugin = await pack(path.join(root, 'packages', name))
  const env = { ...process.env, KINEX_CONFIG_DIR: path.join(directory, 'config'), KINEX_DATA_DIR: path.join(directory, 'data') }
  const plugins = path.join(directory, 'plugins')
  await exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', plugins, core, setup, plugin,
    ...(name === 'pi' ? ['@earendil-works/pi-coding-agent@1.1.0'] : [])])
  const movedPlugins = path.join(directory, 'moved-plugins')
  await rename(plugins, movedPlugins)
  await assert.rejects(stat(path.join(movedPlugins, 'node_modules/kinex')), { code: 'ENOENT' })
  for (const other of ['pi', 'opencode', 'codex'].filter(value => value !== name)) {
    await assert.rejects(stat(path.join(movedPlugins, 'node_modules/@kinex', other)), { code: 'ENOENT' })
  }
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    ${name === 'pi' ? "import pi from '@kinex/pi'; assert.equal(typeof pi, 'function');" : "import server from '@kinex/opencode/server'; import tui from '@kinex/opencode/tui'; assert.equal(typeof server.server, 'function'); assert.equal(typeof tui.tui, 'function');"}
    import { createKinexRuntime } from '@kinex/core';
    import { coreContribution, composeContributions } from '@kinex/core/integration';
    import { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } from '@kinex/setup';
    const runtime = createKinexRuntime({ directory: process.cwd(), builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames });
    try {
      const capabilities = composeContributions([coreContribution(runtime), setupContribution(createKinexSetup(runtime))]);
      assert.ok((await capabilities.skills.list()).some(skill => skill.name === 'onboard-ros2'));
      assert.ok((await capabilities.skills.load('calibrate-tcp-offset')).content.length > 100);
      assert.ok((await capabilities.tools.list()).tools.some(tool => tool.name === 'setup_plan'));
      assert.ok(capabilities.commands.some(command => command.name === 'onboarding'));
      assert.equal((await capabilities.tools.call('setup_plan', { action: 'read' }, { directory: process.cwd(), sessionID: 'package', abort: new AbortController().signal, ask: async () => {}, questions: async () => ({}) })).isError, undefined);
      assert.ok((await capabilities.tools.list()).tools.some(tool => tool.name === 'device'));
      console.log((await capabilities.commands.find(command => command.name === 'devices').execute('', { sessionID: 'package', confirm: async () => false })).text);
    } finally { await runtime.dispose(); }
  `], { cwd: movedPlugins, env, timeout: 20000 })
  assert.match(stdout, /No devices/)
})
