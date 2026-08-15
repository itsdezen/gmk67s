#!/usr/bin/env bun
/**
 * @fileoverview GMK67-S diagnostic + config dump tool.
 * Runs a protocol handshake test sequence and prints a per-field config dump.
 */

import {
  openDevice,
  drainDevice,
  trySend,
  sendConfigFrame,
  delay,
  findDeviceInfo,
  checksum,
  readConfigFromDevice,
  parseConfigBuffer,
} from "./lib/device.js";
import type { HidDevice } from "./lib/device.js";

function printConfigDump(configBuffer: Buffer): void {
  console.log("\n--- Raw hex (48 bytes) ---");
  console.log(configBuffer.toString("hex").match(/.{1,32}/g)!.join("\n"));

  const c = parseConfigBuffer(configBuffer);
  console.log("\n--- Parsed fields ---");
  console.log(`Byte  0: 0x${configBuffer[0].toString(16).padStart(2, "0")}`);
  console.log(
    `Underglow: effect=0x${c.underglow.effect.toString(16).padStart(2, "0")} ` +
    `brightness=${c.underglow.brightness} speed=${c.underglow.speed} ` +
    `orient=${c.underglow.orientation} rainbow=${c.underglow.rainbow} ` +
    `RGB(${c.underglow.hue.red},${c.underglow.hue.green},${c.underglow.hue.blue})`
  );
  console.log(`Byte 21 (winlock): ${c.winlock}`);
  console.log(
    `LED: mode=0x${c.led.mode.toString(16).padStart(2, "0")} sat=${c.led.saturation} ` +
    `rainbow=${c.led.rainbow} color=${c.led.color}`
  );
  console.log(`Byte 33 (showImage): ${c.showImage}`);
  console.log(`Byte 34 (image1Frames): ${c.image1Frames}`);
  console.log(
    `Time: sec=${c.time.second} min=${c.time.minute} hour=${c.time.hour} ` +
    `dow=${c.time.dayOfWeek} date=${c.time.date} month=${c.time.month} year=${c.time.year} (BCD)`
  );
  console.log(`Frame duration: ${c.frameDuration} ms`);
  console.log(`Byte 46 (image2Frames): ${c.image2Frames}`);
}

async function runDiagnostics(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║   GMK67-S Comprehensive Device Diagnostic Tool     ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  let device: HidDevice | undefined;
  let testsPassed = 0;
  let testsFailed = 0;

  try {
    // TEST 1: Device Detection
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 1: Device Detection                        │");
    console.log("└─────────────────────────────────────────────────┘");

    const info = findDeviceInfo();
    if (!info) {
      console.error("✗ FAILED: Device not found!");
      console.error("  Expected VID: 0x320f (12815)");
      console.error("  Expected PID: 0x5055 (20565)");
      console.error("\n  Troubleshooting:");
      console.error("  - Ensure GMK67-S keyboard is connected via USB");
      console.error("  - Try a different USB port");
      console.error("  - Check if another app has exclusive access");
      console.error("  - On Linux, verify udev rules (see README)");
      process.exit(1);
    }

    console.log("✓ PASSED: Device found!");
    console.log(`  Vendor ID:    0x${info.vendorId.toString(16).padStart(4, '0')} (${info.vendorId})`);
    console.log(`  Product ID:   0x${info.productId.toString(16).padStart(4, '0')} (${info.productId})`);
    console.log(`  Path:         ${info.path}`);
    console.log(`  Manufacturer: ${info.manufacturer || "N/A"}`);
    console.log(`  Product:      ${info.product || "N/A"}`);
    console.log(`  Serial:       ${info.serialNumber || "N/A"}`);
    testsPassed++;
    console.log();

    // TEST 2: Device Connection
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 2: Device Connection                       │");
    console.log("└─────────────────────────────────────────────────┘");

    try {
      device = openDevice();
      console.log("✓ PASSED: Device opened successfully!");
      testsPassed++;
    } catch (e) {
      console.error("✗ FAILED: Could not open device!");
      console.error(`  Error: ${(e as Error).message}`);
      testsFailed++;
      process.exit(1);
    }
    console.log();

    // TEST 3: Spontaneous Messages
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 3: Spontaneous Device Messages            │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("Listening for 2 seconds...");

    const spontaneous: string[] = [];
    device.on('data', (data: Buffer) => {
      spontaneous.push(Buffer.from(data).toString('hex'));
    });

    await delay(2000);
    device.removeAllListeners('data');

    if (spontaneous.length > 0) {
      console.log(`⚠ WARNING: Device sent ${spontaneous.length} spontaneous message(s)`);
      console.log("  This may indicate stale data in the buffer.");
      spontaneous.slice(0, 3).forEach((msg, i) => {
        console.log(`  [${i + 1}] ${msg.substring(0, 48)}...`);
      });
      console.log("  → Buffer draining will handle this automatically.");
    } else {
      console.log("✓ PASSED: No spontaneous messages (buffer clean)");
      testsPassed++;
    }
    console.log();

    // TEST 4: Buffer Draining
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 4: Buffer Draining                         │");
    console.log("└─────────────────────────────────────────────────┘");

    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`✓ PASSED: Drained ${stale.length} stale message(s)`);
      stale.slice(0, 3).forEach((msg, i) => {
        console.log(`    [${i + 1}] ${msg.substring(0, 48)}...`);
      });
    } else {
      console.log("✓ PASSED: Buffer was already clean");
    }
    testsPassed++;
    console.log();

    // TEST 5: Checksum Calculation
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 5: Checksum Calculation                    │");
    console.log("└─────────────────────────────────────────────────┘");

    const testBuf = Buffer.alloc(64, 0x00);
    testBuf[0] = 0x04;
    testBuf[3] = 0x01;
    const chk = checksum(testBuf);
    testBuf[1] = chk & 0xff;
    testBuf[2] = (chk >> 8) & 0xff;

    console.log(`  Test packet:  ${testBuf.slice(0, 8).toString('hex')}`);
    console.log(`  Checksum:     0x${chk.toString(16).padStart(4, '0')} (${chk})`);

    let verifySum = 0;
    for (let i = 3; i < 64; i++) {
      verifySum = (verifySum + (testBuf[i] & 0xff)) & 0xffff;
    }

    if (verifySum === chk) {
      console.log("✓ PASSED: Checksum calculation verified");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Checksum mismatch!");
      testsFailed++;
    }
    console.log();

    // TEST 6: INIT Command (0x01) x2
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 6: INIT Command (0x01) x2                 │");
    console.log("└─────────────────────────────────────────────────┘");

    let success = await trySend(device, 0x01, undefined, 1);
    if (success) {
      console.log("✓ PASSED: First INIT acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: First INIT not acknowledged");
      testsFailed++;
    }
    await delay(10);

    success = await trySend(device, 0x01, undefined, 1);
    if (success) {
      console.log("✓ PASSED: Second INIT acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Second INIT not acknowledged");
      testsFailed++;
    }
    await delay(10);
    console.log();

    // TEST 7: Configuration Frame (0x06)
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 7: Configuration Frame (0x06)             │");
    console.log("└─────────────────────────────────────────────────┘");

    const now = new Date();
    console.log(`  Setting time: ${now.toLocaleString()}`);
    console.log(`  Target display: 0 (no display change)`);

    success = await sendConfigFrame(device, 0, 1, 1);
    if (success) {
      console.log("✓ PASSED: Config frame acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Config frame not acknowledged");
      testsFailed++;
    }
    await delay(50);
    console.log();

    // TEST 8: COMMIT Command (0x02)
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 8: COMMIT Command (0x02)                  │");
    console.log("└─────────────────────────────────────────────────┘");

    success = await trySend(device, 0x02, undefined, 1);
    if (success) {
      console.log("✓ PASSED: COMMIT command acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: COMMIT command not acknowledged");
      testsFailed++;
    }
    await delay(50);
    console.log();

    // TEST 9: Ready Signal (0x23)
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 9: Ready Signal (0x23)                    │");
    console.log("└─────────────────────────────────────────────────┘");

    success = await trySend(device, 0x23, undefined, 1);
    if (success) {
      console.log("✓ PASSED: Ready signal acknowledged");
      testsPassed++;
    } else {
      console.error("✗ FAILED: Ready signal not acknowledged");
      testsFailed++;
    }
    await delay(50);
    console.log();

    // TEST 10: Response Timing
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 10: Response Timing Analysis              │");
    console.log("└─────────────────────────────────────────────────┘");
    console.log("Measuring response times for 10 commands...");

    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await trySend(device, 0x01, undefined, 1);
      timings.push(Date.now() - start);
      await delay(5);
    }

    const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`  Average: ${avgTiming.toFixed(1)}ms  Min: ${Math.min(...timings)}ms  Max: ${Math.max(...timings)}ms`);

    if (avgTiming < 200) {
      console.log("✓ PASSED: Response times are good");
      testsPassed++;
    } else {
      console.log("⚠ WARNING: Response times are slow — may cause upload issues");
    }
    console.log();

    // TEST 11: Config Dump (read-only, per-field breakdown)
    console.log("┌─────────────────────────────────────────────────┐");
    console.log("│ TEST 11: Config Dump (read-only)                │");
    console.log("└─────────────────────────────────────────────────┘");
    try {
      const configBuffer = await readConfigFromDevice(device);
      printConfigDump(configBuffer);
      console.log("\n✓ PASSED: Config read and parsed");
      testsPassed++;
    } catch (e) {
      console.error(`✗ FAILED: Config dump failed: ${(e as Error).message}`);
      testsFailed++;
    }
    console.log();

    // Summary
    console.log("╔═══════════════════════════════════════════════════╗");
    console.log("║              DIAGNOSTIC SUMMARY                   ║");
    console.log("╚═══════════════════════════════════════════════════╝");
    console.log();
    console.log(`  Tests Passed:  ${testsPassed}`);
    console.log(`  Tests Failed:  ${testsFailed}`);
    console.log(`  Total Tests:   ${testsPassed + testsFailed}`);
    console.log();

    if (testsFailed === 0) {
      console.log("✓ ALL TESTS PASSED!");
      console.log();
      console.log("Next steps:");
      console.log("  1. Upload an image:  bun src/sendImageMagick.ts image.png");
      console.log("  2. Configure lights: bun src/configureLights.ts --effect rainbow-cycle");
      console.log("  3. Sync time:        bun src/timesync.ts");
    } else {
      console.log("✗ SOME TESTS FAILED");
      console.log();
      console.log("Troubleshooting steps:");
      console.log("  1. Unplug the keyboard and plug it back in");
      console.log("  2. Try a different USB port or cable");
      console.log("  3. Close any other applications accessing the keyboard");
      console.log("  4. On Linux, check udev rules (see README)");
      console.log("  5. Restart your computer");
    }
    console.log();
  } catch (err) {
    console.error("\n✗ DIAGNOSTIC FAILED WITH ERROR:");
    console.error(err);
    process.exit(1);
  } finally {
    if (device) {
      try {
        device.close();
        console.log("Device connection closed.");
      } catch {
        // Ignore close errors
      }
    }
  }
}

runDiagnostics().catch((err) => {
  console.error("\n✗ Fatal error:");
  console.error(err);
  process.exit(1);
});
