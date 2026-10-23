/**
 * ZIFRIEND M6 configuration protocol.
 *
 * The M6 is a Darmoshark-built mouse (the vendor driver's debug symbols are
 * from a "DarmosharkMouse" project) on a Telink radio (vendor ID 0x248a). Its
 * configuration channel is the same command set Keychron Launcher calls "1k"
 * (see `@openmouse/protocol/keychron`), and the two independent decodes agree
 * on every shared offset. The M6 firmware differs in three places: the
 * polling write carries its rate table as little-endian hertz, unused
 * connection slots are sent as 0xff ("leave alone"), and the sensor write has
 * an E-sports byte.
 *
 * Decoded from ZIFRIEND_M6_Mouse Beta 1.0.0.4 (DeviceDriver.exe) by static
 * analysis. Offsets below are into the report payload, after the report ID.
 *
 * Transport, on the usage page 0x008c / usage 0x01 collection:
 * - settings: feature report 0x51, 20 bytes. Send with SET_FEATURE, fetch the
 *   answer with GET_FEATURE on the same report.
 * - buttons and macros: feature report 0x52, 64 bytes (not implemented here).
 * - events: input report 0x54, 20 bytes, type in byte 0 (0xe0..0xe6).
 */

export const ZIFRIEND_VENDOR_ID = 0x248a;
/** The M6 on its cable (and its Bluetooth HID identity). */
export const ZIFRIEND_M6_PRODUCT_ID = 0xff19;
/** The M6's 2.4 GHz USB-A receiver. */
export const ZIFRIEND_M6_RECEIVER_PRODUCT_ID = 0xff32;
export const ZIFRIEND_PRODUCT_IDS = [ZIFRIEND_M6_PRODUCT_ID, ZIFRIEND_M6_RECEIVER_PRODUCT_ID] as const;

export const ZIFRIEND_USAGE_PAGE = 0x008c;
export const ZIFRIEND_USAGE = 0x01;
export const ZIFRIEND_SETTINGS_REPORT_ID = 0x51;
export const ZIFRIEND_BUTTON_REPORT_ID = 0x52;
export const ZIFRIEND_EVENT_REPORT_ID = 0x54;
export const ZIFRIEND_SETTINGS_LENGTH = 20;
export const ZIFRIEND_BUTTON_LENGTH = 64;

/** Command bytes on feature report 0x51. */
export const ZIFRIEND_COMMAND = {
  /** Receiver only: VID/PID of the paired mouse. */
  pairedMouse: 0x03,
  identity: 0x06,
  settings: 0x07,
  /** 0x0c 0x02: the vendor driver sends this to wake the 2.4 GHz link before reading. */
  radioWake: 0x0c,
  lightingInfo: 0x12,
  dpi: 0x40,
  polling: 0x41,
  sensor: 0x42,
  debounce: 0x43,
} as const;

/** Event types on input report 0x54, byte 0. */
export const ZIFRIEND_EVENT = {
  rebooted: 0xe0,
  lighting: 0xe1,
  status: 0xe2,
  commandAck: 0xe3,
  wirelessResult: 0xe4,
  factoryReset: 0xe6,
} as const;

/** 2.4 GHz is 1, 3 or 4 in the vendor driver; 2 is Bluetooth. */
export type ZifriendConnection = "usb" | "wireless" | "bluetooth" | "unknown";

export function zifriendConnection(mode: number): ZifriendConnection {
  if (mode === 0) return "usb";
  if (mode === 1 || mode === 3 || mode === 4) return "wireless";
  if (mode === 2) return "bluetooth";
  return "unknown";
}

/** Index of a connection's slot in the per-connection level bytes and write slots. */
export function zifriendSlot(connection: ZifriendConnection): 0 | 1 | 2 {
  return connection === "wireless" ? 1 : connection === "bluetooth" ? 2 : 0;
}

export const ZIFRIEND_DPI_STAGE_COUNT = 5;
export const ZIFRIEND_DPI_MIN = 100;
export const ZIFRIEND_DPI_MAX = 26_000;
export const ZIFRIEND_DPI_STEP = 50;
/** The vendor UI clamps debounce to 0-20 ms. */
export const ZIFRIEND_DEBOUNCE_MAX_MS = 20;
/**
 * Polling gears. The vendor UI knows a fourth gear (3 = 2000 Hz), but the M6
 * build lists only these three in its polling write, so only they are offered.
 */
export const ZIFRIEND_POLLING_RATES = [125, 500, 1000] as const;
/** Lift-off codes: the vendor UI labels 1 as 1 mm (low) and 2 as 2 mm (high). */
export const ZIFRIEND_LIFT_OFF = { Low: 1, High: 2 } as const;
/** Byte value meaning "do not change this slot or option". */
export const ZIFRIEND_KEEP = 0xff;

export interface ZifriendIdentity {
  protocolVersion: number;
  vendorId: number;
  productId: number;
  /** Raw firmware word, bytes 7-8. */
  firmware: number;
  connection: ZifriendConnection;
  /** Bit 3 of byte 9: whether the receiver currently hears the mouse. */
  linked: boolean;
  /** 0-100, or null when the byte is out of range. */
  batteryPercent: number | null;
  /** Bits 0-1 of byte 11: 1 charging, 2 full. */
  powerState: number;
}

export interface ZifriendSettings {
  profile: number;
  /** USB, 2.4 GHz, Bluetooth: DPI stage in bits 0-3, polling gear in bits 4-6. */
  levels: [number, number, number];
  dpiStages: number[];
  stageCount: number;
  lod: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  /**
   * Bit 5 of the sensor flags. The vendor driver never reads E-sports mode
   * back; the factory flags (53 = 0x35) have this bit set and E-sports on by
   * default, so it is the likeliest home. Unconfirmed until tested on hardware.
   */
  eSportsBit: boolean;
  scrollReversed: boolean;
  debounceMs: number;
}

export interface ZifriendStatusEvent {
  connection: ZifriendConnection;
  linked: boolean;
  powerState: number;
  batteryPercent: number | null;
  activeStage: number;
  pollingGear: number;
}

export interface ZifriendLightingInfo {
  version: number;
  modeCount: number;
  activeMode: number;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function putU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function percent(value: number | undefined): number | null {
  return value !== undefined && value <= 100 ? value : null;
}

function toggle(enabled: boolean): number {
  return enabled ? 1 : 2;
}

function settingsPacket(command: number): Uint8Array {
  const packet = new Uint8Array(ZIFRIEND_SETTINGS_LENGTH);
  packet[0] = command;
  return packet;
}

/** A read request: the command byte alone. */
export function zifriendRequest(command: number, ...data: number[]): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) throw new RangeError("Invalid ZIFRIEND command.");
  if (data.length > ZIFRIEND_SETTINGS_LENGTH - 1) throw new RangeError("ZIFRIEND request is too long.");
  const packet = settingsPacket(command);
  data.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError("Invalid ZIFRIEND payload byte.");
    packet[1 + index] = value;
  });
  return packet;
}

/**
 * The payload of a feature-report answer. Some platforms hand back the report
 * ID as byte 0 and some strip it; neither 0x51 nor 0x52 is ever a command
 * byte, so the two shapes cannot be confused.
 */
export function zifriendAnswer(source: DataView | Uint8Array, reportId: number, command: number): Uint8Array {
  const raw = source instanceof Uint8Array ? source : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  const bytes = raw[0] === reportId && raw[1] === command ? raw.subarray(1) : raw;
  if (bytes[0] !== command) {
    throw new Error(`Unexpected ZIFRIEND answer 0x${(bytes[0] ?? 0).toString(16)} to command 0x${command.toString(16)}.`);
  }
  return bytes;
}

/** 0x06: protocol, IDs, firmware, connection and battery. */
export function zifriendDecodeIdentity(bytes: Uint8Array): ZifriendIdentity {
  if (bytes[0] !== ZIFRIEND_COMMAND.identity || bytes.length < 12) throw new Error("Truncated ZIFRIEND identity answer.");
  const link = bytes[9] ?? 0;
  return {
    protocolVersion: u16(bytes, 1),
    vendorId: u16(bytes, 3),
    productId: u16(bytes, 5),
    firmware: u16(bytes, 7),
    connection: zifriendConnection(link & 0x07),
    linked: (link & 0x08) !== 0,
    batteryPercent: percent(bytes[10]),
    powerState: (bytes[11] ?? 0) & 0x03,
  };
}

/** Firmware word as Keychron Launcher formats the same field: v<hi>.<lo hi nibble>.<lo lo nibble>. */
export function zifriendFirmwareLabel(firmware: number): string {
  const low = firmware & 0xff;
  return `v${firmware >> 8}.${low >> 4}.${low & 0x0f}`;
}

/** 0x07: profile, per-connection levels, DPI stages, sensor flags and debounce. */
export function zifriendDecodeSettings(bytes: Uint8Array): ZifriendSettings {
  if (bytes[0] !== ZIFRIEND_COMMAND.settings || bytes.length < 18) throw new Error("Truncated ZIFRIEND settings answer.");
  const flags = bytes[15] ?? 0;
  const stageCount = bytes[16] ?? 0;
  if (stageCount < 1 || stageCount > ZIFRIEND_DPI_STAGE_COUNT) throw new Error(`Invalid ZIFRIEND DPI stage count ${stageCount}.`);
  return {
    profile: bytes[1] ?? 0,
    levels: [bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0],
    dpiStages: Array.from({ length: ZIFRIEND_DPI_STAGE_COUNT }, (_, stage) => u16(bytes, 5 + stage * 2)),
    stageCount,
    lod: flags & 0x03,
    rippleControl: (flags & 0x04) !== 0,
    angleSnapping: (flags & 0x08) !== 0,
    motionSync: (flags & 0x10) !== 0,
    eSportsBit: (flags & 0x20) !== 0,
    scrollReversed: (flags & 0x40) !== 0,
    debounceMs: bytes[17] ?? 0,
  };
}

export function zifriendActiveStage(settings: ZifriendSettings, connection: ZifriendConnection): number {
  return Math.min((settings.levels[zifriendSlot(connection)] ?? 0) & 0x0f, settings.stageCount - 1);
}

export function zifriendPollingGear(settings: ZifriendSettings, connection: ZifriendConnection): number {
  return ((settings.levels[zifriendSlot(connection)] ?? 0) >> 4) & 0x07;
}

function slotted(connection: ZifriendConnection, value: number): [number, number, number] {
  const slots: [number, number, number] = [ZIFRIEND_KEEP, ZIFRIEND_KEEP, ZIFRIEND_KEEP];
  slots[zifriendSlot(connection)] = value;
  return slots;
}

/**
 * 0x40: active stage for the current connection only (the other two slots
 * are 0xff, as the vendor driver sends them), five stages, stage count.
 */
export function zifriendEncodeDpi(
  connection: ZifriendConnection,
  activeStage: number,
  dpiStages: readonly number[],
  stageCount: number,
): Uint8Array {
  if (!Number.isInteger(stageCount) || stageCount < 1 || stageCount > ZIFRIEND_DPI_STAGE_COUNT) {
    throw new RangeError(`ZIFRIEND stage count must be 1-${ZIFRIEND_DPI_STAGE_COUNT}.`);
  }
  if (!Number.isInteger(activeStage) || activeStage < 0 || activeStage >= stageCount) {
    throw new RangeError("ZIFRIEND active stage is outside the stage count.");
  }
  if (dpiStages.length !== ZIFRIEND_DPI_STAGE_COUNT) throw new RangeError("ZIFRIEND DPI writes carry all five stages.");
  const packet = settingsPacket(ZIFRIEND_COMMAND.dpi);
  packet.set(slotted(connection, activeStage), 1);
  dpiStages.forEach((dpi, stage) => {
    if (!Number.isInteger(dpi) || dpi < 0 || dpi > 0xffff) throw new RangeError("Invalid ZIFRIEND DPI value.");
    putU16(packet, 4 + stage * 2, dpi);
  });
  packet[14] = stageCount;
  return packet;
}

/** 0x41: polling gear for the current connection, then the rate table in hertz. */
export function zifriendEncodePolling(connection: ZifriendConnection, gear: number): Uint8Array {
  if (!Number.isInteger(gear) || gear < 0 || gear >= ZIFRIEND_POLLING_RATES.length) throw new RangeError("Invalid ZIFRIEND polling gear.");
  const packet = settingsPacket(ZIFRIEND_COMMAND.polling);
  packet.set(slotted(connection, gear), 1);
  ZIFRIEND_POLLING_RATES.forEach((rate, index) => putU16(packet, 4 + index * 2, rate));
  return packet;
}

export interface ZifriendSensorWrite {
  lod: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  scrollReversed: boolean;
  /** Omit to send 0, which the family's firmware treats as "leave alone". */
  eSports?: boolean;
}

/** 0x42: every sensor option at once. Toggles are 1 on, 2 off; scroll is 1 forward, 2 reversed. */
export function zifriendEncodeSensor(sensor: ZifriendSensorWrite): Uint8Array {
  if (sensor.lod !== ZIFRIEND_LIFT_OFF.Low && sensor.lod !== ZIFRIEND_LIFT_OFF.High) throw new RangeError("Invalid ZIFRIEND lift-off code.");
  const packet = settingsPacket(ZIFRIEND_COMMAND.sensor);
  packet[1] = sensor.lod;
  packet[2] = toggle(sensor.rippleControl);
  packet[3] = toggle(sensor.angleSnapping);
  packet[4] = toggle(sensor.motionSync);
  packet[6] = sensor.scrollReversed ? 2 : 1;
  packet[7] = sensor.eSports === undefined ? 0 : toggle(sensor.eSports);
  return packet;
}

export function zifriendEncodeDebounce(debounceMs: number): Uint8Array {
  if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > ZIFRIEND_DEBOUNCE_MAX_MS) {
    throw new RangeError(`ZIFRIEND debounce must be 0-${ZIFRIEND_DEBOUNCE_MAX_MS} ms.`);
  }
  const packet = settingsPacket(ZIFRIEND_COMMAND.debounce);
  packet[1] = debounceMs;
  return packet;
}

/** Receiver 0x03: the first paired mouse's VID/PID (bytes 2-5), or null when the list is empty. */
export function zifriendDecodePairedMouse(bytes: Uint8Array): { vendorId: number; productId: number } | null {
  if (bytes[0] !== ZIFRIEND_COMMAND.pairedMouse) throw new Error("Unexpected ZIFRIEND receiver answer.");
  const vendorId = u16(bytes, 2);
  const productId = u16(bytes, 4);
  return vendorId || productId ? { vendorId, productId } : null;
}

/** 0x12: lighting firmware version, number of effects, active effect. Read only. */
export function zifriendDecodeLightingInfo(bytes: Uint8Array): ZifriendLightingInfo {
  if (bytes[0] !== ZIFRIEND_COMMAND.lightingInfo) throw new Error("Unexpected ZIFRIEND lighting answer.");
  return { version: bytes[1] ?? 0, modeCount: bytes[2] ?? 0, activeMode: bytes[3] ?? 0 };
}

/** Input report 0x54 type 0xe2 (report ID already removed, as WebHID delivers it). */
export function zifriendDecodeStatusEvent(bytes: Uint8Array): ZifriendStatusEvent | null {
  if (bytes[0] !== ZIFRIEND_EVENT.status || bytes.length < 7) return null;
  return {
    connection: zifriendConnection(bytes[1] ?? 0xff),
    linked: bytes[2] === 1,
    powerState: (bytes[3] ?? 0) & 0x03,
    batteryPercent: percent(bytes[4]),
    activeStage: (bytes[5] ?? 0) & 0x0f,
    pollingGear: bytes[6] ?? 0,
  };
}
