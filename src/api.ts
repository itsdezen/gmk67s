/**
 * @fileoverview Public API for the GMK67-S keyboard
 *
 * @example
 *   import gmk67s from "./src/api.js";
 *
 *   await gmk67s.uploadImage("cat.png");
 *   await gmk67s.uploadImage(["cat.png", "dog.jpg"]);
 *   await gmk67s.uploadImage("anim.gif", { frameDuration: 100 });
 *   await gmk67s.setLighting({ underglow: { effect: 5, brightness: 7, hue: { red: 255, green: 0, blue: 128 } } });
 *   await gmk67s.setLighting({ led: { mode: 3, color: 5 } });
 *   await gmk67s.showSlot(2);
 *   await gmk67s.syncTime();
 *   await gmk67s.restoreFactoryDefaults();
 *   const config = await gmk67s.readConfig();
 *   const info = gmk67s.getKeyboardInfo();
 */

import {
  configureLighting,
  syncTime,
  restoreFactoryDefaults,
  getKeyboardInfo,
  openDevice,
  safeClose,
  readConfigFromDevice,
  parseConfigBuffer,
} from "./lib/device.js";
import type { ConfigChanges, ParsedConfig } from "./lib/device.js";

import { processAndSend } from "./sendImageMagick.js";
import type { UploadOptions } from "./sendImageMagick.js";

/**
 * Upload 1 or 2 images (supports GIFs) with automatic resize + frame
 * extraction. Every call rewrites the device's entire image memory from
 * scratch: one file uses the full 72-frame budget, two files split it 36/36.
 * @param files - 1 or 2 source image file paths
 * @param options - Upload options
 */
async function uploadImage(files: string | string[], options: UploadOptions = {}): Promise<void> {
  return processAndSend(files, options);
}

/**
 * Configure lighting (read-modify-write, preserves unspecified settings)
 * @param changes - Settings to change
 */
async function setLighting(changes: ConfigChanges): Promise<boolean> {
  return configureLighting(changes);
}

/**
 * Switch the displayed image slot
 * @param slot - 0=show time, 1=show slot 0, 2=show slot 1
 */
async function showSlot(slot: number): Promise<boolean> {
  return configureLighting({ showImage: slot });
}

/**
 * Read current keyboard configuration
 * @returns Parsed config with underglow, led, showImage, image1Frames, image2Frames, frameDuration
 */
async function readConfig(): Promise<ParsedConfig> {
  const device = openDevice();
  try {
    return parseConfigBuffer(await readConfigFromDevice(device));
  } finally {
    await safeClose(device);
  }
}

export default {
  uploadImage,
  setLighting,
  showSlot,
  syncTime,
  readConfig,
  restoreFactoryDefaults,
  getKeyboardInfo,
};

export {
  uploadImage,
  setLighting,
  showSlot,
  syncTime,
  readConfig,
  restoreFactoryDefaults,
  getKeyboardInfo,
};
