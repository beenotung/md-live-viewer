#!/usr/bin/env node
// Launcher for the bundled server. Kept as plain .js so the published
// package runs on any supported Node without type-stripping.
import { start } from '../dist/server.js'

start().catch(error => {
  console.error(error)
  process.exit(1)
})
