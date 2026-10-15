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

After publishing the npm packages, install Pi with:

```sh
pi install npm:@kinex/pi@1.0.0
```

For Claude Code, add this repository as a plugin marketplace, then install:

```sh
claude plugin marketplace add /absolute/path/to/kinex-plugins
claude plugin install kinex@kinex-plugins
```

For Codex:

```sh
codex plugin marketplace add /absolute/path/to/kinex-plugins
codex plugin add kinex@kinex-plugins
```

Start a new host session in the robot workspace. Ask to “Start Kinex,” then approve
activation if prompted. `/kinex-start`, `/kinex-end` and `/kinex-status` are direct,
model-free Pi commands. Claude/Codex skills invoke the shared MCP tools; their
names may be qualified by the plugin name in the host UI.

The generated Claude/Codex manifests launch `npx -y @kinex/mcp@1.0.0 serve`.
They require registry publication before release installation works. For local
unpublished development, pack/install the tarballs and point a **copy** of
`plugins/kinex/.mcp.json` at the installed `kinex-mcp` executable; see
[the server README](packages/mcp/README.md). No package is published by a local
build, test or pack operation.

Workspace selection is `--directory`, then `KINEX_WORKSPACE`, then the process
working directory. Set `KINEX_WORKSPACE` explicitly if a host launches MCP from a
different directory. Each host process owns its own runtime. Independent hosts
are not coordinated to operate the same physical devices concurrently.

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

Host tool approval and Kinex action approval are separate checks. A client without
MCP elicitation must supply a UI bridge, configure an explicit Kinex permission,
or decline the action. Missing UI never silently grants permission. Direct
`kinex-mcp control` commands are trusted user entrypoints and must not be called by
model instructions to bypass approval. IPC is local to the OS user, not a sandbox
against other processes running as that user.

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
versions. Publish core/setup before MCP, and MCP before Pi and the marketplace
release. Released npm versions must be immutable; bump package versions when
changing a previously published snapshot.

CI tests and packs on Linux. A matching `v*` tag attaches artifacts to a GitHub
release; it does not publish npm packages. macOS remains a release verification
step until exercised on a macOS runner. `packages/opencode` is retained outside
the active workspaces and release graph; it is not supported by this release.
