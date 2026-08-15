# gmk67s-node

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
- `uploadImage`/`sendImageMagick.js` support an opt-in `--confirm` flag to
  prompt before overwriting a slot's current image; off by default since the
  target slot is always explicit in normal usage.

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

## CLI commands

| Command | Script | Description |
|---|---|---|
| `gmk67s-diagnostic` | `src/diagnostic.js` | Protocol handshake tests + read-only config dump |
| `gmk67s-timesync` | `src/timesync.js` | Sync system time to the keyboard's RTC |
| `gmk67s-lights` | `src/configureLights.js` | Configure underglow/LED via flags |
| `gmk67s-preset` | `src/loadPreset.js` | Apply a named preset from `presets.json` |
| `gmk67s-upload` | `src/sendImageMagick.js` | Upload a static image or GIF to the LCD |
| `gmk67s-restore-factory` | `src/restoreFactory.js` | Restore the FACTORY_CONFIG baseline (prompts for confirmation) |

Examples:

```bash
node src/diagnostic.js
node src/timesync.js
node src/configureLights.js --effect rainbow-cycle --brightness 5
node src/loadPreset.js gaming
node src/loadPreset.js --list
node src/sendImageMagick.js --file image.png --slot 0
node src/sendImageMagick.js --slot0 anim.gif --ms 100 --confirm
node src/restoreFactory.js
node src/restoreFactory.js --yes   # skip the confirmation prompt
```

Or as a library:

```js
import gmk67s from "gmk67s-node";

await gmk67s.setLighting({ underglow: { effect: 5, brightness: 7 } });
await gmk67s.uploadImage("cat.png", 0, { slot0File: "cat.png" });
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
