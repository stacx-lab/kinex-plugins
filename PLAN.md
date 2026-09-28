# Current work

## Flat end-effector actions

- [x] Refresh core for flat gripper/suction action sequences.
- [x] Verify snapshot integrity, typecheck and all 36 host tests.

## Track inline Python

- [x] Refresh the core snapshot for inline track stages.
- [x] Verify integrity, typecheck and all 36 host tests.
- [x] Execute all four inline stages through the installed core with mock world time.

## Builtin tool composition

- [x] Update Pi summaries for devices and servo.
- [x] Refresh the core snapshot; integrity, typecheck and all 36 host tests passed.

## World-time control

- [x] Refresh the packed core snapshot to 0.8.2 for the LIBERO workspace.
- [x] Validate snapshot integrity, typecheck and all 36 host tests.

## Separate plugin project

- [x] Move Pi, OpenCode and Codex integrations with their public entrypoints.
- [x] Add independent npm installation, builds, tests and release workflows.
- [x] Consume a packed core snapshot with integrity and source provenance.
- [x] Keep existing host versions and plugin APIs unchanged.
- [x] Validate clean installs, real host loading, lifecycle and relocated packages.

Core updates are explicit. Core source and standalone remain in Kinex. This
migration does not upgrade any host SDK or publish packages.

Validation: clean `npm ci`, snapshot integrity, typecheck/build and all 36 tests
passed in an isolated copy with no sibling Kinex checkout. Tests include real Pi,
OpenCode and Codex hosts and separate relocated installs for all three plugins.
Packaging produced the three plugins, core snapshot, provenance and checksums.
LIBERO launch paths were updated and checked without restarting hosts.
