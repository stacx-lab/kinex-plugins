---
name: kinex-calibrate
description: Resolve calibration requirements for an active Kinex robotics workspace.
---

Check `kinex_status`; if inactive, ask the user to start Kinex. Fetch `kinex_tools(workflow="calibrate", arguments="REQUESTED SCOPE")`, substituting the actual scope. Follow the current workflow and retrieve detailed procedures through `kinex_tools(skill="NAME")`. Use permission-checked tools and preserve returned calibration evidence.
