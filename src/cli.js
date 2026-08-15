#!/usr/bin/env node
/**
 * @fileoverview Single-entry CLI dispatcher: `gmk67s <subcommand> [args...]`.
 * Each subcommand runs the existing standalone script as a child process
 * (stdio inherited) so its argument parsing and behavior stay exactly as-is —
 * this file only routes, it doesn't reimplement any command logic.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUBCOMMANDS = {
  upload: "sendImageMagick.js",
  lights: "configureLights.js",
  preset: "loadPreset.js",
  timesync: "timesync.js",
  diagnostic: "diagnostic.js",
  "restore-factory": "restoreFactory.js",
  tui: "tui.js",
};

function printHelp() {
  console.log(`
gmk67s — GMK67-S keyboard CLI

Usage: gmk67s <subcommand> [options]

Subcommands:
  upload            Upload a static image or GIF to the LCD
  lights            Configure underglow/LED via flags
  preset            Apply a named lighting preset
  timesync          Sync system time to the keyboard's RTC
  diagnostic        Protocol handshake tests + read-only config dump
  restore-factory   Restore the FACTORY_CONFIG baseline (prompts for confirmation)
  tui               Interactive terminal UI

Run "gmk67s <subcommand> --help" for subcommand-specific options where supported.
See SPEC.md for the underlying protocol and README.md for full usage.
  `);
}

const [subcommand, ...rest] = process.argv.slice(2);

if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  printHelp();
  process.exit(subcommand ? 0 : 1);
}

const scriptFile = SUBCOMMANDS[subcommand];
if (!scriptFile) {
  console.error(`Unknown subcommand: "${subcommand}"\n`);
  printHelp();
  process.exit(1);
}

const scriptPath = path.join(__dirname, scriptFile);
const result = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: "inherit" });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
