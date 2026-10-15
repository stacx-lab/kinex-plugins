import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const directory = await mkdtemp(path.join(tmpdir(), 'kinex-contract-'))
process.env.KINEX_CONFIG_DIR = path.join(directory, 'config')
process.env.KINEX_DATA_DIR = path.join(directory, 'data')
try {
  const { createKinexRuntime } = await import('@kinex/core')
  const { coreContribution, composeContributions } = await import('@kinex/core/integration')
  const { createKinexSetup, setupContribution, setupSkillRoots, setupToolNames } = await import('@kinex/setup')
  const runtime = createKinexRuntime({ directory, builtinSkillRoots: setupSkillRoots, reservedToolNames: setupToolNames })
  try {
    const capabilities = composeContributions([coreContribution(runtime), setupContribution(createKinexSetup(runtime))])
    const catalog = await capabilities.tools.list()
    if (catalog.problems.length) throw new Error(catalog.problems.join('\n'))
    console.log(JSON.stringify({ tools: catalog.tools, skills: (await capabilities.skills.list()).map(({ name, description }) => ({ name, description })),
      workflows: capabilities.commands.filter(command => command.kind === 'workflow').map(({ name, description, arguments: args }) => ({ name, description, arguments: args })) }))
  } finally { await runtime.dispose() }
} finally { await rm(directory, { recursive: true, force: true }) }
