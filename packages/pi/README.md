# @kinex/pi

Thin Pi 1.2.0 integration for the shared `@kinex/mcp` runtime. Install the published
package with `pi install npm:@kinex/pi@1.0.0`, then open Pi in the robot workspace.

Pi's native MCP extension launches and owns the shared server. This extension
supplies approval/questionnaire dialogs and three direct user commands:

- `/kinex-start`: activate robotics without a model round trip.
- `/kinex-status`: show the current runtime state.
- `/kinex-end`: cancel and dispose robotics while keeping Pi open.

Shared skills expose onboarding, registration, calibration and robotics guidance.
Agent calls use the same MCP tools as Claude Code and Codex. The runtime remains
inactive until explicitly started. Start/end/start creates a fresh session.

Pi's tool pipeline owns default approvals, so permission extensions such as
`pi-automode` can review the full MCP call and approve or block it. Kinex does not
ask again for `exec`, controller tools or runtime activation. Explicit Kinex
`ask`/`deny` rules still take precedence over these defaults, and malformed rules
still ask. Questionnaires remain interactive. Without a permission extension,
Pi's normal behavior applies: tool calls proceed without default approval prompts.

Launch with `pi --kinex-permission-mode kinex` to opt back into Kinex's default
approval dialogs. `/kinex-status` reports the effective mode. Restart Pi after
updating the plugin to launch a new MCP process with the selected mode.

The dialog bridge uses an authenticated private Unix socket, closes on Pi session
shutdown, cancels dialogs when calls disconnect and declines when UI is unavailable.
It does not own device state. If a user-configured MCP server named `kinex` overrides
this extension's registration, direct commands cannot address that unrelated server;
remove the conflicting entry to use this integration.

`--kinex-recording` enables Kinex's recording behavior for this server. Node
>=22.22.2 and local Linux/macOS are required. See the root README for source builds,
local tarball installation, validation and synchronized updates.
