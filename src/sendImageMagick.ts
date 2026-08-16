#!/usr/bin/env bun
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
import type { JimpInstance } from "jimp";
import { GifReader } from "omggif";
import { uploadImageToDevice, isQuiet, DISPLAY_WIDTH, DISPLAY_HEIGHT } from "./lib/device.js";

interface UploadOptions {
  showAfter?: boolean;
  frameDuration?: number;
  onProgress?: (percent: number, sentBytes: number, totalBytes: number) => void;
}

/**
 * Parses `<file1> [file2] [--ms <delay>]` style argv into positional file
 * paths plus the --ms option.
 */
function parseUploadArgv(argv: string[]): { files: string[]; ms: string | undefined } {
  const files: string[] = [];
  let ms: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ms") {
      ms = argv[++i];
    } else if (a.startsWith("--ms=")) {
      ms = a.slice(5);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown option: ${a}`);
    } else {
      files.push(a);
    }
  }
  return { files, ms };
}

/**
 * Resizes an image to exactly DISPLAY_WIDTH x DISPLAY_HEIGHT, preserving the
 * source aspect ratio (scale so the shorter side fills the target) and
 * center-cropping the overflow on the longer side, instead of squashing.
 */
function resizeCoverDisplay(img: JimpInstance): void {
  img.cover({ w: DISPLAY_WIDTH, h: DISPLAY_HEIGHT });
}

/**
 * Extracts all frames from a GIF using omggif with proper frame compositing.
 * Handles disposal methods (keep, restore to background, restore to previous)
 * so each output frame is a fully rendered image — equivalent to ImageMagick's -coalesce.
 * @param inPath - Path to GIF file
 * @param outDir - Directory to write frame PNG files into
 * @returns Sorted array of output file paths
 */
async function extractGifFrames(inPath: string, outDir: string): Promise<string[]> {
  const buf = fs.readFileSync(inPath);
  const reader = new GifReader(buf);
  const { width, height } = reader;
  const frameCount = reader.numFrames();

  // Canvas holds the composited state (RGBA)
  const canvas = Buffer.alloc(width * height * 4, 0);
  const framePaths: string[] = [];

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
    const img = new Jimp({ data: Buffer.from(canvas), width, height }) as JimpInstance;
    resizeCoverDisplay(img);
    const outPath = path.join(outDir, `frame_${String(i).padStart(4, "0")}.png`);
    await img.write(outPath as `${string}.png`);
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
 * @param inPath - Path to input image file
 * @param outDir - Directory to write frame files into
 * @returns Array of output file paths
 */
export async function extractFramesFromFile(inPath: string, outDir: string): Promise<string[]> {
  const ext = path.extname(inPath).toLowerCase();

  if (ext === ".gif") {
    return extractGifFrames(inPath, outDir);
  }

  const img = (await Jimp.read(inPath)) as JimpInstance;
  resizeCoverDisplay(img);
  const outPath = path.join(outDir, "frame_0000.png");
  await img.write(outPath as `${string}.png`);
  return [outPath];
}

/**
 * Processes 1 or 2 image files (static or GIF) and uploads them to the
 * GMK67-S device. Every upload rewrites the device's entire image memory:
 * one file uses the full 72-frame budget, two files split it 36/36 (with
 * leftover frames from a shorter file going to the other).
 * @param files - 1 or 2 source image file paths
 * @param options - Upload options
 */
export async function processAndSend(
  files: string | string[],
  { showAfter = true, frameDuration, onProgress }: UploadOptions = {}
): Promise<void> {
  const fileList = Array.isArray(files) ? files : [files];
  if (fileList.length < 1 || fileList.length > 2) {
    throw new Error("processAndSend expects 1 or 2 file paths");
  }

  const tmpDirs: string[] = [];

  async function extractFrames(inputPath: string): Promise<string[]> {
    if (!fs.existsSync(inputPath))
      throw new Error(`Input file not found: ${inputPath}`);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmk67s-frames-"));
    tmpDirs.push(tmpDir);
    if (!isQuiet()) console.log(`Processing ${path.basename(inputPath)}...`);
    const framePaths = await extractFramesFromFile(inputPath, tmpDir);
    if (!isQuiet()) console.log(`  ${framePaths.length} frame(s) extracted`);
    return framePaths;
  }

  try {
    // Auto-truncate if total frames exceed the flash-storage limit
    // (derived from GMK87's confirmed budget, not yet hardware-verified for this device — see SPEC.md)
    const MAX_TOTAL_FRAMES = 72;

    let frames0 = await extractFrames(fileList[0]);
    let frames1 = fileList[1] !== undefined ? await extractFrames(fileList[1]) : null;

    if (frames1) {
      if (frames0.length + frames1.length > MAX_TOTAL_FRAMES) {
        const half = Math.floor(MAX_TOTAL_FRAMES / 2);
        const target0 = Math.min(frames0.length, half);
        const target1 = Math.min(frames1.length, MAX_TOTAL_FRAMES - target0);
        if (frames0.length > target0) {
          if (!isQuiet()) console.log(`  Truncating image 1 from ${frames0.length} to ${target0} frames (${MAX_TOTAL_FRAMES}-frame hardware limit)`);
          frames0 = frames0.slice(0, target0);
        }
        if (frames1.length > target1) {
          if (!isQuiet()) console.log(`  Truncating image 2 from ${frames1.length} to ${target1} frames (${MAX_TOTAL_FRAMES}-frame hardware limit)`);
          frames1 = frames1.slice(0, target1);
        }
      }
    } else if (frames0.length > MAX_TOTAL_FRAMES) {
      if (!isQuiet()) console.log(`  Truncating image from ${frames0.length} to ${MAX_TOTAL_FRAMES} frames (${MAX_TOTAL_FRAMES}-frame hardware limit)`);
      frames0 = frames0.slice(0, MAX_TOTAL_FRAMES);
    }

    const totalFrames = frames0.length + (frames1 ? frames1.length : 0);
    const isAnimated = totalFrames > 2;
    if (frameDuration === undefined && isAnimated) {
      frameDuration = 100;
      if (!isQuiet()) console.log(`  Using default animation delay: ${frameDuration}ms`);
    }

    await uploadImageToDevice(frames1 ? [frames0, frames1] : [frames0], {
      showAfter,
      frameDuration,
      onProgress,
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
 *   node sendImageMagick.js <file1> [file2] [--ms <delay>]
 *
 * One file uses the full 72-frame budget. Two files split it 36/36. Every
 * upload rewrites the device's entire image memory — there is no "slot"
 * concept and no way to preserve an image not passed in this call.
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const usage =
    "Usage:\n" +
    "  bun src/sendImageMagick.ts <file1> [file2] [--ms <delay>]\n" +
    "\n" +
    "Options:\n" +
    "  --ms <number>  Animation delay in milliseconds (min 60, default 100 for GIFs)";

  let files: string[], msRaw: string | undefined;
  try {
    ({ files, ms: msRaw } = parseUploadArgv(process.argv));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage);
    process.exit(1);
  }

  if (files.length < 1 || files.length > 2) {
    console.error(usage);
    process.exit(1);
  }

  let frameDuration: number | undefined;
  if (msRaw !== undefined) {
    if (Number.isNaN(Number(msRaw))) {
      console.error("--ms must be a number (milliseconds between frames, min 60)");
      process.exit(1);
    }
    frameDuration = Math.max(60, Number(msRaw));
  }

  processAndSend(files, { frameDuration }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export type { UploadOptions };
