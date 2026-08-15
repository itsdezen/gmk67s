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
  uploadImageToDevice,
  syncTime,
  restoreFactoryDefaults,
  getKeyboardInfo,
  openDevice,
  safeClose,
  readConfigFromDevice,
  parseConfigBuffer,
} from "./lib/device.js";

import { processAndSend } from "./sendImageMagick.js";

/**
 * Upload 1 or 2 images (supports GIFs) with automatic resize + frame
 * extraction. Every call rewrites the device's entire image memory from
 * scratch: one file uses the full 36-frame budget, two files split it 18/18.
 * @param {string|string[]} files - 1 or 2 source image file paths
 * @param {Object} [options] - Upload options
 * @param {number} [options.frameDuration] - Animation delay in ms (min 60, default 100 for GIFs)
 * @param {boolean} [options.showAfter=true] - Display the image after upload (vs. the clock)
 */
async function uploadImage(files, options = {}) {
  return processAndSend(files, options);
}

/**
 * Configure lighting (read-modify-write, preserves unspecified settings)
 * @param {Object} changes - Settings to change
 */
async function setLighting(changes) {
  return configureLighting(changes);
}

/**
 * Switch the displayed image slot
 * @param {number} slot - 0=show time, 1=show slot 0, 2=show slot 1
 */
async function showSlot(slot) {
  return configureLighting({ showImage: slot });
}

/**
 * Read current keyboard configuration
 * @returns {Promise<Object>} Parsed config with underglow, led, showImage, image1Frames, image2Frames, frameDuration
 */
async function readConfig() {
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
