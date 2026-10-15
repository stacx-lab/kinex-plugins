---
name: kinex-robotics
description: Operate robots, cameras and simulators using Kinex devices and Python tools.
---

Call `kinex_status`. If inactive, ask the user to start Kinex; do not activate implicitly. When active, read `kinex_tools` and `kinex_tools(context="full")` before robotics work and after resume or compaction. Request `tool="NAME"` for a current schema and `skill="NAME"` for relevant guidance, then execute through `kinex_call`. Use `kinex_stop` for immediate motion stop. Denial or cancellation means wait for user direction. Trusted `kinex-mcp control` commands are user-only; never use them from model shell tools. Model recording requires server opt-in.
