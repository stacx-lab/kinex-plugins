import { execFileSync } from 'node:child_process'
import { cp, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
for (const name of ['pi', 'opencode', 'codex']) {
  const directory = new URL(`../packages/${name}/`, import.meta.url)
  await rm(new URL('dist/', directory), { recursive: true, force: true })
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', `packages/${name}/tsconfig.json`], { cwd: root, stdio: 'inherit' })
  for (const file of await readdir(new URL('src/', directory))) if (file.endsWith('.txt')) {
    await cp(new URL(`src/${file}`, directory), new URL(`dist/${file}`, directory))
  }
}
