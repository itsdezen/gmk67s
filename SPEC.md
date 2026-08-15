# GMK67-S Hardware & Protocol Spec

Technical reference for the Zuoya vendor HID protocol implemented by this
project. All offsets are decimal unless prefixed `0x`.

## Device identification

| Field | Value |
|---|---|
| USB Vendor ID | `0x320F` (12815) |
| USB Product ID | `0x5055` (20565) |
| USB Product Name | `ZUOYA GMK67-S` |
| HID Interface | `3` (vendor-specific config/upload interface) |
| HID Report ID | `0x04` |

Before any protocol command is sent, the device must be located by VID+PID
and — when the OS/driver exposes it — its USB product string must match
`ZUOYA GMK67-S` (case-insensitive substring match on "gmk67-s" or "zuoya").
See `findVerifiedDeviceInfo()` in `src/lib/device.js`.

## Display

| Field | Value |
|---|---|
| Resolution | 180 x 180 px (1:1) |
| Pixel format | RGB565 (16-bit: 5 bits R, 6 bits G, 5 bits B), big-endian per pixel |
| Raw frame size | 180 × 180 × 2 = 64800 bytes |
| Padded frame size | 65536 bytes (rounded up to the next 32KB boundary: `(rawSize + 0x7fff) & ~0x7fff`) |
| Slots | 2 independent image slots (0 and 1), each holding 1+ frames for animation |

## 64-byte HID report structure

Every report sent to and received from the device is exactly 64 bytes:

| Byte(s) | Field | Notes |
|---|---|---|
| 0 | Report ID | `0x04` |
| 1 | Checksum LSB | |
| 2 | Checksum MSB | |
| 3 | Command | Opcode, see table below |
| 4 | Data length | Payload length in bytes (0-56) |
| 5-7 | Position | 24-bit little-endian byte offset (LSB, mid, MSB) |
| 8-63 | Payload | Up to 56 bytes of command data, zero-padded |

**Checksum**: 16-bit sum of bytes 3-63 (inclusive), mod 0x10000. Computed
before bytes 1-2 are written.

**ACK matching**: the device's response report echoes the same command byte
at offset 3. Only byte 3 is used to match a response to its request — on
some OS/driver combinations the report ID (byte 0) and checksum (bytes 1-2)
of the echoed response are rewritten by the driver and cannot be relied on
for matching.

## Opcodes

| Opcode | Name | Direction | Purpose |
|---|---|---|---|
| `0x01` | INIT | Host → Device | Begin a command sequence |
| `0x02` | COMMIT | Host → Device | Commit/finalize the current sequence |
| `0x03` | PREP_READ | Host → Device | Stage a config read at a given position |
| `0x05` | READ_DATA | Host → Device | Read config data at a given position |
| `0x06` | WRITE_CONFIG | Host → Device | Write the 48-byte config buffer |
| `0x21` | FRAME_DATA | Host → Device | Write image frame data at a given position |
| `0x23` | READY | Host → Device | Signal start of an image upload session |

## 48-byte config buffer layout

| Offset | Field | Format | Notes |
|---|---|---|---|
| 0 | reserved | — | |
| 1 | underglow.effect | uint8 | see Underglow effects enum |
| 2 | underglow.brightness | uint8 | 0-9 |
| 3 | underglow.speed | uint8 | 0-9 (0=fast, 9=slow) |
| 4 | underglow.orientation | uint8 | 0=left-to-right, 1=right-to-left |
| 5 | underglow.rainbow | uint8 | 0=hue mode, 1=rainbow mode |
| 6 | underglow.hue.red | uint8 | 0-255 |
| 7 | underglow.hue.green | uint8 | 0-255 |
| 8 | underglow.hue.blue | uint8 | 0-255 |
| 9-20 | reserved | — | |
| 21 | winlock | uint8 | 0=off, 1=on |
| 22-27 | reserved | — | |
| 28 | led.mode | uint8 | see LED modes enum |
| 29 | led.saturation | uint8 | 0-9 |
| 30 | reserved | — | |
| 31 | led.rainbow | uint8 | 0=hue mode, 1=rainbow mode |
| 32 | led.color | uint8 | see LED colors enum |
| 33 | showImage | uint8 | 0=show time, 1=show slot 0, 2=show slot 1 |
| 34 | image1Frames | uint8 | frame count in slot 0 |
| 35 | time.second | BCD | |
| 36 | time.minute | BCD | |
| 37 | time.hour | BCD | 24h |
| 38 | time.dayOfWeek | uint8 | 0=Sunday, NOT BCD |
| 39 | time.date | BCD | day of month |
| 40 | time.month | BCD | 1-12 |
| 41 | time.year | BCD | year mod 100 |
| 42 | reserved | — | |
| 43-44 | frameDuration | uint16 LE | animation delay, ms |
| 45 | reserved | — | |
| 46 | image2Frames | uint8 | frame count in slot 1 |
| 47 | reserved | — | |

BCD (Binary-Coded Decimal): a byte encoding a 2-digit decimal number as
`(tens << 4) | ones` — e.g. 42 → `0x42`.

## Enums

**Underglow effects** (`underglow.effect`):

| Value | Name |
|---|---|
| `0x00` | OFF |
| `0x01` | HORIZONTAL_DIMMING_WAVE |
| `0x02` | HORIZONTAL_PULSE_WAVE |
| `0x03` | WATERFALL |
| `0x04` | FULL_CYCLING_COLORS |
| `0x05` | BREATHING |
| `0x06` | FULL_ONE_COLOR |
| `0x07` | GLOW_PRESSED_KEY |
| `0x08` | GLOW_SPREADING |
| `0x09` | GLOW_ROW |
| `0x0a` | RANDOM_PATTERN |
| `0x0b` | RAINBOW_CYCLE |
| `0x0c` | RAINBOW_WATERFALL |
| `0x0d` | WAVE_FROM_CENTER |
| `0x0e` | CIRCLING_JK |
| `0x0f` | RAINING |
| `0x10` | WAVE_LEFT_RIGHT |
| `0x11` | SLOW_SATURATION_CYCLE |
| `0x12` | SLOW_RAINBOW_FROM_CENTER |

**LED modes** (`led.mode`):

| Value | Name |
|---|---|
| `0x00` | BLINKING_ONE_COLOR |
| `0x01` | PULSE_RAINBOW |
| `0x02` | BLINKING_ONE_COLOR_ALT |
| `0x03` | FIXED_COLOR |
| `0x04` | FIXED_COLOR_ALT |

**LED colors** (`led.color`):

| Value | Name |
|---|---|
| `0x00` | RED |
| `0x01` | ORANGE |
| `0x02` | YELLOW |
| `0x03` | GREEN |
| `0x04` | TEAL |
| `0x05` | BLUE |
| `0x06` | PURPLE |
| `0x07` | WHITE |
| `0x08` | OFF |

## Limits

| Limit | Value | Notes |
|---|---|---|
| Payload per report | 56 bytes | bytes 8-63 of the 64-byte report |
| Frame data chunk size | 56 bytes | image data is split into 56-byte `FRAME_DATA` packets |
| Padded frame size | 65536 bytes | per image frame, after 32KB-boundary rounding |
| Max total frames (both slots combined) | 36 | assumed flash-storage limit; not verified on this device |
| Config buffer size | 48 bytes | |

## Protocol sequences

### Read config

```
INIT(0x01)
PREP_READ(0x03, 4 bytes, pos=0)
PREP_READ(0x03, 4 bytes, pos=4)
... (9 times total, pos = 0, 4, 8, ..., 32)
PREP_READ(0x03, 1 byte, pos=36)
COMMIT(0x02)
READ_DATA(0x05, 4 bytes, pos=0)  → returns 4 bytes of config
READ_DATA(0x05, 4 bytes, pos=4)  → returns 4 bytes of config
... (12 times total, pos = 0, 4, 8, ..., 44) → concatenated = 48-byte config buffer
```

### Write config

```
INIT(0x01)
WRITE_CONFIG(0x06, 48-byte payload, pos=0)
COMMIT(0x02)
```

Write is only considered successful if all three steps ACK. On failure, the
config write path rolls back by re-writing the previously-read config buffer.

### Upload image

```
[Write config: showImage + image1Frames/image2Frames + frameDuration set via the write-config sequence above]
READY(0x23)
INIT(0x01)
FRAME_DATA(0x21, ≤56 bytes, pos=N)  × (total bytes / 56), where pos is the
  cumulative byte offset into the concatenated [slot0 frames..., slot1 frames...]
  buffer (each frame padded to 65536 bytes)
COMMIT(0x02)
```

## Factory default config

48-byte config buffer used by `restoreFactoryDefaults()`. Time bytes
(offsets 35-41) are overwritten with the current time at restore time; the
values below are only meaningful for the non-time fields.

```
0x00, 0x06, 0x09, 0x04, 0x01, 0x00, 0xff, 0x01, 0x00, 0x00, 0x00, 0x00,
0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00,
0x00, 0x00, 0x00, 0x00, 0x03, 0x07, 0x02, 0x00, 0x03, 0x02, 0x01, 0x00,
0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x01, 0x00
```

Decoded: underglow effect=`0x06` (FULL_ONE_COLOR), brightness=9, speed=4,
orientation=1, rainbow=0, RGB=(255,1,0); winlock=0; led mode=`0x03`
(FIXED_COLOR), saturation=7, rainbow=0, color=`0x03` (GREEN); showImage=2
(slot 1); image1Frames=1; frameDuration=100ms (`0x64`); image2Frames=1.

## Unverified

| Item | Status |
|---|---|
| Upload sequence end-to-end on real hardware | Not yet run against physical hardware in this codebase's test history |
| 36-frame total limit | Assumed, not confirmed for this device |
| Reserved/unknown byte meanings (offsets 0, 9-20, 22-27, 30, 42, 45, 47) | Unknown — preserved as-is by all read-modify-write paths, never written directly |
