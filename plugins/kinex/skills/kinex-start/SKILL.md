---
name: kinex-start
description: Start the Kinex robotics runtime when the user explicitly requests activation.
---

Call the connected Kinex server’s `kinex_start` tool. Report its state and any device activation failures. If active, discover capabilities with `kinex_tools` and read `context="full"`. Do not bypass a denied activation through shell commands.
