#!/usr/bin/env node
/**
 * @fileoverview Factory-default restore utility for the GMK67-S keyboard.
 * Writes the FACTORY_CONFIG baseline (see lib/device.js, SPEC.md) with the
 * current time, and rolls back to the prior config if the write fails to ACK.
 *
 * Erases the current configuration — prompts for confirmation unless --yes/--force.
 */

import { findVerifiedDeviceInfo, restoreFactoryDefaults } from "./lib/device.js";

async function main() {
  const args = process.argv.slice(2);
  const assumeYes = args.includes("--yes") || args.includes("--force") || args.includes("-y");

  let info;
  try {
    info = findVerifiedDeviceInfo();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log(
    `Device Found: ${info.product || "(unknown name)"} | VID: ${info.vendorId.toString(16)} PID: ${info.productId.toString(16)}`
  );

  console.log("Restoring factory default configuration...");
  const success = await restoreFactoryDefaults(null, { assumeYes });
  if (!success) {
    console.error("✗ Factory restore not completed (cancelled, or rolled back to previous settings after a write failure)");
    process.exit(1);
  }
  console.log("✓ Factory defaults restored successfully");
}

const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { restoreFactoryDefaults } from "./lib/device.js";
