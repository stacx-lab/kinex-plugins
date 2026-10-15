---
name: kinex-onboarding
description: Connect and prepare a robotics workspace with Kinex onboarding.
---

Check `kinex_status`; if inactive, ask the user to start Kinex. Fetch `kinex_tools(workflow="onboarding", arguments="USER REQUEST")`, substituting the actual request. Follow that current workflow using `kinex_tools` discovery and permission-checked `kinex_call`. Load detailed skills on demand. Do not copy or substitute a procedure from memory.
