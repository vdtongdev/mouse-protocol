# ZIFRIEND M6 protocol

The ZIFRIEND M6 (PixArt PAW3395, tri-mode) is built by Darmoshark on a Telink
radio. Its configuration channel is the command set Keychron Launcher calls
"1k" (`src/keychron/index.ts`, `src/drivers/keychron/mouse-1k-hid.ts`).

## Sources

- **ZIFRIEND_M6_Mouse Beta 1.0.0.4**, the official Windows driver. Its Inno
  Setup payload holds `config.xml` (USB IDs per connection), `device/Zifriend-m6.xml`
  (button table, lighting tab disabled) and `DeviceDriver.exe`, whose PDB path is
  `...\DarmosharkMouse\bin\DeviceDriver.pdb`. Everything below comes from
  static analysis of that executable: the frame builders, the answer parsers,
  and the GBK debug strings that name each command (for example
  `0x51 0x41: 设置回报率失败`, "set polling rate failed"). No vendor code or
  binary is committed here.
- **Keychron Launcher**, as already decoded in this repository. Its "1k"
  identity, status, DPI, sensor and debounce layouts match the M6 at every
  shared offset, which is independent confirmation of both decodes.

Nothing here has been checked against a physical M6 yet. Hardware tests are
listed at the end.

## Devices

| Connection | VID:PID | Interface | Notes |
| --- | --- | --- | --- |
| USB cable | `248A:FF19` | `MI_02` | |
| 2.4 GHz receiver | `248A:FF32` | `MI_01` | `0x51 0x03` reports the paired mouse |
| Bluetooth | `248A:FF19` | BLE HID | The vendor software refuses to change settings over Bluetooth |

`0x248A` is Telink's vendor ID and is shared by unrelated devices, so the
driver claims only these two product IDs. The vendor driver falls back to
`248A:FF12` when a receiver reports no paired mouse; that ID is not claimed.

## Transport

The control collection is usage page `0x008C`, usage `0x01` (the vendor
driver checks exactly these values from `HidP_GetCaps`).

| Report | Kind | Size | Use |
| --- | --- | --- | --- |
| `0x51` | Feature | 20 | Settings. `HidD_SetFeature`, then `IOCTL_HID_GET_FEATURE` on the same report for the answer |
| `0x52` | Feature | 64 | Buttons and macros (not implemented) |
| `0x54` | Input | 20 | Events, type in byte 0 |

Offsets below are into the payload, after the report ID. The vendor driver
waits up to 10 × 200 ms for the receiver to relay a 2.4 GHz command, and
treats `54 E4 00` as success.

## Commands on report 0x51

| Cmd | Direction | Meaning |
| --- | --- | --- |
| `03` | read | Receiver: paired mouse. `[2..3]` VID, `[4..5]` PID |
| `04` | read | Receiver (sent with `[1]=AA`): a string, `[1]` length. Keychron reads its firmware here; not confirmed for the M6 |
| `06` | read | Identity, link state and battery |
| `07` | read | Settings |
| `0B` | write | `[1]=AA`: factory reset, answered by `54 E6`. `[1]=01, [2]=flags` is also sent, meaning unclear. Neither is used |
| `0C` | write | `[1]=02`: wake the 2.4 GHz link before reading (answered by `54 E3`) |
| `12` | read | Lighting: `[1]` version, `[2]` effect count, `[3]` active effect |
| `13`–`17` | read | Lighting brightness and RGB (not used) |
| `22`, `23`, `27`, `28` | write | Lighting effect, brightness, speed, colour (not used) |
| `40` | write | DPI |
| `41` | write | Polling rate |
| `42` | write | Sensor and power options |
| `43` | write | Debounce |

### `06` identity

| Byte | Meaning |
| --- | --- |
| 1-2 | Protocol version, LE |
| 3-4 | Vendor ID, LE |
| 5-6 | Product ID, LE |
| 7-8 | Firmware, LE |
| 9 | Bits 0-2 connection (0 USB; 1, 3, 4 2.4 GHz; 2 Bluetooth), bit 3 linked |
| 10 | Battery, percent (the vendor gauge draws it as 0-100) |
| 11 | Bits 0-1: 1 charging, 2 full |

### `07` settings

| Byte | Meaning |
| --- | --- |
| 1 | Profile |
| 2, 3, 4 | USB, 2.4 GHz, Bluetooth: bits 0-3 active DPI stage, bits 4-6 polling gear |
| 5-14 | Five DPI stages, LE16, raw DPI (factory 400/800/1600/3200/4800) |
| 15 | Flags: bits 0-1 lift-off code, `0x04` ripple, `0x08` angle snap, `0x10` Motion Sync, `0x20` see below, `0x40` scroll reversed |
| 16 | DPI stage count (the vendor calls it `dpi_flag`) |
| 17 | Debounce, ms |

Polling gears are 0 = 125 Hz, 1 = 500 Hz, 2 = 1000 Hz. The vendor UI also has a
gear 3 (2000 Hz) button, but the M6 build's polling write lists only the first
three rates, so the driver offers those.

### `40` DPI

`[1..3]` active stage for USB, 2.4 GHz and Bluetooth, with `FF` meaning "leave
alone" (the vendor driver writes only the current connection's slot),
`[4..13]` five stages LE16, `[14]` stage count.

### `41` polling

`[1..3]` gear per connection (`FF` = leave alone), then `[4..9]` the rate table
as LE16 hertz: `7D 00 F4 01 E8 03` (125, 500, 1000). Keychron's "1k" build
sends gear indexes here instead.

### `42` sensor

| Byte | Meaning |
| --- | --- |
| 1 | Lift-off code: 1 = 1 mm (low), 2 = 2 mm (high) |
| 2 | Ripple control, 1 on / 2 off |
| 3 | Angle snapping, 1 on / 2 off |
| 4 | Motion Sync, 1 on / 2 off |
| 6 | Scroll direction, 1 forward / 2 reversed |
| 7 | E-sports mode, 1 on / 2 off (factory: on) |

The vendor driver sends every byte from its own database. Keychron's decode
says 0 leaves a toggle unchanged, so the driver sends 0 for E-sports on every
write except its own, and never flips it as a side effect.

### `43` debounce

`[1]` milliseconds. The vendor UI clamps to 0-20.

## Events on input report 0x54

| Type | Meaning |
| --- | --- |
| `E0` | Mouse restarted |
| `E1` | Lighting effect report |
| `E2` | Status: `[1]` connection, `[2]` linked, `[3]` charging, `[4]` battery %, `[5]` active stage, `[6]` polling gear |
| `E3` | Command acknowledged |
| `E4` | Wireless command result, `[1]` 0 = success, 2 or more = failure |
| `E6` | Factory reset done |

## Why the vendor battery reading is wrong

Two behaviours in `DeviceDriver.exe` explain the complaints:

1. On every `E2` event it compares the connection and link bytes with the
   previous event, and when either changed it logs `设备状态发生变化, 不获取电量值`
   ("device state changed, not reading battery") and keeps the old value. After
   a reconnect or a wake from sleep the gauge stays stale until the next event.
2. While charging, `BatteryCtrl` animates the fill from 0 up to the level
   instead of drawing the level.

The driver reads `06` on every poll and reports charging as a state next to
the real percentage.

## Not in the vendor software

- **Sleep timer.** The driver seeds a `sleep_light` setting but never sends
  it; no sleep command is known for this firmware, so none is offered.
- **Lighting.** Lighting code is present, but `Zifriend-m6.xml` sets
  `<menu light="0" />`. `readLightingInfo()` reads `12` without writing; an
  effect count of 0 would confirm the M6 has nothing to drive.
- **Bluetooth configuration.** The vendor shows "The mouse setting is not
  supported in Bluetooth mode". The driver reports Bluetooth as read-only.

## Open questions

- **E-sports read-back.** The vendor driver never reads E-sports from the
  mouse. Bit `0x20` of the `07` flags is the likeliest home (factory flags are
  53 = `0x35` with E-sports on), and the driver uses it until a write in the
  same session overrides it. Unconfirmed.
- Whether "E-sports off" lowers power draw is the vendor's framing of the
  setting, not something measured here.
- The `06` battery byte is assumed to be a percentage because the vendor gauge
  scales it by 100. A firmware that reports coarse steps would show as
  multiples of a step.

## Hardware test checklist

Run each on the cable and on the receiver, and note firmware from the status:

1. Status reads: DPI stages, active stage, polling, LOD, sensor toggles,
   scroll direction, debounce and battery match the vendor app.
2. Battery: unplug and replug, wake from sleep, charge. The percentage
   should update within one poll and never animate.
3. Each write round-trips (the driver re-reads and fails loudly when a value
   does not stick).
4. E-sports: toggle it in the vendor app and read `07` byte 15 bit `0x20` each
   time. Then toggle it in OpenMouse and confirm the vendor app agrees.
5. `readLightingInfo()` effect count.
6. Bluetooth: the device appears read-only with a note, and no write is sent.
