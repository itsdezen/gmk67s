#!/usr/bin/env bun
/**
 * @fileoverview Preset loader for GMK67-S keyboard configurations.
 * Allows quick loading of predefined lighting configurations.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { configureLighting } from "./lib/device.js";
import type { ConfigChanges } from "./lib/device.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Preset {
  description: string;
  config: ConfigChanges;
}

interface PresetsFile {
  presets: Record<string, Preset>;
}

function loadPresets(presetsPath?: string): PresetsFile {
  const defaultPath = path.join(__dirname, "../presets.json");
  const filePath = presetsPath || defaultPath;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Presets file not found: ${filePath}`);
  }

  const data = fs.readFileSync(filePath, "utf8");
  return JSON.parse(data);
}

function listPresets(presets: PresetsFile): void {
  console.log("\n📋 Available Presets:\n");
  const entries = Object.entries(presets.presets);

  entries.forEach(([name, preset]) => {
    console.log(`  🎨 ${name}`);
    console.log(`     ${preset.description}\n`);
  });

  console.log(`Total: ${entries.length} presets\n`);
}

/**
 * Applies a preset configuration
 * @param presetName - Name of preset to apply
 * @param presetsPath - Optional custom presets file path
 * @returns True if preset was successfully applied
 */
async function applyPreset(presetName: string, presetsPath?: string): Promise<boolean> {
  const presets = loadPresets(presetsPath);
  const preset = presets.presets[presetName];

  if (!preset) {
    throw new Error(
      `Preset "${presetName}" not found. Use --list to see available presets.`
    );
  }

  console.log(`\n🎨 Applying preset: ${presetName}`);
  console.log(`   ${preset.description}\n`);

  return await configureLighting(preset.config);
}

interface CliArgs {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args.preset = arg;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    let key: string, value: string | boolean;

    if (eqIndex !== -1) {
      key = arg.slice(2, eqIndex);
      value = arg.slice(eqIndex + 1);
    } else {
      key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i++;
      } else {
        value = true;
      }
    }

    args[key] = value;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help || args.h) {
    console.log(`
GMK67-S Preset Loader

Usage: bun src/loadPreset.ts [preset-name] [options]
   or: bun run preset [preset-name]

Options:
  --list, -l              List all available presets
  --file <path>           Use custom presets file
  --help, -h              Show this help message

Examples:
  bun src/loadPreset.ts gaming
  bun src/loadPreset.ts --list
  bun src/loadPreset.ts party --file ./my-presets.json
  bun run preset gaming
    `);
    return;
  }

  try {
    if (args.list || args.l) {
      const presets = loadPresets(typeof args.file === "string" ? args.file : undefined);
      listPresets(presets);
      return;
    }

    if (!args.preset) {
      console.error("❌ Error: Preset name required");
      console.log("Usage: bun src/loadPreset.ts [preset-name]");
      console.log("       Use --list to see available presets");
      process.exit(1);
    }

    const success = await applyPreset(args.preset as string, typeof args.file === "string" ? args.file : undefined);

    if (success) {
      console.log("\n✅ Preset applied successfully!\n");
    } else {
      console.log("\n⚠️  Preset write failed (rolled back to previous settings if possible)\n");
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { loadPresets, applyPreset, listPresets };
