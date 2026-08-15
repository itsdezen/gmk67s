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

function UploadScreen({ onBack }) {
  const [filePath, setFilePath] = useState("");
  const [slot, setSlot] = useState(0);
  const [status, setStatus] = useState(null);

  useInput((input, key) => {
    if (status === "uploading") return;
    if (status) {
      onBack();
      return;
    }
    if (key.escape) {
      onBack();
      return;
    }
    if (key.tab) {
      setSlot((s) => (s === 0 ? 1 : 0));
      return;
    }
    if (key.return) {
      if (!filePath.trim()) return;
      setStatus("uploading");
      uploadImage(filePath.trim(), slot, { showAfter: true })
        .then(() => setStatus("done"))
        .catch((err) => setStatus(err.message));
      return;
    }
    if (key.backspace || key.delete) {
      setFilePath((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setFilePath((s) => s + input);
    }
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, null, "Slot: ", h(Text, { color: "cyan" }, String(slot)), " (Tab to switch)"),
    h(Text, null, `File path: ${filePath}`, h(Text, { color: "gray" }, "▏")),
    h(Text, null, " "),
    status === "uploading" && h(Text, null, "Uploading..."),
    status === "done" && h(Text, { color: "green" }, "Upload complete. Press any key to go back."),
    status &&
      status !== "uploading" &&
      status !== "done" &&
      h(Text, { color: "red" }, `${status} Press any key to go back.`),
    !status && h(Text, { dimColor: true }, "Type path · Tab: slot · Enter: upload · Esc: cancel")
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
