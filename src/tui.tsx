#!/usr/bin/env bun
/**
 * @fileoverview Interactive terminal UI for the GMK67-S keyboard.
 * A thin Ink/React presentation layer over api.js — no protocol or device
 * logic lives here, only navigation/input handling and calls into the
 * existing API. Colors are limited to Ink's standard named colors so the
 * UI inherits the terminal's own theme instead of hardcoding hex values.
 */

process.env.GMK67S_TUI = "1";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import {
  setLighting,
  syncTime,
  readConfig,
  restoreFactoryDefaults,
  getKeyboardInfo,
  uploadImage,
} from "./api.js";
import type { ParsedConfig, KeyboardInfo } from "./lib/device.js";
import { UNDERGLOW_EFFECTS, LED_COLORS } from "./configureLights.js";
import { loadPresets, applyPreset } from "./loadPreset.js";

const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[?25l";
const ALT_SCREEN_EXIT = "\x1b[?1049l\x1b[?25h";

function useTerminalSize(): { width: number; height: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    width: stdout.columns || 80,
    height: stdout.rows || 24,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

type Screen = "menu" | "info" | "lights" | "preset" | "upload" | "timesync" | "restore";

const SCREEN_LABELS: Record<Screen, string> = {
  menu: "Main Menu",
  info: "Device Info",
  lights: "Lighting",
  preset: "Presets",
  upload: "Upload Image",
  timesync: "Time Sync",
  restore: "Restore Factory Defaults",
};

interface MenuItem {
  key: Screen | "quit";
  label: string;
}

const MENU_ITEMS: MenuItem[] = [
  { key: "info", label: "Device Info" },
  { key: "lights", label: "Lighting" },
  { key: "preset", label: "Presets" },
  { key: "upload", label: "Upload Image" },
  { key: "timesync", label: "Time Sync" },
  { key: "restore", label: "Restore Factory Defaults" },
  { key: "quit", label: "Quit" },
];

function MenuScreen({ onSelect, onQuit }: { onSelect: (screen: Screen) => void; onQuit: () => void }) {
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
    if (key.downArrow || input === "j") setIndex((i) => (i + 1) % MENU_ITEMS.length);
    if (key.return) {
      const item = MENU_ITEMS[index];
      if (item.key === "quit") onQuit();
      else onSelect(item.key);
    }
    if (input === "q") onQuit();
    if (/^[1-7]$/.test(input)) {
      const item = MENU_ITEMS[Number(input) - 1];
      if (item) {
        setIndex(Number(input) - 1);
        if (item.key === "quit") onQuit();
        else onSelect(item.key);
      }
    }
  });

  return (
    <Box flexDirection="column">
      {MENU_ITEMS.map((item, i) => (
        <Text key={item.key} color={i === index ? "cyan" : undefined}>
          {(i === index ? "▸ " : "  ") + item.label}
        </Text>
      ))}
    </Box>
  );
}

type DeviceInfoState =
  | { status: "loading" }
  | { status: "done"; info: KeyboardInfo; config: ParsedConfig }
  | { status: "error"; message: string };

function DeviceInfoScreen({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<DeviceInfoState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = getKeyboardInfo();
        const config = await readConfig();
        if (!cancelled) setState({ status: "done", info, config });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((input, key) => {
    if (key.escape || input === "q") onBack();
  });

  if (state.status === "loading") return <Text>Reading device...</Text>;

  if (state.status === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">{state.message}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  const { info, config } = state;
  return (
    <Box flexDirection="column">
      <Text>{`Product: ${info.product}`}</Text>
      <Text>{`Manufacturer: ${info.manufacturer}`}</Text>
      <Text>{`VID/PID: 0x${info.vendorId.toString(16)} / 0x${info.productId.toString(16)}`}</Text>
      <Text> </Text>
      <Text>{`Underglow: effect=${config.underglow.effect} brightness=${config.underglow.brightness}`}</Text>
      <Text>{`LED: mode=${config.led.mode} color=${config.led.color}`}</Text>
      <Text>{`showImage: ${config.showImage} frameDuration: ${config.frameDuration}ms`}</Text>
      <Text dimColor>Press Esc to go back</Text>
    </Box>
  );
}

const EFFECT_NAMES = Object.keys(UNDERGLOW_EFFECTS);
const LED_COLOR_NAMES = Object.keys(LED_COLORS);
const LIGHTING_FIELDS = ["Effect", "Brightness", "LED Color"];

function LightingScreen({ onBack }: { onBack: () => void }) {
  const [effectIdx, setEffectIdx] = useState(0);
  const [brightness, setBrightness] = useState(5);
  const [colorIdx, setColorIdx] = useState(0);
  const [focus, setFocus] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

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
    if (key.tab || input === "j") {
      setFocus((f) => (f + 1) % LIGHTING_FIELDS.length);
      return;
    }
    if (input === "k") {
      setFocus((f) => (f - 1 + LIGHTING_FIELDS.length) % LIGHTING_FIELDS.length);
      return;
    }
    if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
      const dir = key.rightArrow || input === "l" ? 1 : -1;
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

  return (
    <Box flexDirection="column">
      <Text color={focus === 0 ? "cyan" : undefined}>{`Effect: ${EFFECT_NAMES[effectIdx]}`}</Text>
      <Text color={focus === 1 ? "cyan" : undefined}>{`Brightness: ${brightness}`}</Text>
      <Text color={focus === 2 ? "cyan" : undefined}>{`LED Color: ${LED_COLOR_NAMES[colorIdx]}`}</Text>
      <Text> </Text>
      {status === "applying" && <Text>Applying...</Text>}
      {status === "done" && <Text color="green">Applied. Press any key to go back.</Text>}
      {status && status !== "applying" && status !== "done" && (
        <Text color="red">{`${status} Press any key to go back.`}</Text>
      )}
      {!status && (
        <Text dimColor>Tab/j next field · k prev field · ←/→/h/l: change value · Enter: apply · Esc: cancel</Text>
      )}
    </Box>
  );
}

function PresetScreen({ onBack }: { onBack: () => void }) {
  const [presets] = useState(() => {
    try {
      return Object.entries(loadPresets().presets);
    } catch {
      return [];
    }
  });
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

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
    if (key.upArrow || input === "k") setIndex((i) => (i - 1 + presets.length) % presets.length);
    if (key.downArrow || input === "j") setIndex((i) => (i + 1) % presets.length);
    if (key.return && presets.length > 0) {
      setStatus("applying");
      const [name] = presets[index];
      applyPreset(name)
        .then((ok) => setStatus(ok ? "done" : "Write failed (rolled back if possible)"))
        .catch((err) => setStatus(err.message));
    }
  });

  if (presets.length === 0) {
    return <Text color="red">No presets found. Press any key to go back.</Text>;
  }

  return (
    <Box flexDirection="column">
      {presets.map(([name, preset], i) => (
        <Text key={name} color={i === index ? "cyan" : undefined}>
          {`${i === index ? "▸ " : "  "}${name} — ${preset.description}`}
        </Text>
      ))}
      <Text> </Text>
      {status === "applying" && <Text>Applying...</Text>}
      {status === "done" && <Text color="green">Applied. Press any key to go back.</Text>}
      {status && status !== "applying" && status !== "done" && (
        <Text color="red">{`${status} Press any key to go back.`}</Text>
      )}
    </Box>
  );
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".gif"];
const FILE_BROWSER_MAX_VISIBLE = 15;

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

interface FileEntry {
  name: string;
  isDir: boolean;
  isParent?: boolean;
}

function readDirEntries(dir: string): FileEntry[] {
  const raw = fs.readdirSync(dir, { withFileTypes: true });
  const dirs: FileEntry[] = [];
  const files: FileEntry[] = [];
  for (const entry of raw) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) dirs.push({ name: entry.name, isDir: true });
    else if (isImageFile(entry.name)) files.push({ name: entry.name, isDir: false });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  const isRoot = path.dirname(dir) === dir;
  const parentEntry: FileEntry[] = isRoot ? [] : [{ name: "..", isDir: true, isParent: true }];
  return parentEntry.concat(dirs, files);
}

function FileBrowserScreen({ onSelect, onCancel }: { onSelect: (path: string) => void; onCancel: () => void }) {
  const [currentDir, setCurrentDir] = useState(os.homedir());
  const [index, setIndex] = useState(0);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      setEntries(readDirEntries(currentDir));
      setError(null);
    } catch (err) {
      setEntries([{ name: "..", isDir: true, isParent: true }]);
      setError((err as Error).message);
    }
    setIndex(0);
  }, [currentDir]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow || input === "k") {
      setIndex((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
      return;
    }
    if (key.downArrow || input === "j") {
      setIndex((i) => (entries.length ? (i + 1) % entries.length : 0));
      return;
    }
    if (input === "~") {
      setCurrentDir(os.homedir());
      return;
    }
    if (key.leftArrow || key.backspace || input === "h") {
      setCurrentDir((d) => path.dirname(d));
      return;
    }
    if (key.return || input === "l") {
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

  return (
    <Box flexDirection="column">
      <Text color="cyan">{currentDir}</Text>
      {error && <Text color="red">{`Cannot read directory: ${error}`}</Text>}
      {entries.length === 0 && !error && <Text dimColor>(no images or subdirectories)</Text>}
      {visible.map((entry, i) => {
        const realIndex = start + i;
        const label = entry.isDir ? `${entry.name}/` : entry.name;
        return (
          <Text key={`${realIndex}-${entry.name}`} color={realIndex === index ? "cyan" : undefined}>
            {(realIndex === index ? "▸ " : "  ") + label}
          </Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑/↓/j/k navigate · Enter/l open/select · ←/Backspace/h up dir · ~ home · Esc back</Text>
    </Box>
  );
}

function ProgressBar({ percent, width = 30 }: { percent: number; width?: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return <Text>{`${bar} ${clamped}%`}</Text>;
}

type UploadStage = "image1" | "askSecond" | "image2" | "uploading" | "done" | "error";

function UploadScreen({ onBack }: { onBack: () => void }) {
  // Every upload rewrites the device's entire image memory from scratch —
  // there's no "slot" to pick, just 1 or 2 images to upload right now.
  const [stage, setStage] = useState<UploadStage>("image1");
  const [image1, setImage1] = useState<string | null>(null);
  const [image2, setImage2] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (stage !== "uploading") return;
    uploadImage(image2 ? [image1!, image2] : [image1!], {
      showAfter: true,
      onProgress: (percent) => setProgress(percent),
    })
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
    return (
      <FileBrowserScreen
        onSelect={(p) => {
          setImage1(p);
          setStage("askSecond");
        }}
        onCancel={onBack}
      />
    );
  }

  if (stage === "image2") {
    return (
      <FileBrowserScreen
        onSelect={(p) => {
          setImage2(p);
          setStage("uploading");
        }}
        onCancel={() => setStage("askSecond")}
      />
    );
  }

  if (stage === "askSecond") {
    return (
      <Box flexDirection="column">
        <Text>
          Image 1: <Text color="cyan">{image1}</Text>
        </Text>
        <Text> </Text>
        <Text>Add a second image? Uploading replaces everything currently on the device.</Text>
        <Text dimColor>Enter: choose second image · s/Esc: upload with just this one</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        Image 1: <Text color="cyan">{image1}</Text>
      </Text>
      {image2 && (
        <Text>
          Image 2: <Text color="cyan">{image2}</Text>
        </Text>
      )}
      <Text> </Text>
      {stage === "uploading" && <ProgressBar percent={progress} />}
      {stage === "done" && <Text color="green">Upload complete. Press any key to go back.</Text>}
      {stage === "error" && <Text color="red">{`${error} Press any key to go back.`}</Text>}
    </Box>
  );
}

function TimeSyncScreen({ onBack }: { onBack: () => void }) {
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

  return (
    <Box flexDirection="column">
      {status === "syncing" && <Text>Syncing time...</Text>}
      {status === "done" && <Text color="green">Time synced. Press any key to go back.</Text>}
      {status !== "syncing" && status !== "done" && (
        <Text color="red">{`${status} Press any key to go back.`}</Text>
      )}
    </Box>
  );
}

function RestoreScreen({ onBack }: { onBack: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [yesSelected, setYesSelected] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useInput((input, key) => {
    if (!confirmed) {
      if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
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
    return (
      <Box flexDirection="column">
        <Text color="yellow">
          ⚠ This will ERASE the keyboard's current settings and restore factory defaults.
        </Text>
        <Text> </Text>
        <Text>
          <Text color={!yesSelected ? "cyan" : undefined}>{!yesSelected ? "▸ No" : "  No"}</Text>
          {"   "}
          <Text color={yesSelected ? "cyan" : undefined}>{yesSelected ? "▸ Yes" : "  Yes"}</Text>
        </Text>
        <Text dimColor>←/→/h/l choose · Enter confirm · Esc cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {status === "restoring" && <Text>Restoring...</Text>}
      {status === "done" && <Text color="green">Factory defaults restored. Press any key to go back.</Text>}
      {status && status !== "restoring" && status !== "done" && (
        <Text color="red">{`${status} Press any key to go back.`}</Text>
      )}
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("menu");
  const { width, height } = useTerminalSize();

  const onBack = () => setScreen("menu");

  return (
    <Box flexDirection="column" borderStyle="round" width={width} height={height} padding={1}>
      <Text bold>GMK67-S</Text>
      <Box marginBottom={1}>
        <Text dimColor>{`${SCREEN_LABELS[screen]} · ↑/↓/j/k navigate · Enter select · Esc back · q quit`}</Text>
      </Box>
      {screen === "menu" && <MenuScreen onSelect={setScreen} onQuit={exit} />}
      {screen === "info" && <DeviceInfoScreen onBack={onBack} />}
      {screen === "lights" && <LightingScreen onBack={onBack} />}
      {screen === "preset" && <PresetScreen onBack={onBack} />}
      {screen === "upload" && <UploadScreen onBack={onBack} />}
      {screen === "timesync" && <TimeSyncScreen onBack={onBack} />}
      {screen === "restore" && <RestoreScreen onBack={onBack} />}
    </Box>
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.stdin.isTTY) {
    console.error("gmk67s tui requires an interactive terminal (stdin is not a TTY).");
    process.exit(1);
  }
  process.stdout.write(ALT_SCREEN_ENTER);
  const restoreAltScreen = () => {
    process.stdout.write(ALT_SCREEN_EXIT);
  };
  process.on("exit", restoreAltScreen);
  const { waitUntilExit } = render(<App />);
  waitUntilExit().then(() => {
    restoreAltScreen();
    process.exit(0);
  });
}

export { App };
