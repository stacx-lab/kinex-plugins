---
name: kinex-register
description: Register a robot, camera or other device in an active Kinex workspace.
---

Check `kinex_status`; if inactive, ask the user to start Kinex. Fetch `kinex_tools(workflow="register", arguments="USER REQUEST")`, substituting the actual request. Follow the returned guidance with current tool schemas and permission-checked `kinex_call`; do not run trusted control commands through the shell.
