#!/usr/bin/env node
/**
 * @fileoverview Image upload utility with built-in preprocessing.
 * Converts images to DISPLAY_WIDTH x DISPLAY_HEIGHT before uploading to the
 * GMK67-S device. Uses jimp for static images and omggif for GIF frame
 * extraction. Supports command-line usage with flexible argument parsing.
 */

import os from "os";
import path from "path";
import fs from "fs";
import { Jimp } from "jimp";
import { GifReader } from "omggif";
import { uploadImageToDevice, DISPLAY_WIDTH, DISPLAY_HEIGHT } from "./lib/device.js";

/**
 * Parses command-line arguments into a key-value object
 * Supports both --key=value and --key value formats
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Extracts all frames from a GIF using omggif with proper frame compositing.
 * Handles disposal methods (keep, restore to background, restore to previous)
 * so each output frame is a fully rendered image — equivalent to ImageMagick's -coalesce.
 * @param {string} inPath - Path to GIF file
 * @param {string} outDir - Directory to write frame PNG files into
 * @returns {Promise<string[]>} Sorted array of output file paths
 */
async function extractGifFrames(inPath, outDir) {
  const buf = fs.readFileSync(inPath);
  const reader = new GifReader(buf);
  const { width, height } = reader;
  const frameCount = reader.numFrames();

  // Canvas holds the composited state (RGBA)
  const canvas = Buffer.alloc(width * height * 4, 0);
  const framePaths = [];

  for (let i = 0; i < frameCount; i++) {
    const info = reader.frameInfo(i);

    const previousCanvas = Buffer.from(canvas);

    const framePixels = Buffer.alloc(width * height * 4, 0);
    reader.decodeAndBlitFrameRGBA(i, framePixels);

    const fx = info.x || 0;
    const fy = info.y || 0;
    const fw = info.width;
    const fh = info.height;
    for (let y = fy; y < fy + fh && y < height; y++) {
      for (let x = fx; x < fx + fw && x < width; x++) {
        const srcIdx = (y * width + x) * 4;
        const alpha = framePixels[srcIdx + 3];
        if (alpha > 0) {
          canvas[srcIdx] = framePixels[srcIdx];
          canvas[srcIdx + 1] = framePixels[srcIdx + 1];
          canvas[srcIdx + 2] = framePixels[srcIdx + 2];
          canvas[srcIdx + 3] = 255;
        }
      }
    }

    // Jimp v1: construct directly from a Bitmap-shaped buffer instead of the
    // old `new Jimp(width, height)` + `img.bitmap.data = ...` two-step.
    const img = new Jimp({ data: Buffer.from(canvas), width, height });
    img.resize({ w: DISPLAY_WIDTH, h: DISPLAY_HEIGHT });
    const outPath = path.join(outDir, `frame_${String(i).padStart(4, "0")}.png`);
    await img.write(outPath);
    framePaths.push(outPath);

    const disposal = info.disposal || 0;
    if (disposal === 2) {
      for (let y = fy; y < fy + fh && y < height; y++) {
        for (let x = fx; x < fx + fw && x < width; x++) {
          const idx = (y * width + x) * 4;
          canvas[idx] = 0;
          canvas[idx + 1] = 0;
          canvas[idx + 2] = 0;
          canvas[idx + 3] = 0;
        }
      }
    } else if (disposal === 3) {
      previousCanvas.copy(canvas);
    }
    // disposal 0 or 1: leave canvas as-is
  }

  return framePaths;
}

/**
 * Extracts frames from an image file (static or animated GIF)
 * @param {string} inPath - Path to input image file
 * @param {string} outDir - Directory to write frame files into
 * @returns {Promise<string[]>} Array of output file paths
 */
async function extractFramesFromFile(inPath, outDir) {
  const ext = path.extname(inPath).toLowerCase();

  if (ext === ".gif") {
    return extractGifFrames(inPath, outDir);
  }

  const img = await Jimp.read(inPath);
  img.resize({ w: DISPLAY_WIDTH, h: DISPLAY_HEIGHT });
  const outPath = path.join(outDir, "frame_0000.png");
  await img.write(outPath);
  return [outPath];
}

/**
 * Processes an image file (static or GIF) and uploads it to the GMK67-S device
 * @param {string} imagePath - Path to the source image file
 * @param {number} [imageIndex=0] - Target slot on device (0 or 1)
 * @param {Object} [options={}] - Upload options
 * @returns {Promise<void>}
 */
export async function processAndSend(
  imagePath,
  imageIndex = 0,
  { showAfter = true, slot0File, slot1File, frameDuration, confirmOverwrite = false, assumeYes = false } = {}
) {
  const tmpDirs = [];

  async function extractFrames(inputPath) {
    if (!inputPath) return null;
    if (!fs.existsSync(inputPath))
      throw new Error(`Input file not found: ${inputPath}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmk67s-frames-"));
    tmpDirs.push(tmpDir);
    console.log(`Processing ${path.basename(inputPath)}...`);
    const framePaths = await extractFramesFromFile(inputPath, tmpDir);
    console.log(`  ${framePaths.length} frame(s) extracted`);
    return framePaths;
  }

  try {
    const src0 = slot0File || (imageIndex === 0 ? imagePath : null);
    const src1 = slot1File || (imageIndex === 1 ? imagePath : null);
    let frames0 = await extractFrames(src0);
    let frames1 = await extractFrames(src1);

    // Auto-truncate if total frames exceed the assumed flash-storage limit
    // (unverified for this device — see SPEC.md)
    const MAX_TOTAL_FRAMES = 36;
    const count0 = frames0 ? frames0.length : 1;
    const count1 = frames1 ? frames1.length : 1;
    if (count0 + count1 > MAX_TOTAL_FRAMES) {
      const half = Math.floor(MAX_TOTAL_FRAMES / 2);
      const target0 = frames0 ? Math.min(frames0.length, half) : 1;
      const target1 = frames1 ? Math.min(frames1.length, MAX_TOTAL_FRAMES - target0) : 1;
      if (frames0 && frames0.length > target0) {
        console.log(`  Truncating slot 0 from ${frames0.length} to ${target0} frames (36-frame hardware limit)`);
        frames0 = frames0.slice(0, target0);
      }
      if (frames1 && frames1.length > target1) {
        console.log(`  Truncating slot 1 from ${frames1.length} to ${target1} frames (36-frame hardware limit)`);
        frames1 = frames1.slice(0, target1);
      }
    }

    const totalFrames = (frames0 ? frames0.length : 0) + (frames1 ? frames1.length : 0);
    const isAnimated = totalFrames > 2;
    if (frameDuration === undefined && isAnimated) {
      frameDuration = 100;
      console.log(`  Using default animation delay: ${frameDuration}ms`);
    }

    await uploadImageToDevice(imagePath, imageIndex, {
      showAfter,
      slot0Paths: frames0,
      slot1Paths: frames1,
      frameDuration,
      confirmOverwrite,
      assumeYes,
    });
  } finally {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
  }
}

// -------------------------------------------------------
// CLI Entry Point
// -------------------------------------------------------

/**
 * Usage:
 *   node sendImageMagick.js --slot0 <path> --slot1 <path> [--ms <delay>] [--show <0|1|2>] [--confirm] [--yes]
 *   node sendImageMagick.js --file <path> --slot <0|1> [--ms <delay>] [--show=true|false] [--confirm] [--yes]
 *
 * --confirm         Prompt before overwriting the target slot(s) (off by default — slot is
 *                    always explicit in normal CLI usage, so there's nothing ambiguous to confirm)
 * --yes / --force    Skip the --confirm prompt (for scripting)
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);

  const frameDuration = args.ms !== undefined ? Math.max(60, Number(args.ms)) : undefined;
  if (args.ms !== undefined && Number.isNaN(Number(args.ms))) {
    console.error("--ms must be a number (milliseconds between frames, min 60)");
    process.exit(1);
  }

  const confirmOverwrite = Boolean(args.confirm);
  const assumeYes = Boolean(args.yes || args.force);

  if (args.slot0 || args.slot1) {
    const show = Number(args.show ?? (args.slot1 ? 2 : 1));

    processAndSend(args.slot0 || args.slot1, args.slot0 ? 0 : 1, {
      showAfter: show > 0,
      slot0File: args.slot0,
      slot1File: args.slot1,
      frameDuration,
      confirmOverwrite,
      assumeYes,
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    const file = args.file || args.f;
    const slot = Number(args.slot ?? 0);
    const show =
      args.show === undefined ? true : String(args.show).toLowerCase() !== "false";

    if (!file || Number.isNaN(slot) || slot < 0 || slot > 1) {
      console.error(
        "Usage:\n" +
        "  node src/sendImageMagick.js --slot0 <path> --slot1 <path> [--ms <delay>] [--confirm] [--yes]\n" +
        "  node src/sendImageMagick.js --file <path> --slot <0|1> [--ms <delay>] [--confirm] [--yes]\n" +
        "\n" +
        "Options:\n" +
        "  --ms <number>  Animation delay in milliseconds (min 60, default 100 for GIFs)\n" +
        "  --confirm      Prompt before overwriting the target slot(s)\n" +
        "  --yes, --force Skip the --confirm prompt"
      );
      process.exit(1);
    }

    processAndSend(file, slot, { showAfter: show, frameDuration, confirmOverwrite, assumeYes }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
