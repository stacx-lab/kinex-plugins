# @kinex/codex

Kinex robotics in Codex through local stdio MCP, with a user control CLI sharing
the same runtime. Tested with Codex **0.162.1**, Node **22.22.2** and Linux.
The local transport also targets macOS; remote control and Windows are deferred.
Device behavior comes from core; onboarding, calibration and ROS setup come from setup; Codex retains its coding tools,
permissions, credentials, sessions and UI.

## Install and connect

Build from the repository with `npm ci && npm run build`, then:

```sh
npm run pack -- /tmp/kinex-plugins-release
npm install --prefix /path/to/kinex-plugins \
  /tmp/kinex-plugins-release/kinex-core-1.0.0-*.tgz \
  /tmp/kinex-plugins-release/kinex-setup-1.0.0-*.tgz \
  /tmp/kinex-plugins-release/kinex-codex-1.0.0.tgz
```

Add this to the robot project's trusted `.codex/config.toml`, or to your user
Codex configuration. Replace all absolute paths and use Node >=22.22.2:

```toml
[mcp_servers.kinex]
command = "/absolute/path/to/node"
args = ["/path/to/kinex-plugins/node_modules/@kinex/codex/bin/kinex-codex.mjs", "serve", "--directory", "/path/to/robot-workspace"]
required = true
startup_timeout_sec = 30
tool_timeout_sec = 300

[mcp_servers.kinex.tools.kinex_stop]
approval_mode = "auto"
```

For development, use `/path/to/kinex-plugins/packages/codex/bin/kinex-codex.mjs` after
building. Start a fresh Codex session and check `/mcp`. The server directory stays
fixed for its lifetime; changing a shell directory does not retarget robotics.
Configure one Kinex server per workspace/session.

Codex may discover the tools through tool search before calling them. See the
[official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Build/install commands do not edit Codex configuration or publish packages.
Python/uv are needed only for operations using Core's lazy Python environment;
ordinary Codex shells keep their existing environment.

## Model tools and context

- `kinex_tools`: current schemas, discovery problems, skills, workflow names and
  complete context. Optional `skill` loads a skill; `workflow` plus string
  `arguments` returns the composed onboarding/register/calibrate prompt.
- `kinex_call`: invoke a current composed tool with `name` and object `arguments`.
- `kinex_stop`: cancel running Kinex work and invoke Core `device_stop`, optionally
  with `deviceID` and `reason`, bypassing the ordinary Kinex queue and approvals.

Tools are rediscovered on every call. Stable server instructions guide discovery
before robotics work and after resume/compaction. Discovery returns complete live
context; other calls append changed sections. There is no per-turn context
injection or compaction hook; Codex's discovery and output limits still apply.
Images are returned as bytes, limited to 10 MiB each and 20 MiB per response;
missing, unsupported or oversized images produce explicit omission messages.

Core permission rules are read on every request: `allow` permits, `deny` rejects,
and `ask` opens a Codex MCP form requiring explicit affirmation. In-tool questions
also use forms. Unsupported clients, declines and cancellations never grant
permission or invent answers. Headless actions need explicit Core allow rules.
Codex's own MCP approvals remain an additional host gate; the example exempts
only the dedicated stop tool from that gate.

Ordinary Kinex operations execute serially. Denial/cancellation invalidates queued
siblings, and stop interrupts active and queued work. Completed actions are not
rolled back or retried. This queue cannot cancel Codex coding tools or enforce a
turn-wide halt; denial results instruct the model to wait for user direction.

## Direct user controls

With Codex running, use another terminal:

```sh
/path/to/kinex-plugins/node_modules/.bin/kinex-codex control --directory /path/to/robot-workspace devices
/path/to/kinex-plugins/node_modules/.bin/kinex-codex control --directory /path/to/robot-workspace load camera
/path/to/kinex-plugins/node_modules/.bin/kinex-codex control --directory /path/to/robot-workspace record start camera=10
/path/to/kinex-plugins/node_modules/.bin/kinex-codex control --directory /path/to/robot-workspace record stop
```

`commands` lists composed commands. Device operations, stop and recording execute
without a model request. `unregister` requires typing `yes` in an interactive
terminal; non-interactive deletion is declined. Workflow commands print their
prompts for submission to Codex; they do not start a model themselves.

Controls connect through a private Unix socket to the existing server and never
create another runtime. `instances` lists matching servers; select `--instance ID`
when multiple exist. Metadata lives in the user's temporary directory, preserving
ancestor `.kinex` discovery. Ctrl-C/disconnect cancels the pending command without
disposing the server. This is a trusted local-user interface, not a model tool or
a security boundary against same-user code. Models must use permission-checked
MCP tools instead of invoking these controls through their shell.

## Recording and lifetime

Manual recording is always available. Add `--enable-recording` to the server's
arguments to expose Core's `record` tool to the model; it is absent by default.
Manual and model operations share the MCP server instance's recording identity.
The adapter does not parse Codex session files or export conversation transcripts.
Independent MCP instances own separate runtimes; use non-overlapping hardware
endpoints across instances and hosts.

Startup restores loaded devices through Core initialization lanes and reports
individual failures to stderr. EOF, SIGINT/SIGTERM and startup failure cancel
work, finalize recordings, release owned drivers and remove control endpoints.

## Public integration API

`await createCodexAdapter({directory, enableRecording?, composition?})` returns
`runtime`, `capabilities`, `sessionID`, `server`, `connect(transport)`,
`command(name, arguments, context)` and `dispose()`. Construction reads catalogs
and instructions; `connect()` restores loaded devices. Owners must dispose the
adapter on shutdown, even if it was never connected. Only the CLI installs
process handlers.

Core and setup are enabled by default, including `setup_plan`, `calib_sample`,
`calib_compute`, onboarding, calibration and ROS provisioning skills. Setup borrows
core's runtime; the adapter owns cancellation, recording and disposal. Importing
setup does not activate its bundled Pi web-search or BTW extensions.

The v1 API replaces the top-level `contributions` factory with `composition`:
`{ builtinSkillRoots?, reservedToolNames?, contributions(runtime) }`. Roots and
reserved tool names are selected before runtime construction. Custom composition
replaces the defaults; omitted roots/reservations are empty. For core only, pass
`composition: { contributions: runtime => [coreContribution(runtime)] }`.
For custom setup composition, supply `setupSkillRoots`, `setupToolNames` and
`setupContribution(createKinexSetup(runtime))` explicitly alongside core.

Default setup permissions allow local `setup_plan` changes and ask for offline
`calib_compute`; explicit rules take precedence. Samples retain device-read
permissions. Host approval gates still apply, and recording remains opt-in for
model calls. Custom compositions use core permission defaults.

## Validation

After building, `npm run test:codex` runs MCP contracts, real Codex app-server/model
requests, direct-control PTY checks and independent package relocation. Codex is
a pinned development dependency; `KINEX_CODEX_BINARY` can select another binary
for compatibility testing. Tests use mock/Python drivers and a local Responses
provider, with isolated configuration and no paid model credentials.
