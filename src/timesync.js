#!/usr/bin/env node
/**
 * @fileoverview Time synchronization utility for the GMK67-S keyboard.
 * Sends the current system time to the device's internal clock.
 */

import {
  findVerifiedDeviceInfo,
  syncTime,
} from "./lib/device.js";

async function main() {
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

  console.log("Syncing time (preserving lighting and image settings)...");
  const success = await syncTime();
  if (!success) {
    console.error("✗ Time sync failed (rolled back to previous settings if possible)");
    process.exit(1);
  }
  console.log("✓ Time synchronized successfully");
}

const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { syncTime } from "./lib/device.js";
