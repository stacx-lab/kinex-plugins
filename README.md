# Kinex plugins

**kinex-plugins packages [Kinex](https://github.com/stacx-lab/kinex)'s core robotics
capabilities into plugins you can use directly in Pi, Claude Code and Codex.**
Choose the coding agent you prefer and give it Kinex's device control, Python
tools, robotics skills, onboarding and calibration capabilities.

Your agent keeps its own coding tools, conversations and approval workflow.
The plugin manages the robotics runtime; you do not need the standalone Kinex
app or a separately launched service. Ask **“Start Kinex”** when you are ready
to work with robots, and **“End Kinex”** when you are done.

## Install

Requires Linux or macOS, Node >=22.22.2, and your devices' dependencies.
Supported hosts are **Pi, Claude Code and Codex**; tested versions are recorded in
[`release.json`](release.json). Windows and OpenCode are not currently supported.

Install your preferred host separately, then build the plugins from a local
checkout. Kinex packages do not need to be published to npm:

```sh
git clone https://github.com/stacx-lab/kinex-plugins.git
cd kinex-plugins
nvm use
npm ci
npm run build
export KINEX_SOURCE="$PWD"
```

`nvm use` selects the version in `.nvmrc`; without nvm, use a compatible Node
installation. Keep this checkout and its dependencies in place: installed
plugins use its built files.

### Pi

Install the local Pi package:

```sh
pi install "$KINEX_SOURCE/packages/pi"
```

### Claude Code and Codex

Create a local marketplace copy that uses the built server instead of the
bundles' default npm launcher. Run this from the checkout after building:

```sh
nvm use
export KINEX_SOURCE="$PWD"
export KINEX_LOCAL="$HOME/.local/share/kinex-plugins-marketplace"
mkdir -p "$KINEX_LOCAL"
cp -R .agents .claude-plugin plugins "$KINEX_LOCAL/"

node --input-type=module <<'JS'
import { writeFileSync } from "node:fs";
import path from "node:path";

const config = {
  mcpServers: {
    kinex: {
      command: process.execPath,
      args: [
        path.join(process.env.KINEX_SOURCE, "packages/mcp/bin/kinex-mcp.mjs"),
        "serve", "--permission-mode", "host"
      ]
    }
  }
};

for (const file of [".mcp.json", "mcp.json"]) {
  writeFileSync(
    path.join(process.env.KINEX_LOCAL, "plugins/kinex", file),
    JSON.stringify(config, null, 2) + "\n"
  );
}
JS
```

The copy records absolute paths to Node and the checkout; recreate it if either
moves. Install into your preferred host in the same shell:

```sh
# Claude Code
claude plugin marketplace add "$KINEX_LOCAL"
claude plugin install kinex@kinex-plugins

# Codex
codex plugin marketplace add "$KINEX_LOCAL"
codex plugin add kinex@kinex-plugins
```

For packed tarball installation, see
[the server README](packages/mcp/README.md#local-tarballs-before-publication).

### Start a session

Open your robot workspace and launch a new host session:

```sh
cd /path/to/robot-workspace
export KINEX_WORKSPACE="$PWD"
# Launch pi, claude, or codex.
```

The plugin starts **inactive**. Use these commands or requests inside your agent:

| Action | Pi direct command | Claude Code or Codex request |
| --- | --- | --- |
| Start robotics and restore configured loaded devices | `/kinex-start` | “Start Kinex” |
| Inspect state, permission mode, recordings and failures | `/kinex-status` | “Show Kinex status” |
| Cancel work, finalize recordings and release devices | `/kinex-end` | “End Kinex” |

Pi's commands run without a model round trip. Claude Code and Codex include the
`kinex-start`, `kinex-status` and `kinex-end` skills; use the names shown in the
host UI or ask in plain language. **In Codex, explicitly say “Start Kinex”**—
installing or enabling the plugin does not activate robotics.

Ending Kinex keeps your coding session open. Starting again creates a fresh
runtime; starting an already active runtime keeps it. Normal host exit also
cleans up its runtime. External services Kinex only connected to remain running.

`KINEX_WORKSPACE` selects your robot workspace even if the host launches MCP from
another directory; an explicit `--directory` takes precedence. Each host owns its
own runtime, so independent hosts do not coordinate concurrent device control.

### Update a local installation

End Kinex and close the host before updating the checkout:

```sh
cd /path/to/kinex-plugins
git pull --ff-only
nvm use
npm ci
npm run build
export KINEX_SOURCE="$PWD"
```

Pi uses the rebuilt package on its next start. For Claude Code and Codex, repeat
the marketplace-copy steps above and refresh or reinstall the plugin. Restart
the host, then use `kinex-status` to verify that `permissionMode` is `host`.

## Architecture and ownership

```text
Pi extension + shared skills        Claude/Codex manifests + shared skills
             │                                      │
             └────────────── @kinex/mcp ──────────────┘
                                    │
                         @kinex/core + @kinex/setup
```

`@kinex/core` owns device operation; `@kinex/setup` adds onboarding and calibration.
This repository consumes their snapshots under `vendor/`. The shared `@kinex/mcp`
adapter owns discovery, permissions and lifecycle, loading core/setup on explicit
start and Python on demand. Host adapters handle transport, UI and installation.

`kinex_tools` discovers current capabilities and context; `kinex_call` executes
tools. Edit shared skills in `assets/skills` and release metadata in `release.json`,
then run `npm run generate` to refresh bundles. See [AGENTS.md](AGENTS.md) for
development contracts and [the server README](packages/mcp/README.md) for MCP details.

## Permissions

All three plugins use **host-managed permissions** by default, avoiding duplicate
Kinex approval prompts. Your host's policy and permission extensions control
approval; without a host gate, calls proceed unless a Kinex rule blocks them.

Explicit `allow`, `ask` and `deny` rules in `kinex.json` still apply. Malformed
rules ask, and emergency stop retains its always-allowed Kinex policy. Setup
questionnaires still require answers. Requests needing interaction decline if
no UI is available.

To restore Kinex's default approval dialogs, launch Pi with
`pi --kinex-permission-mode kinex`, or replace `--permission-mode host` with
`--permission-mode kinex` in your local Claude/Codex MCP configuration. Restart
the host after changing the mode. `kinex-status` reports the effective mode.
Standalone MCP server launches default to Kinex-managed permissions. Models cannot
change this startup policy through tool arguments and must not use trusted
`kinex-mcp control` commands to bypass approval.

## Develop and verify

```sh
npm ci
npm run core:check
npm run typecheck
npm test
npm run pack -- /tmp/kinex-plugins-release
```

Use Node from `.nvmrc` and Python 3 for POSIX PTY tests. Run checks sequentially:
`typecheck` builds the packages and bundles, so never rebuild during consumer tests.
Tests use real host loaders with mock devices and local fake model providers.
Targeted suites are `test:mcp` and `test:pi`; `npm run benchmark` measures startup
and shutdown after building.

## Release

Maintainers use `npm run pack -- OUTPUT_DIRECTORY` to validate generated files
and produce core/setup snapshots, MCP/Pi tarballs, Claude/Codex bundles and
`SHA256SUMS`. Pack outside the repository. Plugin versions and bundled core/setup
versions are tracked separately; published package versions must remain immutable.

CI tests and packs on Linux; macOS needs separate verification. A matching `v*`
tag attaches artifacts to a GitHub release. Local build, test and pack commands
do not publish packages, and the release workflow does not publish to npm.
