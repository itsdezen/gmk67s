/**
 * @fileoverview Public API for the GMK67-S keyboard
 *
 * @example
 *   import gmk67s from "./src/api.js";
 *
 *   await gmk67s.uploadImage("cat.png", 0, { slot0File: "cat.png", slot1File: "dog.jpg" });
 *   await gmk67s.uploadImage("anim.gif", 0, { slot0File: "anim.gif", frameDuration: 100 });
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
 * Upload images (supports GIFs) with automatic resize + frame extraction
 * @param {string} imagePath - Path to the image file
 * @param {number} [slot=0] - Target slot (0 or 1)
 * @param {Object} [options] - Upload options
 * @param {string} [options.slot0File] - Path for slot 0 image
 * @param {string} [options.slot1File] - Path for slot 1 image
 * @param {number} [options.frameDuration] - Animation delay in ms (min 60, default 100 for GIFs)
 * @param {boolean} [options.showAfter=true] - Display the image after upload
 */
async function uploadImage(imagePath, slot = 0, options = {}) {
  return processAndSend(imagePath, slot, options);
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
