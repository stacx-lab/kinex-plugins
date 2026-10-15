# @kinex/mcp

Shared Kinex runtime integration for Pi, Claude Code and Codex. The host starts a
stdio process automatically. Connecting it does not start robotics.

```sh
kinex-mcp serve [--directory /path/to/workspace] [--enable-recording]
```

Workspace resolution: `--directory` > `KINEX_WORKSPACE` > working directory.
Standard output is exclusively MCP protocol traffic; diagnostics go to stderr.
No TCP daemon or network listener is required. Trusted user control and the Pi
approval bridge use private local Unix sockets.

## Model tools

| Tool | Purpose |
| --- | --- |
| `kinex_start` | Explicit activation; Kinex `runtime_start` permission applies. |
| `kinex_status` | Lifecycle, active session, activation failures and recording status. |
| `kinex_shutdown` | Cancel and dispose robotics; keep the host/server available. |
| `kinex_tools` | Summaries; `tool` for a schema, `skill` or `workflow` for guidance, `context` for current state. |
| `kinex_call` | Execute `{name, arguments}` against the current permission-checked catalog. |
| `kinex_stop` | Interrupt queued/active operations and stop actuators without a Kinex approval prompt. |

`kinex_tools` and `kinex_call` require active Kinex. Start is idempotent while active;
restart after shutdown creates a new runtime. Cleanup failure blocks restart to
avoid overlapping runtimes. Stop is an inactive no-op; during activation it cancels
activation. A host may impose its own approval before dispatching any MCP call.

Tools, custom workspace tools, skills and setup workflows are discovered from
core/setup at request time. Full schemas and context are not injected into every
turn. After compaction/resume, retrieve discovery and full context again.

Kinex approvals and questionnaires use MCP form elicitation. Pi supplies the
fallback dialog bridge. Noninteractive clients must explicitly configure Kinex
permissions for unattended actions; absent interaction declines requests.

## Direct user control

While a host is connected, a user may run:

```sh
kinex-mcp control --directory /path/to/workspace start
kinex-mcp control --directory /path/to/workspace status
kinex-mcp control --directory /path/to/workspace commands
kinex-mcp control --directory /path/to/workspace end
```

With multiple matching hosts, run `control instances` and select `--instance ID`.
These commands address the existing runtime, never a separate robot process.
They are trusted user commands: model instructions must use the MCP tools instead.
Destructive direct commands still honor their confirmation requirements.

## Local tarballs before publication

From the repository, build and pack first, then install:

```sh
npm install --prefix /tmp/kinex-install \
  /tmp/kinex-plugins-release/kinex-core-*.tgz \
  /tmp/kinex-plugins-release/kinex-setup-*.tgz \
  /tmp/kinex-plugins-release/kinex-mcp-*.tgz
```

In a development copy of the host plugin, set `.mcp.json` to:

```json
{
  "mcpServers": {
    "kinex": {
      "command": "/tmp/kinex-install/node_modules/.bin/kinex-mcp",
      "args": ["serve", "--directory", "/path/to/workspace"]
    }
  }
}
```

Install that plugin through the host, or use `claude --plugin-dir /path/to/copy`.
Use absolute paths. The package works after relocation without the standalone
Kinex repository. See the root README for release and update procedures.
