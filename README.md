# Kinex plugins

Kinex robotics for Pi, Claude Code and Codex. A shared `@kinex/mcp` package owns
execution, permissions, discovery and lifecycle. Host plugins supply installation
metadata and a small set of skills. Pi also supplies a thin UI bridge for approval
and questionnaire dialogs.

The host launches the stdio process automatically; users do not run a separate
service. Connecting the plugin leaves Kinex **inactive**. “Start Kinex” creates the
runtime and restores configured loaded devices. “End Kinex” cancels robotics work,
finalizes recordings and releases devices while the coding session stays open.
A subsequent start creates a fresh runtime. Host exit also disposes Kinex.

## Install

Requires local Linux or macOS, Node >=22.22.2, and the device-specific dependencies
required by Kinex. Tested host versions are pinned in `release.json`: Pi 1.2.0,
Claude Code 2.1.299 and Codex 0.162.1. Windows and OpenCode are outside this release.

Install from a local checkout; Kinex packages do not need to be published to npm.
Install your preferred host separately, then build the plugins:

```sh
git clone https://github.com/stacx-lab/kinex-plugins.git
cd kinex-plugins
nvm use
npm ci
npm run build
export KINEX_SOURCE="$PWD"
```

If you already have the checkout, start with `cd /path/to/kinex-plugins`.
`nvm use` selects the version in `.nvmrc`; without nvm, use a compatible Node
installation. `npm ci` installs third-party dependencies and the checked-in
core/setup snapshots. Keep this checkout and its dependencies in place: the
installed plugins use the built files here.

### Pi

Install the local Pi package:

```sh
pi install "$KINEX_SOURCE/packages/pi"
```

Pi loads the package directly from the checkout, including its shared skills.

### Claude Code and Codex

The generated marketplace bundles launch the version-pinned `@kinex/mcp` package
through `npx`, which requires npm publication. For a local installation, create a
marketplace copy and point both MCP configuration files at the built server.
After building, run this from the checkout. Export both paths in this shell so
Node can read them:

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

This keeps machine-specific paths outside the repository. The copy uses the
current Node executable and checkout by absolute path; recreate it if either
moves. Install into your preferred host:

```sh
# Claude Code
claude plugin marketplace add "$KINEX_LOCAL"
claude plugin install kinex@kinex-plugins

# Codex
codex plugin marketplace add "$KINEX_LOCAL"
codex plugin add kinex@kinex-plugins
```

For an installation using packed tarballs instead of a source checkout, see
[the server README](packages/mcp/README.md#local-tarballs-before-publication).
No package is published by a local build, test or pack operation.

### Start a session

Open your robot workspace and launch a new host session:

```sh
cd /path/to/robot-workspace
export KINEX_WORKSPACE="$PWD"
# Launch pi, claude, or codex.
```

Connecting the plugin leaves robotics inactive. Use these lifecycle commands or
skills inside your host session:

| Command / skill | When to use it | What it does |
| --- | --- | --- |
| `kinex-start` | Begin robotics work. | Start the runtime and restore configured loaded devices. Approve activation if prompted. Starting an already active runtime keeps the current session. |
| `kinex-status` | Check before or during robotics work. | Report runtime state, workspace, permission mode, recording status and failures without activating robotics. |
| `kinex-end` | Finish robotics work while keeping the coding session open. | Cancel active work, finalize recordings and release devices and owned processes. |

**Pi:** enter the direct, model-free commands in the prompt:

```text
/kinex-start
/kinex-status
/kinex-end
```

**Claude Code:** invoke the installed `kinex-start`, `kinex-status` or
`kinex-end` skill using the name shown in the host UI, which may include the
plugin namespace. You can also ask “Start Kinex,” “Show Kinex status,” or
“End Kinex.”

**Codex:** explicitly ask **“Start Kinex”** in the conversation to activate the
runtime. Installing or enabling the plugin, or opening Codex, does not start
robotics. Use “Show Kinex status” to inspect it and “End Kinex” to shut it down
while keeping Codex open. The corresponding `kinex-start`, `kinex-status` and
`kinex-end` skills guide these requests through the shared MCP tools. Claude Code
and Codex apply their host approval policies to these tool calls.

A typical session is `kinex-start` → `kinex-status` → robotics work → `kinex-end`.
After ending, `kinex-status` reports inactive; use `kinex-start` again to create a
fresh runtime. Exiting the host normally also shuts down its Kinex runtime and
finalizes recordings. External services Kinex only connected to remain running.

Workspace selection is `--directory`, then `KINEX_WORKSPACE`, then the process
working directory. Set `KINEX_WORKSPACE` explicitly if a host launches MCP from a
different directory. Each host process owns its own runtime. Independent hosts
are not coordinated to operate the same physical devices concurrently.

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

Pi loads the rebuilt package on its next start. For Claude/Codex, recreate the
local marketplace copy using the steps above and refresh or reinstall the plugin
in the host to pick up changed skills and manifests. Start a new host session
after updating, then use `kinex-status` to verify that `permissionMode` is `host`.

## Architecture and ownership

```text
Pi extension + shared skills        Claude/Codex manifests + shared skills
             │                                      │
             └────────────── @kinex/mcp ──────────────┘
                                    │
                         lazy runtime / public APIs
                                    │
                         @kinex/core + @kinex/setup
```

- `packages/mcp/src/kinex.ts` is the runtime import boundary to core/setup.
  Hardware behavior stays in Kinex; this repository consumes packed public APIs.
- `packages/mcp/src/session.ts` owns start, stop, restart, cancellation and cleanup.
  Core/setup are dynamically imported on the first start. Python remains lazy.
- `kinex_tools` discovers current tools, skills, workflows and context. It returns
  short summaries by default; schemas and full context are requested separately.
  `kinex_call` executes current tools through Kinex permissions. New contributions
  generally need no host edits or regenerated tool inventories.
- `packages/pi` bridges dialogs and lifecycle commands to the same server. Native
  Pi MCP owns transport and process lifetime. There is no second robotics runtime.
- `assets/skills` is the canonical skill source. `release.json` and the root version
  generate manifests, marketplace entries and copied skills with `npm run generate`.

## Permissions

Pi, Claude Code and Codex plugins use **host-managed permissions** by default.
Each host's tool permission policy controls approval before Kinex executes a call.
Kinex does not repeat default approval prompts for `exec`, controller tools or
activation. Pi also uses its permission extensions, including auto mode. Without
a host permission gate, calls proceed unless an explicit Kinex rule blocks them.

Explicit `allow`, `ask` and `deny` entries in `kinex.json` still apply; malformed
entries remain `ask`, and emergency stop retains its always-allowed Kinex policy.
Setup questionnaires still require answers. Explicit `ask` rules and questionnaires
use MCP elicitation or Pi's UI bridge and decline if interaction is unavailable.

To restore Kinex's default approval dialogs, launch Pi with
`pi --kinex-permission-mode kinex`, or replace `--permission-mode host` with
`--permission-mode kinex` in your local Claude/Codex MCP configuration. Restart
the host after changing the mode. `kinex-status` reports the effective
`permissionMode`. Standalone server launches default to Kinex-managed permissions.
The mode is a startup policy; model tool arguments cannot change it.

Direct `kinex-mcp control` commands are trusted user entrypoints and must not be
called by model instructions to bypass approval. IPC is local to the OS user,
not a sandbox against other processes running as that user.

## Develop and verify

```sh
npm ci
npm run core:check
npm run typecheck
npm test
npm run pack -- /tmp/kinex-plugins-release
```

Use Node from `.nvmrc`. Python 3 is required for the POSIX PTY tests. `typecheck`
builds both packages and generates host bundles; never build while consumer tests
are running. Tests use mock devices and local fake model providers, not paid model
APIs or physical robots. They exercise real host loaders, cancellation, permissions,
recording, restart and relocated package installations. Targeted suites are
`test:mcp` and `test:pi`.

Run `npm run benchmark` after building to record cold module/factory latency and
process memory before activation, then empty-workspace start/end latency. A Linux
x64 / Node 22.22.2 sample measured 142 ms and 67 MiB RSS while inactive, 153 ms for
first activation (87 MiB RSS), and 2 ms for shutdown. These are local measurements,
not performance guarantees; they exclude host startup, npm download and devices.
Ending Kinex releases resources but does not unload cached JavaScript modules.

## Update Kinex once

```sh
npm run kinex:sync -- ../kinex
```

The source Kinex checkout must have its dependencies installed. Synchronization:

1. Copies this checkout into temporary staging and records its current catalog.
2. Builds and packs core/setup from the supplied checkout; records source revision,
   dirty state and SHA-256 in `vendor/core.json` and `vendor/setup.json`.
3. Updates exact dependencies, lockfile and generated artifacts in staging.
4. Checks snapshot integrity, builds, runs shared/host/relocation tests and validates
   release metadata. A failure leaves the working checkout unchanged.
5. Produces `compatibility-report.json` with added, removed and changed tools,
   schemas, skills and workflows, plus the validated host versions.
6. Applies the validated files, refusing concurrent edits, and installs/builds the
   result. Failed installation restores the prior files and attempts to restore
   the prior dependency installation.

Review the report and snapshot diff together. Ordinary additions should require
only the sync; breaking public API changes are fixed at the shared adapter boundary.
Host SDK changes are separate, deliberate upgrades in `package.json` and
`release.json`. Builds never refresh Kinex implicitly. `core:refresh` is the
low-level, in-place snapshot command for maintainers; use `kinex:sync` for normal
updates. No sibling Kinex source files are edited.

## Release

`npm run pack -- OUTPUT_DIRECTORY` produces core/setup snapshots and provenance,
`@kinex/mcp` and `@kinex/pi` tarballs, a Claude/Codex plugin bundle with both
marketplace indexes, and `SHA256SUMS`. It verifies generated artifacts are current.
Plugin/root versions identify the release; core/setup have their own matching
versions. Local installation and tarball distribution work without npm
publication. If npm distribution is introduced later, publish core/setup before
MCP, and MCP before Pi and the marketplace release. Released npm versions must
be immutable; bump package versions when changing a previously published snapshot.

CI tests and packs on Linux. A matching `v*` tag attaches artifacts to a GitHub
release; it does not publish npm packages. macOS remains a release verification
step until exercised on a macOS runner. `packages/opencode` is retained outside
the active workspaces and release graph; it is not supported by this release.
