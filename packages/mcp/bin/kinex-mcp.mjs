#!/usr/bin/env node
import { main } from '../dist/cli.js'
await main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
