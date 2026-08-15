# gmk67s

Node.js CLI for the GMK67-S keyboard: LCD image/GIF upload, RGB underglow +
LED configuration, lighting presets, time sync, config dump, and
factory-default restore — over the Zuoya vendor HID protocol.

See [SPEC.md](./SPEC.md) for the full protocol/hardware reference (opcodes,
report layout, config buffer offsets, enums, factory defaults).

## Scope

Not implemented, by design:

- **Custom key layout / VIA support** — out of scope.
- **Daemon / background service** — CLI-only, run-on-demand. No persistent process.
- **Electron GUI** — CLI/library only.

## Safety

- Every device operation is gated behind a check that the connected device's
  VID/PID and (when available) USB product name actually match the GMK67-S.
  If no matching device is found, or a device matches VID/PID but reports a
  different product name, the tool refuses to send any protocol command and
  exits with a clear error.
- Config writes roll back to the previous configuration if the write fails
  to acknowledge, so a dropped connection mid-write doesn't leave the
  keyboard in an undefined state.
- `restoreFactoryDefaults` (erases the current config) prompts for
  interactive confirmation unless `--yes`/`--force` is passed.
- The device protocol has no opcode to read back an existing image, and
  every upload overwrites the device's entire image memory in one
  contiguous write. So every `gmk67s upload` call is a full replace: it
  always defines the complete image content going forward (1 or 2 images),
  with no way to preserve anything already on the device. This is expected,
  ordinary behavior — not a destructive edge case — so there's no
  confirmation prompt for it.

## Install

```bash
npm install
```

### Linux

Copy the udev rule so the device doesn't require root:

```bash
sudo cp 50-gmk67s.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## CLI

A single `gmk67s` binary dispatches to subcommands:

```bash
gmk67s <subcommand> [options]
gmk67s --help
```

| Subcommand | Underlying script | Description |
|---|---|---|
| `diagnostic` | `src/diagnostic.js` | Protocol handshake tests + read-only config dump |
| `timesync` | `src/timesync.js` | Sync system time to the keyboard's RTC |
| `lights` | `src/configureLights.js` | Configure underglow/LED via flags |
| `preset` | `src/loadPreset.js` | Apply a named preset from `presets.json` |
| `upload` | `src/sendImageMagick.js` | Upload a static image or GIF to the LCD |
| `restore-factory` | `src/restoreFactory.js` | Restore the FACTORY_CONFIG baseline (prompts for confirmation) |
| `tui` | `src/tui.js` | Interactive terminal UI (menu-driven, same underlying API) |

Examples (via the dispatcher, or by running each script directly with `node`):

```bash
gmk67s diagnostic
gmk67s timesync
gmk67s lights --effect rainbow-cycle --brightness 5
gmk67s preset gaming
gmk67s preset --list
gmk67s upload image.png                  # 1 image — uses the full 36-frame budget
gmk67s upload cat.png dog.png            # 2 images — 36-frame budget split 18/18
gmk67s upload anim.gif --ms 100          # animated GIF, 100ms per frame
gmk67s restore-factory
gmk67s restore-factory --yes   # skip the confirmation prompt
gmk67s tui                     # interactive menu — device info, lights, presets, upload, timesync, restore
```

Every subcommand also works as `node src/<script>.js [options]` directly.

Or as a library:

```js
import gmk67s from "gmk67s";

await gmk67s.setLighting({ underglow: { effect: 5, brightness: 7 } });
await gmk67s.uploadImage("cat.png");
await gmk67s.uploadImage(["cat.png", "dog.png"]);
await gmk67s.syncTime();
await gmk67s.restoreFactoryDefaults(null, { assumeYes: true });
const config = await gmk67s.readConfig();
```

## Verification checklist

1. `npm install`, then try `node src/diagnostic.js` and `node src/timesync.js` first.
2. Test LCD upload with an asymmetric marker image, confirm it renders
   correctly on real hardware.
3. Test rollback: simulate a failed config write (e.g. disconnect mid-write)
   and confirm the previous config is restored.
4. Test factory restore on real hardware and compare against the
   `FACTORY_CONFIG` table in SPEC.md.
