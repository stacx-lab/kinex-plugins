# Kinex plugins

**kinex-plugins packages [Kinex](https://github.com/stacx-lab/kinex)'s core robotics
capabilities into plugins you can use directly in Pi, Claude Code and Codex.**
Choose the coding agent you prefer and give it Kinex's device control, Python
tools, robotics skills, onboarding and calibration capabilities.

Your agent keeps its own coding tools, conversations and approval workflow.
The plugin manages the robotics runtime; you do not need the standalone Kinex
app or a separately launched service. Ask **“Start Kinex”** when you are ready
to work with robots, and **“End Kinex”** when you are done.

This release bundles Kinex core and setup **1.1.0**; the exact snapshots are
recorded in [`vendor/`](vendor) and [`compatibility-report.json`](compatibility-report.json).

## Install

Requirements:

- Linux or macOS with Node >=22.22.2. Windows is not supported.
- Supported hosts are **Pi, Claude Code and Codex**; tested versions are recorded
  in [`release.json`](release.json). OpenCode is not supported.
- Kinex devices are ROS 2 nodes, and robotics Python runs in a workspace-owned
  Kinex Python. Install [Pixi](https://pixi.sh) for the default RoboStack ROS
  Jazzy environment (`python.provider: "ros-humble"` selects Humble), which needs
  Linux x86-64, or install [uv](https://docs.astral.sh/uv/) and set
  `python.provider: "uv"` for plain Python without ROS.
- Your devices' own drivers and dependencies.

Install your preferred host separately, then build the plugins from a local
checkout and install them into your hosts. Kinex packages do not need to be
published to npm:

```sh
git clone https://github.com/stacx-lab/kinex-plugins.git
cd kinex-plugins
nvm use
npm ci
npm run build
npm run install-plugins -- --host claude   # or pi, codex, all; repeat --host as needed
```

`nvm use` selects the version in `.nvmrc`; without nvm, use a compatible Node
installation. Keep this checkout and its dependencies in place: installed
plugins run its built files.

What `install-plugins` does for each host:

| Host | Installation |
| --- | --- |
| Pi | `pi install <checkout>/packages/pi`; Pi loads the checkout in place. |
| Claude Code | Registers the local marketplace `kinex-plugins` and installs `kinex@kinex-plugins`. |
| Codex | Registers the local marketplace `kinex-plugins` and adds `kinex@kinex-plugins`. |

For Claude Code and Codex, the script writes a local marketplace (by default
`~/.local/share/kinex-plugins-marketplace`, or `--marketplace DIR`) whose MCP
configuration launches this checkout's server with the current Node. The script
manages that directory and refuses to replace anything it did not create. Add
`--dry-run` to print the planned commands. Host CLIs are found on `PATH`; set
`KINEX_PI_BINARY`, `KINEX_CLAUDE_BINARY` or `KINEX_CODEX_BINARY` to choose another
binary. For packed tarball installation, see
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
| Inspect state, versions, permission mode, recordings and failures | `/kinex-status` | “Show Kinex status” |
| Cancel work, finalize recordings and release devices | `/kinex-end` | “End Kinex” |

Pi's commands run without a model round trip. Claude Code and Codex include the
`kinex-start`, `kinex-status` and `kinex-end` skills; use the names shown in the
host UI or ask in plain language. **In Codex, explicitly say “Start Kinex”**—
installing or enabling the plugin does not activate robotics.

Ending Kinex keeps your coding session open. Starting again creates a fresh
runtime; starting an already active runtime keeps it. Normal host exit also
cleans up its runtime. Borrowed nodes and services that Kinex only connected to
remain running. If cleanup reports an error, Kinex still terminates the
processes it owns, reports the error in `kinex-status` and can start again.

Asking the agent to stop, or `kinex_stop`, cancels queued Kinex work, invokes each
loaded device's declared stop within its declared scope, and cancels running
scripts that commanded a stopped device. It does not replace a hardware emergency
stop. The first `exec` in a workspace prepares Kinex Python under `.kinex/python`,
which can take several minutes with Pixi.

`KINEX_WORKSPACE` selects your robot workspace even if the host launches MCP from
another directory; an explicit `--directory` takes precedence. Each host owns its
own runtime, so independent hosts do not coordinate concurrent device control.

## Update

End Kinex and close your host sessions, then update from a plain terminal:

```sh
cd /path/to/kinex-plugins
nvm use
npm run update
```

The updater refuses to run while any Kinex MCP server is live, because rebuilding
replaces the files those servers load. It then runs `git pull --ff-only`,
`npm ci` and `npm run build`, rewrites the local marketplace, and refreshes each
host where Kinex is installed:

| Host | Refresh |
| --- | --- |
| Pi | Nothing to do; Pi loads the rebuilt checkout on its next start. |
| Claude Code | `claude plugin marketplace update kinex-plugins` and `claude plugin update kinex@kinex-plugins` |
| Codex | `codex plugin add kinex@kinex-plugins`, unless you disabled the plugin |

Local plugin versions carry a content stamp such as `1.1.0+3f2a9c1d04e5`, so
Claude Code and Codex replace their cached copies whenever skills or MCP settings
change. The updater prints the old and new plugin and Kinex versions. Restart
your hosts, then ask “Show Kinex status”: `versions` reports the running
`mcp`, `core` and `setup` versions.

Use `npm run update -- --no-pull` after updating the checkout yourself, and
`--dry-run` to print the plan. To repair or add one host later, rerun
`npm run install-plugins -- --host HOST`. If the build fails, the updater prints
the `git reset --keep` command that restores the previous version.

### Upgrading from 1.0

Kinex 1.1 is not backward compatible with 1.0 workspaces:

- Device profiles are now strict ROS 2 profiles. A 1.0 profile makes Start
  Kinex fail with `DeviceProfileError`. Move `.kinex/devices` aside, start Kinex,
  then onboard or register your devices again.
- The Python tool permission is now `python_tool`; rename `python_tool_controller`
  rules in `.kinex/kinex.json` (or a workspace `kinex.json`).
- Install Pixi or uv as described above before the first `exec`.

## Architecture and ownership

```text
Pi extension + shared skills        Claude/Codex manifests + shared skills
             │                                      │
             └────────────── @kinex/mcp ──────────────┘
                                    │
                         @kinex/core + @kinex/setup
```

`@kinex/core` owns devices as ROS 2 nodes, Kinex Python and device setup;
`@kinex/setup` adds onboarding and calibration workflows. This repository
consumes their snapshots under `vendor/`. The shared `@kinex/mcp` adapter owns
discovery, permissions and lifecycle, loading core/setup on explicit start and
Python on demand. Host adapters handle transport, UI and installation.

`kinex_tools` discovers current capabilities and context; `kinex_call` executes
tools. Device catalogs, readiness and operations are queried inside `exec`.
Edit shared skills in `assets/skills` and release metadata in `release.json`,
then run `npm run generate` to refresh bundles. See [AGENTS.md](AGENTS.md) for
development contracts and [the server README](packages/mcp/README.md) for MCP details.

## Permissions

All three plugins use **host-managed permissions** by default, avoiding duplicate
Kinex approval prompts. Your host's policy and permission extensions control
approval; without a host gate, calls proceed unless a Kinex rule blocks them.

Explicit `allow`, `ask` and `deny` rules in `.kinex/kinex.json` (or a workspace
`kinex.json`) still apply, for example `{ "permission": { "python_tool": "ask" } }`.
Malformed rules ask, and stop retains its always-allowed Kinex policy. Setup
questionnaires still require answers. Requests needing interaction decline if
no UI is available. Onboarding may write `python.provider` to the same file, so
review host file-write approvals for it.

To restore Kinex's default approval dialogs, launch Pi with
`pi --kinex-permission-mode kinex`, or replace `--permission-mode host` with
`--permission-mode kinex` in the local marketplace's MCP configuration and refresh
the host. Restart the host after changing the mode. `kinex-status` reports the
effective mode. Standalone MCP server launches default to Kinex-managed
permissions. Models cannot change this startup policy through tool arguments and
must not use trusted `kinex-mcp control` commands to bypass approval.

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
Tests use real host loaders and CLIs with isolated homes, ROS node stand-ins and
local fake model providers; they need neither ROS, Pixi nor uv. Targeted suites
are `test:mcp` and `test:pi`; `npm run benchmark` measures startup and shutdown
after building.

To move to a new Kinex release, run a validated snapshot migration from a Kinex
checkout. Snapshots are packed from a clean `git archive` of the chosen revision,
so untracked files in that checkout never enter them:

```sh
npm run kinex:sync -- ../kinex --ref v1.1.0
```

`--baseline CATALOG.json` compares against a catalog saved earlier with
`node script/catalog.mjs` when the previous snapshot is no longer installed.

## Release

Maintainers use `npm run pack -- OUTPUT_DIRECTORY` to validate generated files
and produce core/setup snapshots, MCP/Pi tarballs, Claude/Codex bundles and
`SHA256SUMS`. Pack outside the repository. Plugin versions and bundled core/setup
versions are tracked separately; published package versions must remain immutable.

CI tests and packs on Linux; macOS needs separate verification. A matching `v*`
tag attaches artifacts to a GitHub release. Local build, test and pack commands
do not publish packages, and the release workflow does not publish to npm.
