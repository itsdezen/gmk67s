/**
 * @fileoverview Low-level device communication library for the GMK67-S keyboard.
 * Handles HID protocol, device detection, connection management, command sending,
 * frame building, and complete upload pipelines. See SPEC.md for the full
 * protocol reference (opcodes, report layout, config buffer offsets).
 */

import HID from "node-hid";
import type { Device as HidDeviceInfo } from "node-hid";
import { Jimp, intToRGBA } from "jimp";
import { confirmAction } from "./confirm.js";

type HidDevice = InstanceType<typeof HID.HID>;

/** USB Vendor ID — confirmed on real hardware via `ioreg` */
const VENDOR_ID = 0x320f;

/** USB Product ID — confirmed on real hardware via `ioreg` */
const PRODUCT_ID = 0x5055;

/** Expected USB product name, matched loosely (case-insensitive substring) */
const EXPECTED_PRODUCT_NAME = "ZUOYA GMK67-S";

/** HID Report ID used for all communications */
const REPORT_ID = 0x04;

/** Number of data bytes per frame packet */
const BYTES_PER_FRAME = 0x38;

// GMK67-S LCD: 128x128 (1:1), RGB565. Confirmed on real hardware — 128x128
// renders correctly; a diagonal-shear test pattern ruled out every other
// candidate size. See SPEC.md.
const DISPLAY_WIDTH = 128;
const DISPLAY_HEIGHT = 128;

/** Enable verbose protocol debug logging. Set via DEBUG=1 env var. */
let DEBUG = process.env.DEBUG === "1";

/** Toggle debug logging at runtime */
function setDebug(enabled: boolean): void {
  DEBUG = !!enabled;
}

// -------------------------------------------------------
// Common Utilities
// -------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Converts RGB color values to RGB565 format (16-bit color)
 */
function toRGB565(r: number, g: number, b: number): number {
  const r5 = (r >> 3) & 0x1f;
  const g6 = (g >> 2) & 0x3f;
  const b5 = (b >> 3) & 0x1f;
  return (r5 << 11) | (g6 << 5) | b5;
}

/**
 * Converts a decimal number (0-99) to BCD (Binary-Coded Decimal) format
 * Used for encoding time/date values in device protocol
 */
function toHexNum(num: number): number {
  if (num < 0 || num >= 100) throw new RangeError("toHexNum expects 0..99");
  const low = num % 10;
  const high = Math.floor(num / 10);
  return (high << 4) | low;
}

// -------------------------------------------------------
// Config Types
// -------------------------------------------------------

interface UnderglowHue {
  red?: number;
  green?: number;
  blue?: number;
}

interface UnderglowConfig {
  effect?: number;
  brightness?: number;
  speed?: number;
  orientation?: number;
  rainbow?: number;
  hue?: UnderglowHue;
}

interface LedConfig {
  mode?: number;
  saturation?: number;
  rainbow?: number;
  color?: number;
}

interface ConfigChanges {
  underglow?: UnderglowConfig;
  winlock?: number;
  led?: LedConfig;
  showImage?: number;
  image1Frames?: number;
  image2Frames?: number;
  time?: boolean;
  frameDuration?: number;
}

interface ParsedTime {
  second: number;
  minute: number;
  hour: number;
  dayOfWeek: number;
  date: number;
  month: number;
  year: number;
}

interface ParsedConfig {
  underglow: {
    effect: number;
    brightness: number;
    speed: number;
    orientation: number;
    rainbow: number;
    hue: { red: number; green: number; blue: number };
  };
  winlock: number;
  led: {
    mode: number;
    saturation: number;
    rainbow: number;
    color: number;
  };
  showImage: number;
  image1Frames: number;
  time: ParsedTime;
  frameDuration: number;
  image2Frames: number;
  _raw: Buffer;
}

interface UploadOptions {
  showAfter?: boolean;
  frameDuration?: number;
}

interface KeyboardInfo {
  manufacturer: string;
  product: string;
  vendorId: number;
  productId: number;
}

// -------------------------------------------------------
// Device Detection & Connection
// -------------------------------------------------------

/**
 * Searches for the GMK67-S device in the system's HID device list
 * @returns HID device info object if found, undefined otherwise
 */
function findDeviceInfo(): HidDeviceInfo | undefined {
  const devices = HID.devices();

  const matching = devices.filter(
    (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID
  );
  if (DEBUG) {
    console.log(`Found ${matching.length} GMK67-S HID interface(s):`);
    matching.forEach((d) =>
      console.log(`  interface=${d.interface} usagePage=0x${(d.usagePage || 0).toString(16)} path=${d.path}`)
    );
  }

  // The vendor-specific config/upload protocol lives on USB interface 3.
  // Opening by specific interface avoids macOS requiring sudo for keyboard interfaces.
  const configInterface = matching.find((d) => d.interface === 3);
  if (configInterface) return configInterface;

  return matching[0];
}

/**
 * Finds the GMK67-S device and verifies it before any protocol command is
 * allowed to touch it. VID/PID alone isn't a hard guarantee — this also
 * cross-checks the USB product string when the OS/driver provides one, and
 * refuses to proceed rather than risk sending commands to the wrong device.
 * @returns Verified HID device info
 * @throws If no matching device is found, or the product name doesn't match
 */
function findVerifiedDeviceInfo(): HidDeviceInfo {
  const info = findDeviceInfo();
  if (!info) {
    throw new Error(
      "Không tìm thấy bàn phím GMK67-S — vui lòng cắm bàn phím và thử lại (VID 0x320f / PID 0x5055 not found)"
    );
  }

  const product = (info.product || "").trim();
  if (product && !product.toLowerCase().includes("gmk67-s") && !product.toLowerCase().includes("zuoya")) {
    throw new Error(
      `Thiết bị tìm thấy không khớp GMK67-S — VID/PID đúng (0x320f/0x5055) nhưng tên thiết bị là "${product}" thay vì "${EXPECTED_PRODUCT_NAME}". Dừng lại để tránh gửi lệnh sai thiết bị.`
    );
  }

  return info;
}

/**
 * Opens a connection to the GMK67-S device with retry logic.
 * Always goes through findVerifiedDeviceInfo() first — this is the single
 * choke point every protocol operation passes through before touching hardware.
 * @param retries - Number of retry attempts if opening fails
 * @returns Connected HID device object
 */
function openDevice(retries = 2): HidDevice {
  const info = findVerifiedDeviceInfo();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return new HID.HID(info.path!);
    } catch (e) {
      if (attempt === retries) {
        throw new Error(
          `Failed to open HID device after ${retries + 1} attempts: ${(e as Error).message}`
        );
      }
      const waitMs = 10;
      const start = Date.now();
      while (Date.now() - start < waitMs) {}
    }
  }

  throw new Error("Failed to open HID device: unreachable");
}

/**
 * Drains/clears any pending data from the device buffer
 * @param device - Connected HID device
 * @param timeoutMs - Maximum time to wait for data to drain
 * @returns Array of hex strings representing drained data
 */
async function drainDevice(device: HidDevice, timeoutMs = 200): Promise<string[]> {
  const drained: string[] = [];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const data = device.readTimeout(50);
      if (!data || data.length === 0) break;
      drained.push(Buffer.from(data).toString("hex"));
    } catch {
      break;
    }
  }
  return drained;
}

// -------------------------------------------------------
// Low-level Protocol Functions
// -------------------------------------------------------

/**
 * Calculates a 16-bit checksum for the device protocol
 * Sums bytes from position 3 to 63 in the buffer
 */
function checksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 3; i < 64; i++) {
    sum = (sum + (buf[i] & 0xff)) & 0xffff;
  }
  return sum;
}

async function readResponse(device: HidDevice, timeoutMs = 150): Promise<Buffer | null> {
  try {
    const data = device.readTimeout(timeoutMs);
    if (!data || data.length === 0) return null;
    return Buffer.from(data);
  } catch (e) {
    if (DEBUG) console.warn(`  [readResponse] HID read error: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Sends a command to the device and optionally waits for acknowledgment
 */
async function send(
  device: HidDevice,
  command: number,
  data60: Buffer | null = null,
  waitForAck = true
): Promise<boolean> {
  if (data60 === null) {
    data60 = Buffer.alloc(60, 0x00);
  }

  if (!Buffer.isBuffer(data60) || data60.length !== 60) {
    throw new Error("Invalid data length: need exactly 60 bytes");
  }

  const buf = Buffer.alloc(64, 0x00);
  buf[0] = REPORT_ID;
  buf[3] = command;
  data60.copy(buf, 4);

  const chk = checksum(buf);
  buf[1] = chk & 0xff;
  buf[2] = (chk >> 8) & 0xff;

  device.write([...buf]);

  if (!waitForAck) {
    return true;
  }

  const response = await readResponse(device, 150);

  if (!response) {
    console.warn(
      `  ⚠ No ACK for cmd 0x${command.toString(16).padStart(2, "0")}`
    );
    return false;
  }

  // On macOS, the HID driver changes report ID (byte 0) and may recalculate
  // checksums (bytes 1-2). We can't reliably compare those bytes cross-platform.
  // Instead, we verify the command byte echoes back correctly.
  if (response[3] === buf[3]) {
    return true;
  } else {
    console.warn(
      `  ✗ ACK mismatch for cmd 0x${command.toString(16).padStart(2, "0")}`
    );
    console.warn(`    Expected: ${buf.slice(0, 8).toString("hex")}`);
    console.warn(`    Received: ${response.slice(0, 8).toString("hex")}`);
    return false;
  }
}

/**
 * Attempts to send a command with automatic retry logic
 */
async function trySend(
  device: HidDevice,
  cmd: number,
  payload: Buffer | undefined = undefined,
  tries = 3
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const success =
        payload === undefined
          ? await send(device, cmd)
          : await send(device, cmd, payload);

      if (success) return true;

      if (i < tries - 1) await delay(10);
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(10);
    }
  }

  console.error(
    `Failed to send cmd 0x${cmd.toString(16).padStart(2, "0")} after ${tries} attempts`
  );
  return false;
}

// -------------------------------------------------------
// Position-addressed Protocol Functions (INIT/PREP_READ/READ_DATA/COMMIT/CONFIG/FRAME_DATA)
// -------------------------------------------------------

/**
 * Sends a command using the position-addressed protocol format (length + 24-bit position)
 * @param device - Connected HID device
 * @param commandId - Command byte (1-255)
 * @param data - Data payload (max 56 bytes)
 * @param pos - Position offset (24-bit)
 * @returns Response data from byte 4 onwards, or null if failed
 */
async function sendWithPosition(
  device: HidDevice,
  commandId: number,
  data: Buffer,
  pos = 0
): Promise<Buffer | null> {
  if (commandId < 1 || commandId > 0xff) {
    throw new Error("Command ID must be between 1 and 255");
  }
  if (data.length > 56) {
    throw new Error("Data payload cannot exceed 56 bytes");
  }

  // Device needs time to process before the COMMIT (0x02) command
  if (commandId === 2) {
    await delay(100);
  }

  const buffer = Buffer.alloc(64, 0x00);
  buffer[0] = 0x04;               // Report ID
  buffer[3] = commandId;          // Command
  buffer[4] = data.length;        // Data length
  buffer[5] = pos & 0xff;         // Position LSB
  buffer[6] = (pos >> 8) & 0xff;  // Position mid byte
  buffer[7] = (pos >> 16) & 0xff; // Position MSB

  data.copy(buffer, 8);

  const chk = checksum(buffer);
  buffer[1] = chk & 0xff;
  buffer[2] = (chk >> 8) & 0xff;

  if (DEBUG) console.log(`  [DEBUG sendWithPosition] CMD 0x${commandId.toString(16).padStart(2, "0")}: ${buffer.slice(0, 12).toString("hex")}`);
  device.write([...buffer]);

  const startTime = Date.now();
  const timeout = 30000; // 30 second overall timeout

  while (Date.now() - startTime < timeout) {
    const response = await readResponse(device, 5000);
    if (!response) {
      await delay(5);
      continue;
    }

    if (DEBUG) console.log(`  [DEBUG sendWithPosition] Response: ${response.slice(0, 12).toString("hex")}`);

    if (response[3] === buffer[3]) {
      return response.slice(4);
    }

    if (DEBUG) console.log(`  [DEBUG sendWithPosition] Discarding non-matching response (cmd: 0x${response[3].toString(16)}), continuing...`);
  }

  console.warn(`  ⚠ Timeout waiting for response to command 0x${commandId.toString(16).padStart(2, "0")}`);
  return null;
}

/**
 * Reads the current configuration from the device
 * @param device - Connected HID device
 * @returns 48-byte configuration buffer
 */
async function readConfigFromDevice(device: HidDevice): Promise<Buffer> {
  console.log("Reading configuration...");

  await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

  for (let i = 0; i < 9; i++) {
    await sendWithPosition(device, 0x03, Buffer.alloc(4, 0x00), i * 4);
  }
  await sendWithPosition(device, 0x03, Buffer.alloc(1, 0x00), 36);

  await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  const configBuffer = Buffer.alloc(48, 0x00);

  for (let i = 0; i < 12; i++) {
    const position = i * 4;
    const chunk = await sendWithPosition(device, 0x05, Buffer.alloc(4, 0x00), position);

    if (chunk && chunk.length >= 4) {
      chunk.slice(0, 4).copy(configBuffer, position);
    } else {
      console.warn(`Failed to read config chunk ${i} at position ${position}`);
    }
  }

  console.log(`✓ Configuration read (48 bytes): ${configBuffer.toString('hex')}`);
  return configBuffer;
}

/**
 * Parses 48-byte config buffer into structured object
 * @param configBuffer - 48-byte configuration
 * @returns Parsed configuration
 */
function parseConfigBuffer(configBuffer: Buffer): ParsedConfig {
  return {
    underglow: {
      effect: configBuffer[1],
      brightness: configBuffer[2],
      speed: configBuffer[3],
      orientation: configBuffer[4],
      rainbow: configBuffer[5],
      hue: {
        red: configBuffer[6],
        green: configBuffer[7],
        blue: configBuffer[8],
      },
    },
    winlock: configBuffer[21],
    led: {
      mode: configBuffer[28],
      saturation: configBuffer[29],
      rainbow: configBuffer[31],
      color: configBuffer[32],
    },
    showImage: configBuffer[33],
    image1Frames: configBuffer[34],
    time: {
      second: configBuffer[35],
      minute: configBuffer[36],
      hour: configBuffer[37],
      dayOfWeek: configBuffer[38],
      date: configBuffer[39],
      month: configBuffer[40],
      year: configBuffer[41],
    },
    frameDuration: configBuffer[43] | (configBuffer[44] << 8),
    image2Frames: configBuffer[46],
    _raw: configBuffer,
  };
}

/**
 * Builds 48-byte config buffer from existing config + changes
 * @param existingConfig - Current config (from parseConfigBuffer)
 * @param changes - Changes to apply
 * @returns Updated 48-byte configuration buffer
 */
function buildConfigBuffer(existingConfig: ParsedConfig, changes: ConfigChanges): Buffer {
  const buffer = Buffer.from(existingConfig._raw);

  if (changes.underglow) {
    if (changes.underglow.effect !== undefined) buffer[1] = changes.underglow.effect;
    if (changes.underglow.brightness !== undefined) buffer[2] = changes.underglow.brightness;
    if (changes.underglow.speed !== undefined) buffer[3] = changes.underglow.speed;
    if (changes.underglow.orientation !== undefined) buffer[4] = changes.underglow.orientation;
    if (changes.underglow.rainbow !== undefined) buffer[5] = changes.underglow.rainbow;
    if (changes.underglow.hue) {
      if (changes.underglow.hue.red !== undefined) buffer[6] = changes.underglow.hue.red;
      if (changes.underglow.hue.green !== undefined) buffer[7] = changes.underglow.hue.green;
      if (changes.underglow.hue.blue !== undefined) buffer[8] = changes.underglow.hue.blue;
    }
  }

  if (changes.winlock !== undefined) buffer[21] = changes.winlock;

  if (changes.led) {
    if (changes.led.mode !== undefined) buffer[28] = changes.led.mode;
    if (changes.led.saturation !== undefined) buffer[29] = changes.led.saturation;
    if (changes.led.rainbow !== undefined) buffer[31] = changes.led.rainbow;
    if (changes.led.color !== undefined) buffer[32] = changes.led.color;
  }

  if (changes.showImage !== undefined) buffer[33] = changes.showImage;
  if (changes.image1Frames !== undefined) buffer[34] = changes.image1Frames;
  if (changes.image2Frames !== undefined) buffer[46] = changes.image2Frames;

  if (changes.time) {
    const now = new Date();
    buffer[35] = toHexNum(now.getSeconds());
    buffer[36] = toHexNum(now.getMinutes());
    buffer[37] = toHexNum(now.getHours());
    buffer[38] = now.getDay();
    buffer[39] = toHexNum(now.getDate());
    buffer[40] = toHexNum(now.getMonth() + 1);
    buffer[41] = toHexNum(now.getFullYear() % 100);
  }

  if (changes.frameDuration !== undefined) {
    buffer[43] = changes.frameDuration & 0xff;
    buffer[44] = (changes.frameDuration >> 8) & 0xff;
  }

  return buffer;
}

/**
 * Writes config buffer to device.
 * Returns false (rather than always true) if any step fails to ACK, so callers
 * can detect write failures and trigger rollback.
 * @param device - Connected HID device
 * @param configBuffer - 48-byte configuration to write
 * @returns True only if every step of the write was acknowledged
 */
async function writeConfigToDevice(device: HidDevice, configBuffer: Buffer): Promise<boolean> {
  console.log("Writing configuration...");
  console.log(`  Writing 48 bytes: ...${configBuffer.slice(33, 47).toString('hex')}...`);
  console.log(`  Byte 33 (showImage): ${configBuffer[33]}, Byte 34 (image1Frames): ${configBuffer[34]}, Byte 46 (image2Frames): ${configBuffer[46]}`);

  const initOk = await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);
  const writeOk = await sendWithPosition(device, 0x06, configBuffer, 0);
  const commitOk = await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);

  const success = initOk !== null && writeOk !== null && commitOk !== null;
  if (success) {
    console.log("✓ Configuration written successfully");
  } else {
    console.warn("✗ Configuration write did not complete (missing ACK on one or more steps)");
  }
  return success;
}

/**
 * Writes config buffer to device, rolling back to `previousConfigBuffer` if the
 * write fails to ACK — avoids leaving the keyboard in an undefined state after
 * a partial/failed write.
 * @param device - Connected HID device
 * @param newConfigBuffer - Configuration to write
 * @param previousConfigBuffer - Configuration to restore if the write fails
 * @returns True if the new config was written successfully
 */
async function writeConfigWithRollback(
  device: HidDevice,
  newConfigBuffer: Buffer,
  previousConfigBuffer: Buffer
): Promise<boolean> {
  const success = await writeConfigToDevice(device, newConfigBuffer);
  if (success) return true;

  console.warn("Write failed — attempting rollback to previous config...");
  const rollbackOk = await writeConfigToDevice(device, previousConfigBuffer);
  if (rollbackOk) {
    console.warn("✓ Rollback succeeded (keyboard restored to prior state)");
  } else {
    console.error("WARNING: Rollback also failed. Keyboard may be in a bad state.");
    console.error("         Replug the keyboard and run restoreFactoryDefaults() to recover.");
  }
  return false;
}

// -------------------------------------------------------
// Factory Default Restore
// -------------------------------------------------------

/**
 * Factory-default 48-byte config buffer (see SPEC.md for the full field
 * breakdown). Time bytes (35-41) are overwritten with the current time on
 * restore — the stored table only needs to be correct for the non-time fields.
 */
const FACTORY_CONFIG = Buffer.from([
  0x00, 0x06, 0x09, 0x04, 0x01, 0x00, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x03, 0x07, 0x02, 0x00, 0x03, 0x02, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x01, 0x00,
]);

interface RestoreOptions {
  assumeYes?: boolean;
}

/**
 * Restores the keyboard to the FACTORY_CONFIG baseline, preserving current time.
 * Reads the current config first so a failed write can roll back.
 * Erases the current configuration, so this requires interactive confirmation
 * unless assumeYes is set.
 * @param device - Optional already-open HID device
 * @param options
 * @returns True if factory config was written successfully
 */
async function restoreFactoryDefaults(
  device: HidDevice | null = null,
  { assumeYes = false }: RestoreOptions = {}
): Promise<boolean> {
  const shouldClose = !device;
  if (!device) {
    device = openDevice();
  }

  try {
    const confirmed = await confirmAction(
      "⚠ This will ERASE the keyboard's current lighting/LCD/config settings and restore factory defaults. Continue?",
      { assumeYes }
    );
    if (!confirmed) {
      console.log("Cancelled — factory reset not performed.");
      return false;
    }

    console.log("Reading current configuration (for rollback safety)...");
    const currentConfigBuffer = await readConfigFromDevice(device);

    console.log("Restoring factory default config...");
    const factoryConfig = Buffer.from(FACTORY_CONFIG);
    const now = new Date();
    factoryConfig[35] = toHexNum(now.getSeconds());
    factoryConfig[36] = toHexNum(now.getMinutes());
    factoryConfig[37] = toHexNum(now.getHours());
    factoryConfig[38] = now.getDay();
    factoryConfig[39] = toHexNum(now.getDate());
    factoryConfig[40] = toHexNum(now.getMonth() + 1);
    factoryConfig[41] = toHexNum(now.getFullYear() % 100);

    const success = await writeConfigWithRollback(device, factoryConfig, currentConfigBuffer);
    if (success) {
      console.log("✓ Factory config restored");
    }
    return success;
  } finally {
    if (shouldClose) {
      await safeClose(device);
    }
  }
}

// -------------------------------------------------------
// Wait-until-ready logic
// -------------------------------------------------------

async function waitForReady(device: HidDevice, timeoutMs = 1000): Promise<boolean> {
  console.log("Waiting for device to report ready (0x23)...");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const resp = await readResponse(device, 100);
    if (resp && resp.length >= 4 && resp[3] === 0x23) {
      console.log(`✓ Device reported ready after ${Date.now() - start} ms`);
      return true;
    }
    await delay(10);
  }
  console.warn("⚠ Timed out waiting for ready (0x23) response");
  return false;
}

// -------------------------------------------------------
// Configuration Command
// -------------------------------------------------------

async function sendConfigFrame(
  device: HidDevice,
  shownImage = 0,
  image0NumOfFrames = 1,
  image1NumOfFrames = 1,
  preserveSettings: { underglow?: UnderglowConfig; led?: LedConfig } = {}
): Promise<boolean> {
  const now = new Date();

  const frameDurationMs = 1000;
  const frameDurationLsb = frameDurationMs & 0xff;
  const frameDurationMsb = (frameDurationMs >> 8) & 0xff;

  const command = Buffer.alloc(64, 0x00);

  const useFullConfig = preserveSettings && (preserveSettings.underglow || preserveSettings.led);
  command[0x04] = useFullConfig ? 0x30 : 0x29;

  if (useFullConfig) {
    const ug = preserveSettings.underglow || {};
    const led = preserveSettings.led || {};

    command[0x09] = ug.effect ?? 0x00;
    command[0x0a] = ug.brightness ?? 0x00;
    command[0x0b] = ug.speed ?? 0x00;
    command[0x0c] = ug.orientation ?? 0x00;
    command[0x0d] = ug.rainbow ?? 0x00;
    command[0x0e] = ug.hue?.red ?? 0x00;
    command[0x0f] = ug.hue?.green ?? 0x00;
    command[0x10] = ug.hue?.blue ?? 0x00;

    command[0x1c] = led.mode ?? 0x00;
    command[0x1d] = led.saturation ?? 0x00;
    command[0x1f] = led.rainbow ?? 0x00;
    command[0x20] = led.color ?? 0x00;
  }

  command[0x29] = shownImage;
  command[0x2a] = image0NumOfFrames;
  command[0x2b] = toHexNum(now.getSeconds());
  command[0x2c] = toHexNum(now.getMinutes());
  command[0x2d] = toHexNum(now.getHours());
  command[0x2e] = now.getDay();
  command[0x2f] = toHexNum(now.getDate());
  command[0x30] = toHexNum(now.getMonth() + 1);
  command[0x31] = toHexNum(now.getFullYear() % 100);
  command[0x33] = frameDurationLsb;
  command[0x34] = frameDurationMsb;
  command[0x36] = image1NumOfFrames;

  return await send(device, 0x06, command.subarray(4));
}

// -------------------------------------------------------
// Frame Building & Transmission
// -------------------------------------------------------

/**
 * Converts an image to raw RGB565 pixel data padded to 32KB.
 * Uses Jimp v1 API: `Jimp.read()`, `image.resize({ w, h })`, and reads bitmap
 * data directly via bitmap.width/height + intToRGBA(image.getPixelColor(x, y)).
 * @param imagePath - Path to the image file to load
 * @returns Padded buffer containing RGB565 pixel data
 */
async function buildRawImageData(imagePath: string): Promise<Buffer> {
  console.log(`Loading image: ${imagePath}`);
  const img = await Jimp.read(imagePath);

  if (img.bitmap.width !== DISPLAY_WIDTH || img.bitmap.height !== DISPLAY_HEIGHT) {
    console.log(`Resizing image to ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}...`);
    img.resize({ w: DISPLAY_WIDTH, h: DISPLAY_HEIGHT });
  }

  // Rounds up to the next 32KB boundary
  const frameSize = ((DISPLAY_WIDTH * DISPLAY_HEIGHT * 2) + 0x7fff) & ~0x7fff;
  const frameBuffer = Buffer.alloc(frameSize, 0x00);

  let idx = 0;
  for (let y = 0; y < DISPLAY_HEIGHT; y++) {
    for (let x = 0; x < DISPLAY_WIDTH; x++) {
      const { r, g, b } = intToRGBA(img.getPixelColor(x, y));
      const rgb565 = toRGB565(r, g, b);

      frameBuffer[idx++] = (rgb565 >> 8) & 0xff;
      frameBuffer[idx++] = rgb565 & 0xff;
    }
  }

  return frameBuffer;
}

/**
 * Transmits frame data to the device in 56-byte chunks with position tracking
 * NOTE: Must call sendWithPosition(0x01/0x23) upload-session start before calling this!
 */
async function sendFrameData(
  device: HidDevice,
  data: Buffer,
  label = "data",
  startPosition = 0
): Promise<void> {
  const total = data.length;
  console.log(`Uploading ${total} bytes of ${label} (starting at position ${startPosition})...`);

  let pos = 0;
  let lastProgress = -1;

  while (pos < total) {
    const size = Math.min(56, total - pos);
    const chunk = data.slice(pos, pos + size);

    const response = await sendWithPosition(device, 0x21, chunk, startPosition + pos);
    if (!response) {
      throw new Error(`Failed to send data at position ${startPosition + pos}`);
    }

    pos += size;

    const progress = Math.floor((pos / total) * 100);
    if (progress > lastProgress) {
      process.stdout.write(`\rUpload progress: ${progress}%`);
      lastProgress = progress;
    }
  }

  console.log("\n✓ Upload complete");
}

// -------------------------------------------------------
// High-Level Image Upload Pipeline
// -------------------------------------------------------

/**
 * Complete pipeline to upload image(s) (static or animated) to the GMK67-S
 * device. Every upload rewrites the device's entire image memory from byte 0
 * — there is no protocol opcode to read back an existing image, so there is
 * no such thing as "preserving the other image" across an upload. Passing a
 * single image means the device ends up with exactly one image (using the
 * full 36-frame budget); passing two images splits the budget between them.
 * Preserves lighting/LED/other settings via read-modify-write, and rolls
 * back the config write if it fails to ACK.
 * @param images - 1 or 2 entries; each entry is either a single image path
 *   or an array of frame paths (for animations)
 * @param options - Upload options
 * @returns True if upload completed successfully
 */
async function uploadImageToDevice(
  images: Array<string | string[]>,
  options: UploadOptions = {}
): Promise<boolean> {
  const { showAfter = true, frameDuration } = options;

  if (!Array.isArray(images) || images.length < 1 || images.length > 2) {
    throw new Error("uploadImageToDevice expects an array of 1 or 2 images (each a path or an array of frame paths)");
  }

  const toPathList = (entry: string | string[]): string[] => (Array.isArray(entry) ? entry : [entry]);
  const paths0 = toPathList(images[0]);
  const paths1 = images[1] !== undefined ? toPathList(images[1]) : null;

  const image1FrameCount = paths0.length;
  const image2FrameCount = paths1 ? paths1.length : 0;
  const totalFrames = image1FrameCount + image2FrameCount;

  if (totalFrames > 36) {
    throw new Error(`Too many frames: ${totalFrames} (image1: ${image1FrameCount}, image2: ${image2FrameCount}, max 36 total)`);
  }

  const shownImage = showAfter ? 1 : 0;

  let device = openDevice();

  try {
    console.log("Reading current configuration to preserve settings...");
    const configBuffer = await readConfigFromDevice(device);
    const currentConfig = parseConfigBuffer(configBuffer);
    console.log(`  Underglow: effect=${currentConfig.underglow.effect}, brightness=${currentConfig.underglow.brightness}`);
    console.log(`  LED: mode=${currentConfig.led.mode}, color=${currentConfig.led.color}`);

    console.log("Clearing device buffer...");
    const stale = await drainDevice(device);
    if (stale.length > 0) {
      console.log(`  Drained ${stale.length} stale messages`);
    }

    console.log("Building image data...");
    const image1Buffers: Buffer[] = [];
    for (const p of paths0) {
      image1Buffers.push(await buildRawImageData(p));
    }

    const image2Buffers: Buffer[] = [];
    if (paths1) {
      for (const p of paths1) {
        image2Buffers.push(await buildRawImageData(p));
      }
    }

    const concatenatedData = Buffer.concat([...image1Buffers, ...image2Buffers]);
    console.log(`  Image 1: ${image1Buffers.length} frame(s)`);
    console.log(`  Image 2: ${paths1 ? `${image2Buffers.length} frame(s)` : "not present"}`);
    console.log(`  Total: ${concatenatedData.length} bytes (${image1Buffers.length + image2Buffers.length} frames)`);

    const configChanges: ConfigChanges = {
      showImage: shownImage,
      image1Frames: image1FrameCount,
      image2Frames: image2FrameCount,
      time: true,
    };
    if (frameDuration !== undefined) {
      configChanges.frameDuration = Math.max(60, Math.min(frameDuration, 0xffff));
    }
    const newConfig = buildConfigBuffer(currentConfig, configChanges);

    console.log("Writing config to device...");
    const configWriteOk = await writeConfigWithRollback(device, newConfig, configBuffer);
    if (!configWriteOk) {
      throw new Error("Config write failed before image upload; aborted (config rolled back)");
    }

    console.log("Starting upload session (0x23 → 0x01)...");
    await sendWithPosition(device, 0x23, Buffer.alloc(0), 0);
    await sendWithPosition(device, 0x01, Buffer.alloc(0), 0);

    console.log("Uploading image data...");
    await sendFrameData(device, concatenatedData, "image data");

    const response = await sendWithPosition(device, 0x02, Buffer.alloc(0), 0);
    if (!response) console.warn("Upload COMMIT may not have been acknowledged");

    console.log("✓ Upload complete!");
    return true;
  } finally {
    await safeClose(device);
  }
}

// -------------------------------------------------------
// Lighting Configuration Functions
// -------------------------------------------------------

function buildLightingFrame(config: ConfigChanges): Buffer {
  const now = new Date();
  const buf = Buffer.alloc(64, 0x00);

  buf[0] = REPORT_ID;
  buf[3] = 0x06;
  buf[4] = 0x30;

  if (config.underglow) {
    const ug = config.underglow;
    if (ug.effect !== undefined) buf[9] = ug.effect;
    if (ug.brightness !== undefined) buf[10] = ug.brightness;
    if (ug.speed !== undefined) buf[11] = ug.speed;
    if (ug.orientation !== undefined) buf[12] = ug.orientation;
    if (ug.rainbow !== undefined) buf[13] = ug.rainbow;
    if (ug.hue) {
      if (ug.hue.red !== undefined) buf[14] = ug.hue.red;
      if (ug.hue.green !== undefined) buf[15] = ug.hue.green;
      if (ug.hue.blue !== undefined) buf[16] = ug.hue.blue;
    }
  }

  if (config.winlock !== undefined) {
    buf[29] = config.winlock;
  }

  if (config.led) {
    const led = config.led;
    if (led.mode !== undefined) buf[36] = led.mode;
    if (led.saturation !== undefined) buf[37] = led.saturation;
    if (led.rainbow !== undefined) buf[39] = led.rainbow;
    if (led.color !== undefined) buf[40] = led.color;
  }

  if (config.showImage !== undefined) {
    buf[41] = config.showImage;
  }

  if (config.image1Frames !== undefined) {
    buf[42] = config.image1Frames;
  }
  if (config.image2Frames !== undefined) {
    buf[54] = config.image2Frames;
  }

  buf[43] = toHexNum(now.getSeconds());
  buf[44] = toHexNum(now.getMinutes());
  buf[45] = toHexNum(now.getHours());
  buf[46] = toHexNum(now.getDay());
  buf[47] = toHexNum(now.getDate());
  buf[48] = toHexNum(now.getMonth() + 1);
  buf[49] = toHexNum(now.getFullYear() % 100);

  const chk = checksum(buf);
  buf[1] = chk & 0xff;
  buf[2] = (chk >> 8) & 0xff;

  return buf;
}

async function sendLightingFrame(device: HidDevice, frameData: Buffer, waitForAck = true): Promise<boolean> {
  if (!Buffer.isBuffer(frameData) || frameData.length !== 64) {
    throw new Error("Lighting frame must be exactly 64 bytes");
  }

  device.write([...frameData]);

  if (!waitForAck) {
    return true;
  }

  const response = await readResponse(device, 150);

  if (!response) {
    console.warn("  ⚠ No ACK for lighting config frame");
    return false;
  }

  const expectedAck = frameData.slice(0, 8);
  const receivedAck = response.slice(0, 8);

  if (expectedAck.equals(receivedAck)) {
    return true;
  } else {
    console.warn("  ✗ ACK mismatch for lighting config frame");
    console.warn(`    Expected: ${expectedAck.toString("hex")}`);
    console.warn(`    Received: ${receivedAck.toString("hex")}`);
    return false;
  }
}

async function trySendLightingFrame(device: HidDevice, frameData: Buffer, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const success = await sendLightingFrame(device, frameData, true);
      if (success) return true;

      if (i < tries - 1) await delay(10);
    } catch (e) {
      if (i === tries - 1) throw e;
      await delay(10);
    }
  }

  return false;
}

/**
 * Complete pipeline to configure lighting on the GMK67-S device.
 * Read-modify-write: reads current config, modifies only requested fields,
 * writes back — rolling back to the original config if the write fails to ACK.
 * @param changes - Lighting configuration changes to apply
 * @returns True if configuration was successfully applied
 */
async function configureLighting(changes: ConfigChanges, device: HidDevice | null = null): Promise<boolean> {
  const shouldClose = !device;
  if (!device) {
    device = openDevice();
  }

  try {
    console.log("Reading current configuration...");
    const currentConfigBuffer = await readConfigFromDevice(device);
    const currentConfig = parseConfigBuffer(currentConfigBuffer);

    console.log("Current settings:");
    console.log(`  Underglow: effect=${currentConfig.underglow.effect}, brightness=${currentConfig.underglow.brightness}`);
    console.log(`  LED: mode=${currentConfig.led.mode}, color=${currentConfig.led.color}`);
    console.log(`  Images: image1Frames=${currentConfig.image1Frames}, image2Frames=${currentConfig.image2Frames}`);

    console.log("\nApplying changes (preserving other settings)...");
    const newConfig = buildConfigBuffer(currentConfig, changes);

    const success = await writeConfigWithRollback(device, newConfig, currentConfigBuffer);
    if (success) {
      console.log("✓ Lighting configuration applied successfully!");
    }
    return success;
  } finally {
    if (shouldClose) {
      await safeClose(device);
    }
  }
}

/**
 * Syncs time to the keyboard, preserving all other settings.
 */
async function syncTime(date: Date = new Date(), device: HidDevice | null = null): Promise<boolean> {
  return await configureLighting({ time: true }, device);
}

/**
 * Gets keyboard device information via HID.devices() enumeration
 * (avoids synchronous getManufacturerString()/getProductString() calls that
 * can hang the event loop on some Linux systems).
 */
function getKeyboardInfo(): KeyboardInfo {
  const info = findVerifiedDeviceInfo();
  return {
    manufacturer: info.manufacturer || "Unknown",
    product: info.product || "GMK67-S",
    vendorId: VENDOR_ID,
    productId: PRODUCT_ID,
  };
}

// -------------------------------------------------------
// Safe Device Cleanup
// -------------------------------------------------------

/**
 * Safely closes a HID device, avoiding SIGSEGV on Linux caused by node-hid's
 * internal read thread still being active when close() is called.
 */
async function safeClose(device: HidDevice | null | undefined): Promise<void> {
  if (!device) return;
  try {
    device.close();
  } catch {
    // Ignore close errors — device may already be disconnected
  }
}

// -------------------------------------------------------
// Exports
// -------------------------------------------------------

export type {
  HidDevice,
  HidDeviceInfo,
  UnderglowHue,
  UnderglowConfig,
  LedConfig,
  ConfigChanges,
  ParsedConfig,
  ParsedTime,
  UploadOptions,
  KeyboardInfo,
};

export {
  // Constants
  VENDOR_ID,
  PRODUCT_ID,
  REPORT_ID,
  BYTES_PER_FRAME,
  DISPLAY_WIDTH,
  DISPLAY_HEIGHT,
  FACTORY_CONFIG,
  // Utilities
  delay,
  toRGB565,
  toHexNum,
  // Device Connection
  findDeviceInfo,
  findVerifiedDeviceInfo,
  openDevice,
  safeClose,
  drainDevice,
  // Protocol Functions
  checksum,
  send,
  trySend,
  readResponse,
  waitForReady,
  sendConfigFrame,
  // Position-addressed protocol
  sendWithPosition,
  readConfigFromDevice,
  parseConfigBuffer,
  buildConfigBuffer,
  writeConfigToDevice,
  writeConfigWithRollback,
  // Frame Building & Transmission
  buildRawImageData,
  sendFrameData,
  // High-Level Pipelines
  uploadImageToDevice,
  buildLightingFrame,
  sendLightingFrame,
  trySendLightingFrame,
  configureLighting,
  syncTime,
  restoreFactoryDefaults,
  getKeyboardInfo,
  // Debug
  setDebug,
};
