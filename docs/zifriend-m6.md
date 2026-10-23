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

Round 1 of hardware testing (one M6, cable and receiver) is recorded under
"Measured on hardware". Anything not listed there is still decoded from the
vendor binary only.

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

Through the receiver, writes apply at once but `06` and `07` are answered from a
cache that only a wake refreshes. The driver sends `0C 02` (plain feature
report, no answer is read) and waits 300 ms before every `06`/`07` read,
including each confirm re-read after a write. Writes get no wake, as in the
vendor driver, and the driver does not depend on input reports.

## Commands on report 0x51

| Cmd | Direction | Meaning |
| --- | --- | --- |
| `03` | read | Receiver: paired mouse. `[2..3]` VID, `[4..5]` PID |
| `04` | read | Receiver (sent with `[1]=AA`): a string, `[1]` length. Keychron reads its firmware here; not confirmed for the M6 |
| `06` | read | Identity, link state and battery |
| `07` | read | Settings |
| `0B` | write | `[1]=AA`: factory reset, answered by `54 E6`. `[1]=01, [2]=flags` is also sent, meaning unclear. Neither is used |
| `0C` | write | `[1]=02`: wake the 2.4 GHz link, sent before every receiver `06`/`07` read; no feature answer, it triggers `54 E4 00` and `54 E3` input reports |
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
| 15 | Flags: bits 0-1 lift-off code, `0x04` ripple, `0x08` angle snap, `0x10` Motion Sync, `0x20` unknown (not E-sports, see below), `0x40` scroll reversed |
| 16 | DPI stage count 1-5 over the cable (the vendor calls it `dpi_flag`). The receiver always sends 0, which means unknown, not five. A value above 5 is rejected |
| 17 | Debounce, ms |

Polling gears are 0 = 125 Hz, 1 = 500 Hz, 2 = 1000 Hz. The vendor UI also has a
gear 3 (2000 Hz) button, but the M6 build's polling write lists only the first
three rates, so the driver offers those.

### `40` DPI

`[1..3]` active stage for USB, 2.4 GHz and Bluetooth, with `FF` meaning "leave
alone" (the vendor driver writes only the current connection's slot),
`[4..13]` five stages LE16, `[14]` stage count. Byte 14 = 0 leaves the count
alone: tested on hardware over the cable (`248A:FF19`), where a write with 0
changed the active stage and left the count at 3. The driver sends 0 whenever
the count is unknown.

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
| 7 | E-sports mode, 1 on / 2 off (the vendor driver seeds it on; the tested unit shipped with it off) |

The vendor driver sends every byte from its own database. Keychron's decode
says 0 leaves a toggle unchanged, so the driver sends 0 for E-sports on every
write except its own, and never flips it as a side effect.

E-sports is write-only. Toggling it in the vendor app changed nothing in `07`
(byte 15 stayed `0x15`), and the vendor app never reads it back either. Bit
`0x20` of byte 15 is therefore not E-sports; what it is remains unknown. The
driver shows the last value set in OpenMouse in this browser (kept in
`localStorage`, key `openmouse-zifriend-v1:m6:esports`, shared by the cable and
the receiver); changes made in the vendor app are not seen. With nothing stored
it reports off. Off is the default because the
tested unit shipped with it off, and it keeps the switch visible in OpenMouse
(which hides the card for an unknown value). Writes are absolute (byte 7 = 1 on,
2 off), so a wrong display never flips the setting the wrong way. A write cannot
be confirmed.

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
- **Lighting.** The vendor hides the lighting tab (`Zifriend-m6.xml` sets
  `<menu light="0" />`). `12` was not answered on hardware (empty over the
  cable, a stale buffer over the receiver), so the effect count is unknown and
  no lighting is exposed. `readLightingInfo()` only reads.
- **Bluetooth configuration.** The vendor shows "The mouse setting is not
  supported in Bluetooth mode". The driver reports Bluetooth as read-only.

## Open questions

- What byte 15 bit `0x20` means. It is set in the vendor seed flags `0x35` and clear in
  `0x15`, and does not follow E-sports.
- Whether "E-sports off" lowers power draw is the vendor's framing of the
  setting. Its effect on battery life has not been measured.
- Whether the receiver can ever report the DPI stage count. Over 2.4 GHz the
  driver hides the count picker and refuses to change the count.
- Whether `12` is answered by any firmware or connection.

## Measured on hardware

Mouse firmware v2.0.1 (`0x0201`), 2026-10-23.

Cable (PID `0xFF19`):

- `06` answered `06 01 00 8a 24 19 ff 01 02 00 63 01`: USB, battery 99, power
  state 1 (charging).
- `07` answered `07 01 11 11 01 90 01 20 03 40 06 80 0c c0 12 15 03 08 00 00`.
  Byte 16 is 3. The DPI button cycled the active stage 1, 2, 0, 1 (bytes 2 and 3
  moved together), so the mouse has 3 stages in use, while the vendor app shows
  5 slots.
- `12` answered with an empty buffer.
- Verified: a `40` write with byte 14 = 0 and a different active stage applied
  the stage and left the count at 3. The write answer is empty. The value was
  restored afterwards.
- Right after a write, the other connection slots can read a stale value once;
  a later read settles.

2.4 GHz receiver (PID `0xFF32`):

- `07` byte 16 is always 0, also while the DPI button cycled 3 stages. The
  receiver does not relay the count. Captured:
  `07 01 11 11 11 90 01 20 03 40 06 80 0c c0 12 15 00 08 00 00`.
- Toggling E-sports in the vendor app changed nothing in `07` (byte 15 stayed
  `0x15`).
- `06` battery 91 matched the vendor app's 91%. The linked bit (byte 9, `0x08`)
  dropped to 0 while the mouse idled and came back.
- `12` was not answered: the buffer kept the previous answer.
- Receiver debounce 1, 2, 3, 4, 6 in turn, 2026-10-23: after the write `51 43 v`, a `07`
  read without a wake returned the previous value every time; after `51 0c 02`
  and 300 ms it returned the new value 5/5 (the wake produced `54 e4 00` and
  `54 e3`). A wake answered by `54 e4 04` did not refresh the read. So writes
  apply at once and the receiver reads from a cache the wake refreshes.
  The vendor driver also sends sensor writes (`42`) and then waits for
  `54 e4 00`, resending up to 10 times; ours just confirms by wake and re-read,
  which could be replaced by that wait later.
- `03` returned the paired mouse `248A:FF19`.
- After switching the mouse from the cable back to 2.4 GHz, every GetFeature on
  the receiver failed with Windows error 0x1F (the vendor app could not read
  either) until the receiver was unplugged and replugged, once needing two
  tries. The driver's error message says to replug the receiver.
- The feature buffer is shared with other processes: one read collected the
  vendor app's `04` answer. `zifriendAnswer` rejects answers to other commands.

Cable (PID `0xFF19`), UI round, 2026-10-23. Every change was made in the
OpenMouse UI and read back from `07`; all survived an unplug and replug, with no
UI errors:

- Polling 500 to 1000 Hz (gear 2). The 2.4 GHz slot (byte 3) also changed to
  gear 2 although the write only targeted the USB slot, so the mouse applies
  polling to all slots.
- Lift-off Low to High, ripple on to off, angle snapping off to on, Motion Sync
  on to off, scroll forward to reversed, debounce 8 to 4 ms, DPI stage 3 1600 to
  1650 (stage count stayed 3).
- `07` afterwards: `07 01 21 21 01 90 01 20 03 72 06 80 0c c0 12 4a 03 04 00 00`.
- Battery 100, power state 2 (full) on the cable.

## Hardware test checklist

Done in round 1 (cable `0xFF19` and receiver `0xFF32` unless noted):

- [x] Status reads: stage count, active stage and DPI slots (cable). The
  receiver cannot report the stage count.
- [x] Battery matched the vendor app (91% on the receiver) and the cable read
  99% charging. Replug, wake and full-charge behaviour were not exercised.
- [x] DPI write over the cable round-trips, including count byte 0 as leave
  alone. Verified for `0xFF19` only.
- [x] E-sports is not readable (receiver). Bit `0x20` is not E-sports.
- [x] `12` is not answered, so lighting is not exposed.
- [ ] DPI write over the receiver (count unknown, byte 14 = 0). Retest with the wake-before-read fix.

Done in the UI round (cable `0xFF19` only, not the receiver):

- [x] Polling rate, lift-off, ripple, angle snapping, Motion Sync, scroll
  direction and debounce writes round-trip and survive a replug.
- [x] DPI stage value write from the UI (stage 3, count unchanged).

Not yet tested:

- [ ] The same writes over the 2.4 GHz receiver (retest with the wake-before-read fix).
- [ ] Writes over 2.4 GHz confirm inside the retry window.
- [ ] E-sports write in OpenMouse, and whether the vendor app follows it.
  User-measured drain is about 8% of battery per day of use with E-sports off
  (the vendor app showed it off on this unit); the effect of turning it on is
  not measured.
- [ ] Bluetooth: the device appears read-only with a note, and no write is sent.
