# @kinex/pi

Kinex robotics in native Pi, tested with Pi **1.1.0** and Node >=22.22.2.
Standalone Kinex owns its independent Pi integration.
It does not replace Pi's coding tools, UI identity, credentials or configuration.

## Install before npm publication

Build the workspace and pack it with `npm run pack -- /tmp/kinex-plugins-release`.
Install core and the Pi adapter together in an external directory:

```sh
npm install --prefix /path/to/kinex-plugins \
  /tmp/kinex-plugins-release/kinex-core-1.0.0-*.tgz \
  /tmp/kinex-plugins-release/kinex-setup-1.0.0-*.tgz \
  /tmp/kinex-plugins-release/kinex-pi-1.0.0.tgz
pi install /path/to/kinex-plugins/node_modules/@kinex/pi
```

For development, run `pi -e /absolute/path/to/kinex-plugins/packages/pi/dist/index.js`.
After registry publication, the native install form will be `pi install npm:@kinex/pi`.
The Pi packages are peer dependencies, not bundled copies of the harness.

## Use

`/devices`, `/load camera`, `/unload camera`, `/ping camera`, `/stop`,
`/unregister camera`, and `/record ...` execute directly without a model request.
`/onboarding`, `/register` and `/calibrate` submit guided workflows.
Every robotics command has a `/kinex-NAME` alias; existing host commands win
unprefixed name collisions. Use `/unload camera` then `/load camera` for device restart;
Pi's `/reload` retains its resource reload behavior.

`/kinex-mode ask|auto|yolo` controls **Kinex tools only**. Default ask uses core
permissions and the Pi permission dialog. Auto allows Kinex requests; yolo also
disables Kinex questionnaires. Headless asks without a configured allow are denied.
Start Pi with `--kinex-recording` to expose recording to the model. Manual `/record`
does not require that flag. Deleting a device still requires confirmation.

Device, recording, stop and key controller calls show concise argument headers;
Pi's tool-expansion control reveals full arguments and returned results. Recording
shows a red `rec: <recording name>` on the right of the directory row, directly
above the model name, without adding a row. Standalone Kinex maintains its own presentation. Model `device`/`record` results default to `verbose: true`;
false omits empty optional fields. Manual `/record` defaults to false; use
`/record status --verbose` (or `--verbose` immediately after another action) for
full output. All Kinex tool JSON results use two-space indentation through the
first two levels and keep deeper values inline, including tools without custom
argument summaries.

Tools and skill catalogs refresh inside a task after complete tool batches.
`kinex_skill` loads skills from any enabled Kinex feature. Conflicting model tools
use a `kinex_` prefix; unresolved collisions are reported in context.
Changing tool schemas remains subject to Pi's provider/cache behavior.

Context updates are stored as custom session entries and projected at stable
message positions through Pi's public `context` hook. Native Pi keeps its default
compaction; the first subsequent request reads a fresh complete robotics snapshot.
Standalone's extra compaction-summary rules remain application-specific.
Same-workspace session switches retain devices and finish the outgoing recording;
switching workspace, extension reload and quit dispose the runtime. Python remains workspace-local and lazy.

## Feature composition

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
