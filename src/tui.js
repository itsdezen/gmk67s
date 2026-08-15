#!/usr/bin/env node
/**
 * @fileoverview Interactive terminal UI for the GMK67-S keyboard.
 * A thin Ink/React presentation layer over api.js — no protocol or device
 * logic lives here, only navigation/input handling and calls into the
 * existing API. Colors are limited to Ink's standard named colors so the
 * UI inherits the terminal's own theme instead of hardcoding hex values.
 *
 * No JSX: this runs as plain Node ESM with no build step, so components are
 * written with React.createElement directly.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import {
  setLighting,
  syncTime,
  readConfig,
  restoreFactoryDefaults,
  getKeyboardInfo,
  uploadImage,
} from "./api.js";
import { UNDERGLOW_EFFECTS, LED_COLORS } from "./configureLights.js";
import { loadPresets, applyPreset } from "./loadPreset.js";

const h = React.createElement;

const MENU_ITEMS = [
  { key: "info", label: "Device Info" },
  { key: "lights", label: "Lighting" },
  { key: "preset", label: "Presets" },
  { key: "upload", label: "Upload Image" },
  { key: "timesync", label: "Time Sync" },
  { key: "restore", label: "Restore Factory Defaults" },
  { key: "quit", label: "Quit" },
];

function MenuScreen({ onSelect, onQuit }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
    if (key.downArrow) setIndex((i) => (i + 1) % MENU_ITEMS.length);
    if (key.return) {
      const item = MENU_ITEMS[index];
      if (item.key === "quit") onQuit();
      else onSelect(item.key);
    }
    if (input === "q") onQuit();
  });

  return h(
    Box,
    { flexDirection: "column" },
    MENU_ITEMS.map((item, i) =>
      h(
        Text,
        { key: item.key, color: i === index ? "cyan" : undefined },
        (i === index ? "▸ " : "  ") + item.label
      )
    )
  );
}

function DeviceInfoScreen({ onBack }) {
  const [state, setState] = useState({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = getKeyboardInfo();
        const config = await readConfig();
        if (!cancelled) setState({ status: "done", info, config });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err.message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
  });

  if (state.status === "loading") return h(Text, null, "Reading device...");

  if (state.status === "error") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: "red" }, state.message),
      h(Text, { dimColor: true }, "Press Esc to go back")
    );
  }

  const { info, config } = state;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, `Product: ${info.product}`),
    h(Text, null, `Manufacturer: ${info.manufacturer}`),
    h(
      Text,
      null,
      `VID/PID: 0x${info.vendorId.toString(16)} / 0x${info.productId.toString(16)}`
    ),
    h(Text, null, " "),
    h(
      Text,
      null,
      `Underglow: effect=${config.underglow.effect} brightness=${config.underglow.brightness}`
    ),
    h(Text, null, `LED: mode=${config.led.mode} color=${config.led.color}`),
    h(Text, null, `showImage: ${config.showImage} frameDuration: ${config.frameDuration}ms`),
    h(Text, { dimColor: true }, "Press Esc to go back")
  );
}

const EFFECT_NAMES = Object.keys(UNDERGLOW_EFFECTS);
const LED_COLOR_NAMES = Object.keys(LED_COLORS);
const LIGHTING_FIELDS = ["Effect", "Brightness", "LED Color"];

function LightingScreen({ onBack }) {
  const [effectIdx, setEffectIdx] = useState(0);
  const [brightness, setBrightness] = useState(5);
  const [colorIdx, setColorIdx] = useState(0);
  const [focus, setFocus] = useState(0);
  const [status, setStatus] = useState(null);

  useInput((input, key) => {
    if (status === "applying") return;
    if (status) {
      onBack();
      return;
    }
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.tab) {
      setFocus((f) => (f + 1) % LIGHTING_FIELDS.length);
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const dir = key.rightArrow ? 1 : -1;
      if (focus === 0) setEffectIdx((i) => (i + dir + EFFECT_NAMES.length) % EFFECT_NAMES.length);
      if (focus === 1) setBrightness((b) => Math.min(9, Math.max(0, b + dir)));
      if (focus === 2) setColorIdx((i) => (i + dir + LED_COLOR_NAMES.length) % LED_COLOR_NAMES.length);
      return;
    }
    if (key.return) {
      setStatus("applying");
      setLighting({
        underglow: { effect: UNDERGLOW_EFFECTS[EFFECT_NAMES[effectIdx]], brightness },
        led: { color: LED_COLORS[LED_COLOR_NAMES[colorIdx]] },
      })
        .then((ok) => setStatus(ok ? "done" : "Write failed (rolled back if possible)"))
        .catch((err) => setStatus(err.message));
    }
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: focus === 0 ? "cyan" : undefined }, `Effect: ${EFFECT_NAMES[effectIdx]}`),
    h(Text, { color: focus === 1 ? "cyan" : undefined }, `Brightness: ${brightness}`),
    h(Text, { color: focus === 2 ? "cyan" : undefined }, `LED Color: ${LED_COLOR_NAMES[colorIdx]}`),
    h(Text, null, " "),
    status === "applying" && h(Text, null, "Applying..."),
    status === "done" && h(Text, { color: "green" }, "Applied. Press any key to go back."),
    status &&
      status !== "applying" &&
      status !== "done" &&
      h(Text, { color: "red" }, `${status} Press any key to go back.`),
    !status &&
      h(Text, { dimColor: true }, "Tab: switch field · ←/→: change value · Enter: apply · Esc: cancel")
  );
}

function PresetScreen({ onBack }) {
  const [presets] = useState(() => {
    try {
      return Object.entries(loadPresets().presets);
    } catch {
      return [];
    }
  });
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState(null);

  useInput((input, key) => {
    if (status === "applying") return;
    if (status) {
      onBack();
      return;
    }
    if (key.escape || input === "q") {
      onBack();
      return;
    }
    if (key.upArrow) setIndex((i) => (i - 1 + presets.length) % presets.length);
    if (key.downArrow) setIndex((i) => (i + 1) % presets.length);
    if (key.return && presets.length > 0) {
      setStatus("applying");
      const [name] = presets[index];
      applyPreset(name)
        .then((ok) => setStatus(ok ? "done" : "Write failed (rolled back if possible)"))
        .catch((err) => setStatus(err.message));
    }
  });

  if (presets.length === 0) {
    return h(Text, { color: "red" }, "No presets found. Press any key to go back.");
  }

  return h(
    Box,
    { flexDirection: "column" },
    presets.map(([name, preset], i) =>
      h(
        Text,
        { key: name, color: i === index ? "cyan" : undefined },
        `${i === index ? "▸ " : "  "}${name} — ${preset.description}`
      )
    ),
    h(Text, null, " "),
    status === "applying" && h(Text, null, "Applying..."),
    status === "done" && h(Text, { color: "green" }, "Applied. Press any key to go back."),
    status &&
      status !== "applying" &&
      status !== "done" &&
      h(Text, { color: "red" }, `${status} Press any key to go back.`)
  );
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".gif"];
const FILE_BROWSER_MAX_VISIBLE = 15;

function isImageFile(name) {
  return IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

function readDirEntries(dir) {
  const raw = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];
  for (const entry of raw) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) dirs.push({ name: entry.name, isDir: true });
    else if (isImageFile(entry.name)) files.push({ name: entry.name, isDir: false });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const isRoot = path.dirname(dir) === dir;
  const parentEntry = isRoot ? [] : [{ name: "..", isDir: true, isParent: true }];
  return parentEntry.concat(dirs, files);
}

function FileBrowserScreen({ onSelect, onCancel }) {
  const [currentDir, setCurrentDir] = useState(os.homedir());
  const [index, setIndex] = useState(0);
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    try {
      setEntries(readDirEntries(currentDir));
      setError(null);
    } catch (err) {
      setEntries([{ name: "..", isDir: true, isParent: true }]);
      setError(err.message);
    }
    setIndex(0);
  }, [currentDir]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setIndex((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (entries.length ? (i + 1) % entries.length : 0));
      return;
    }
    if (input === "~" || input === "h") {
      setCurrentDir(os.homedir());
      return;
    }
    if (key.leftArrow || key.backspace) {
      setCurrentDir((d) => path.dirname(d));
      return;
    }
    if (key.return) {
      const entry = entries[index];
      if (!entry) return;
      if (entry.isDir) {
        setCurrentDir(entry.isParent ? path.dirname(currentDir) : path.join(currentDir, entry.name));
      } else {
        onSelect(path.join(currentDir, entry.name));
      }
    }
  });

  const start = Math.max(
    0,
    Math.min(index - Math.floor(FILE_BROWSER_MAX_VISIBLE / 2), Math.max(0, entries.length - FILE_BROWSER_MAX_VISIBLE))
  );
  const visible = entries.slice(start, start + FILE_BROWSER_MAX_VISIBLE);

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: "cyan" }, currentDir),
    error && h(Text, { color: "red" }, `Cannot read directory: ${error}`),
    entries.length === 0 && !error && h(Text, { dimColor: true }, "(no images or subdirectories)"),
    visible.map((entry, i) => {
      const realIndex = start + i;
      const label = entry.isDir ? `${entry.name}/` : entry.name;
      return h(
        Text,
        { key: `${realIndex}-${entry.name}`, color: realIndex === index ? "cyan" : undefined },
        (realIndex === index ? "▸ " : "  ") + label
      );
    }),
    h(Text, null, " "),
    h(Text, { dimColor: true }, "↑/↓ navigate · Enter open/select · ←/Backspace up dir · ~ home · Esc back")
  );
}

function UploadScreen({ onBack }) {
  // Every upload rewrites the device's entire image memory from scratch —
  // there's no "slot" to pick, just 1 or 2 images to upload right now.
  const [stage, setStage] = useState("image1"); // image1 | askSecond | image2 | uploading | done | error
  const [image1, setImage1] = useState(null);
  const [image2, setImage2] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (stage !== "uploading") return;
    uploadImage(image2 ? [image1, image2] : [image1], { showAfter: true })
      .then(() => setStage("done"))
      .catch((err) => {
        setError(err.message);
        setStage("error");
      });
  }, [stage]);

  useInput((input, key) => {
    if (stage === "askSecond") {
      if (key.return) {
        setStage("image2");
        return;
      }
      if (input === "s" || key.escape) {
        setStage("uploading");
        return;
      }
      return;
    }
    if (stage === "done" || stage === "error") {
      onBack();
    }
  });

  if (stage === "image1") {
    return h(FileBrowserScreen, {
      onSelect: (p) => {
        setImage1(p);
        setStage("askSecond");
      },
      onCancel: onBack,
    });
  }

  if (stage === "image2") {
    return h(FileBrowserScreen, {
      onSelect: (p) => {
        setImage2(p);
        setStage("uploading");
      },
      onCancel: () => setStage("askSecond"),
    });
  }

  if (stage === "askSecond") {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, null, "Image 1: ", h(Text, { color: "cyan" }, image1)),
      h(Text, null, " "),
      h(Text, null, "Add a second image? Uploading replaces everything currently on the device."),
      h(Text, { dimColor: true }, "Enter: choose second image · s/Esc: upload with just this one")
    );
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, "Image 1: ", h(Text, { color: "cyan" }, image1)),
    image2 && h(Text, null, "Image 2: ", h(Text, { color: "cyan" }, image2)),
    h(Text, null, " "),
    stage === "uploading" && h(Text, null, "Uploading..."),
    stage === "done" && h(Text, { color: "green" }, "Upload complete. Press any key to go back."),
    stage === "error" && h(Text, { color: "red" }, `${error} Press any key to go back.`)
  );
}

function TimeSyncScreen({ onBack }) {
  const [status, setStatus] = useState("syncing");

  useEffect(() => {
    syncTime()
      .then((ok) => setStatus(ok ? "done" : "Write failed (rolled back if possible)"))
      .catch((err) => setStatus(err.message));
  }, []);

  useInput(() => {
    if (status === "syncing") return;
    onBack();
  });

  return h(
    Box,
    { flexDirection: "column" },
    status === "syncing" && h(Text, null, "Syncing time..."),
    status === "done" && h(Text, { color: "green" }, "Time synced. Press any key to go back."),
    status !== "syncing" &&
      status !== "done" &&
      h(Text, { color: "red" }, `${status} Press any key to go back.`)
  );
}

function RestoreScreen({ onBack }) {
  const [confirmed, setConfirmed] = useState(false);
  const [yesSelected, setYesSelected] = useState(false);
  const [status, setStatus] = useState(null);

  useInput((input, key) => {
    if (!confirmed) {
      if (key.leftArrow || key.rightArrow) {
        setYesSelected((y) => !y);
        return;
      }
      if (key.escape) {
        onBack();
        return;
      }
      if (key.return) {
        if (!yesSelected) {
          onBack();
          return;
        }
        setConfirmed(true);
        setStatus("restoring");
        restoreFactoryDefaults(null, { assumeYes: true })
          .then((ok) => setStatus(ok ? "done" : "Restore failed"))
          .catch((err) => setStatus(err.message));
      }
      return;
    }
    if (status === "restoring") return;
    onBack();
  });

  if (!confirmed) {
    return h(
      Box,
      { flexDirection: "column" },
      h(
        Text,
        { color: "yellow" },
        "⚠ This will ERASE the keyboard's current settings and restore factory defaults."
      ),
      h(Text, null, " "),
      h(
        Text,
        null,
        h(Text, { color: !yesSelected ? "cyan" : undefined }, !yesSelected ? "▸ No" : "  No"),
        "   ",
        h(Text, { color: yesSelected ? "cyan" : undefined }, yesSelected ? "▸ Yes" : "  Yes")
      ),
      h(Text, { dimColor: true }, "←/→ choose · Enter confirm · Esc cancel")
    );
  }

  return h(
    Box,
    { flexDirection: "column" },
    status === "restoring" && h(Text, null, "Restoring..."),
    status === "done" && h(Text, { color: "green" }, "Factory defaults restored. Press any key to go back."),
    status &&
      status !== "restoring" &&
      status !== "done" &&
      h(Text, { color: "red" }, `${status} Press any key to go back.`)
  );
}

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState("menu");

  const onBack = () => setScreen("menu");

  return h(
    Box,
    { flexDirection: "column", padding: 1 },
    h(Text, { bold: true }, "GMK67-S"),
    h(
      Box,
      { marginBottom: 1 },
      h(Text, { dimColor: true }, "↑/↓ navigate · Enter select · Esc back · q quit")
    ),
    screen === "menu" && h(MenuScreen, { onSelect: setScreen, onQuit: exit }),
    screen === "info" && h(DeviceInfoScreen, { onBack }),
    screen === "lights" && h(LightingScreen, { onBack }),
    screen === "preset" && h(PresetScreen, { onBack }),
    screen === "upload" && h(UploadScreen, { onBack }),
    screen === "timesync" && h(TimeSyncScreen, { onBack }),
    screen === "restore" && h(RestoreScreen, { onBack })
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.stdin.isTTY) {
    console.error("gmk67s tui requires an interactive terminal (stdin is not a TTY).");
    process.exit(1);
  }
  const { waitUntilExit } = render(h(App));
  waitUntilExit().then(() => process.exit(0));
}

export { App };
