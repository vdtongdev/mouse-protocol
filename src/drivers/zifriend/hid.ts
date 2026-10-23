import type { MouseStatus } from "../mouse-types.ts";
import {
  ZIFRIEND_COMMAND as CMD,
  ZIFRIEND_DEBOUNCE_MAX_MS as DEBOUNCE_MAX_MS,
  ZIFRIEND_DPI_MAX as DPI_MAX,
  ZIFRIEND_DPI_MIN as DPI_MIN,
  ZIFRIEND_DPI_STAGE_COUNT as DPI_STAGE_COUNT,
  ZIFRIEND_DPI_STEP as DPI_STEP,
  ZIFRIEND_LIFT_OFF as LIFT_OFF,
  ZIFRIEND_M6_PRODUCT_ID,
  ZIFRIEND_M6_RECEIVER_PRODUCT_ID,
  ZIFRIEND_POLLING_RATES as POLLING_RATES,
  ZIFRIEND_PRODUCT_IDS,
  ZIFRIEND_SETTINGS_LENGTH as REPORT_LENGTH,
  ZIFRIEND_SETTINGS_REPORT_ID as REPORT_ID,
  ZIFRIEND_USAGE as USAGE,
  ZIFRIEND_USAGE_PAGE as USAGE_PAGE,
  ZIFRIEND_VENDOR_ID,
  zifriendActiveStage,
  zifriendAnswer,
  zifriendDecodeIdentity,
  zifriendDecodeLightingInfo,
  zifriendDecodePairedMouse,
  zifriendDecodeSettings,
  zifriendEncodeDebounce,
  zifriendEncodeDpi,
  zifriendEncodePolling,
  zifriendEncodeSensor,
  zifriendFirmwareLabel,
  zifriendPollingGear,
  zifriendRequest,
  type ZifriendIdentity,
  type ZifriendLightingInfo,
  type ZifriendSensorWrite,
  type ZifriendSettings,
} from "@openmouse/protocol/zifriend";

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;

const PRODUCT_IDS = new Set<number>(ZIFRIEND_PRODUCT_IDS);
/** The vendor driver gives the receiver this long to relay a command to the mouse. */
const RECEIVER_ANSWER_DELAY_MS = 200;
const ANSWER_ATTEMPTS = 5;
const ANSWER_RETRY_MS = 50;
/** A relayed write can land after the first read-back, so confirmation is retried. */
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_RETRY_MS = 200;
/** After a cable to 2.4 GHz switch the receiver can fail every read until it is replugged (measured). */
const REPLUG_HINT = "The receiver did not answer its settings read. Unplug and replug the receiver, then try again.";

/**
 * ZIFRIEND M6 over its cable or its 2.4 GHz receiver. See
 * `@openmouse/protocol/zifriend` for the wire format and where it came from.
 *
 * Every write resends the whole group the vendor driver sends (all five DPI
 * stages, every sensor option), built from a fresh 0x07 read so nothing the
 * user did not touch is changed, then reads 0x07 again until the value sticks.
 * Battery comes from a fresh 0x06 read on every poll: the vendor driver drops
 * a battery report whenever the link state changed since the previous one and
 * animates the gauge while charging, which is why it so often shows the
 * wrong level.
 */
export class ZifriendHidClient {
  readonly device: HIDDevice;
  /** Feature writes and reads come in pairs, so they run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  private identity: ZifriendIdentity | null = null;
  /** Last E-sports value written this session. The mouse cannot be asked, and neither can the vendor app. */
  private eSportsWritten: boolean | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === ZIFRIEND_VENDOR_ID
      && PRODUCT_IDS.has(device.productId)
      && hasControlCollection(device.collections);
  }

  /** Battery and link state change on their own, so the app re-reads every ten seconds. */
  get pollIntervalMs(): number {
    return 10_000;
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    return Array.from({ length: (DPI_MAX - DPI_MIN) / DPI_STEP + 1 }, (_, index) => DPI_MIN + index * DPI_STEP);
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  getSupportedPollingRates(): number[] {
    return [...POLLING_RATES];
  }

  async readStatus(): Promise<MouseStatus> {
    const identity = await this.readIdentity();
    if (identity.connection === "bluetooth") {
      return this.limitedStatus(identity, "The vendor software does not change settings over Bluetooth either. Use the cable or the 2.4 GHz receiver.");
    }
    if (identity.connection === "wireless" && !identity.linked) {
      return this.limitedStatus(identity, "The receiver cannot hear the mouse. Move it or click a button to wake it.");
    }
    let settings: ZifriendSettings;
    try {
      settings = await this.readSettings(identity);
    } catch {
      return this.limitedStatus(identity, identity.connection === "wireless" ? REPLUG_HINT : "The mouse did not answer its settings read. Reconnect it and try again.");
    }
    const activeStage = zifriendActiveStage(settings, identity.connection);
    const gear = zifriendPollingGear(settings, identity.connection);
    const name = this.label(identity);
    const wireless = identity.connection === "wireless";

    return {
      brand: "Zifriend",
      name,
      ui: {
        family: "zifriend",
        defaultDisplayName: name,
        showAdvancedSection: true,
        hideUnsupportedPollingRates: true,
        hideSignalCard: true,
        hideSleepCard: true,
        forceShowBattery: true,
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          // The receiver does not relay the count, so it cannot be shown or changed there.
          countEditable: settings.stageCount !== null,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      ...this.battery(identity),
      dpi: settings.dpiStages[activeStage] ?? settings.dpiStages[0] ?? 800,
      dpiStages: settings.dpiStages.slice(0, settings.stageCount ?? DPI_STAGE_COUNT),
      activeDpiStage: activeStage,
      pollingRateHz: POLLING_RATES[gear] ?? 1000,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: wireless ? "2.4 GHz receiver" : "USB",
      liftOffDistance: settings.lod === LIFT_OFF.High ? "High" : "Low",
      supportedLiftOffDistances: ["Low", "High"],
      motionSync: settings.motionSync,
      angleSnapping: settings.angleSnapping,
      rippleControl: settings.rippleControl,
      // E-sports is not readable and the tested unit shipped with it off; writes are absolute, so showing off is safe.
      performanceMode: this.eSportsWritten ?? false,
      scrollDirection: settings.scrollReversed ? "Reverse" : "Forward",
      debounceMs: settings.debounceMs,
      firmware: [zifriendFirmwareLabel(identity.firmware)],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const identity = await this.readIdentity();
    const settings = await this.readSettings(identity);
    return await this.setDpiStageValue(zifriendActiveStage(settings, identity.connection), dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    requireDpi(dpi);
    const identity = await this.readWritableIdentity();
    const settings = await this.readSettings(identity);
    requireStage(stage, settings.stageCount ?? DPI_STAGE_COUNT);
    const stages = settings.dpiStages.map((value, index) => (index === stage ? dpi : value));
    await this.write(zifriendEncodeDpi(identity.connection, zifriendActiveStage(settings, identity.connection), stages, settings.stageCount));
    const confirmed = await this.confirm(identity, (next) => next.dpiStages[stage] === dpi);
    if (confirmed.dpiStages[stage] !== dpi) {
      throw new Error(`The mouse kept ${confirmed.dpiStages[stage]} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    }
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const identity = await this.readWritableIdentity();
    const settings = await this.readSettings(identity);
    requireStage(stage, settings.stageCount ?? DPI_STAGE_COUNT);
    await this.write(zifriendEncodeDpi(identity.connection, stage, settings.dpiStages, settings.stageCount));
    const confirmed = zifriendActiveStage(
      await this.confirm(identity, (next) => zifriendActiveStage(next, identity.connection) === stage),
      identity.connection,
    );
    if (confirmed !== stage) throw new Error(`The mouse stayed on DPI stage ${confirmed + 1}.`);
    return stage;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > DPI_STAGE_COUNT) {
      throw new RangeError(`The mouse holds between 1 and ${DPI_STAGE_COUNT} DPI stages.`);
    }
    const identity = await this.readWritableIdentity();
    const settings = await this.readSettings(identity);
    if (settings.stageCount === null) {
      throw new Error("The 2.4 GHz receiver does not report the DPI stage count, so a change cannot be confirmed. Connect the mouse with the cable to change it.");
    }
    const active = Math.min(zifriendActiveStage(settings, identity.connection), count - 1);
    await this.write(zifriendEncodeDpi(identity.connection, active, settings.dpiStages, count));
    const confirmed = (await this.confirm(identity, (next) => next.stageCount === count)).stageCount;
    if (confirmed !== count) throw new Error(`The mouse kept ${confirmed} DPI stages instead of ${count}.`);
    return count;
  }

  async setPollingRate(rateHz: number): Promise<number> {
    const gear = POLLING_RATES.findIndex((rate) => rate === rateHz);
    if (gear < 0) throw new RangeError(`The mouse does not support ${rateHz} Hz.`);
    const identity = await this.readWritableIdentity();
    await this.write(zifriendEncodePolling(identity.connection, gear));
    const confirmed = zifriendPollingGear(
      await this.confirm(identity, (next) => zifriendPollingGear(next, identity.connection) === gear),
      identity.connection,
    );
    if (confirmed !== gear) throw new Error(`The mouse kept ${POLLING_RATES[confirmed] ?? "its previous"} Hz instead of ${rateHz} Hz.`);
    return rateHz;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    if (lod !== "Low" && lod !== "High") throw new RangeError("The mouse offers Low (1 mm) or High (2 mm) lift-off.");
    const code = LIFT_OFF[lod];
    const confirmed = await this.writeSensor({ lod: code }, (next) => next.lod === code);
    if (confirmed.lod !== code) throw new Error(`The mouse kept lift-off code ${confirmed.lod}.`);
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return (await this.writeSensor({ motionSync: enabled }, (next) => next.motionSync === enabled)).motionSync;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return (await this.writeSensor({ angleSnapping: enabled }, (next) => next.angleSnapping === enabled)).angleSnapping;
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return (await this.writeSensor({ rippleControl: enabled }, (next) => next.rippleControl === enabled)).rippleControl;
  }

  async setScrollDirection(direction: "Forward" | "Reverse"): Promise<"Forward" | "Reverse"> {
    const reversed = direction === "Reverse";
    const confirmed = await this.writeSensor({ scrollReversed: reversed }, (next) => next.scrollReversed === reversed);
    return confirmed.scrollReversed ? "Reverse" : "Forward";
  }

  /**
   * The vendor's "E-sports mode". Off is the firmware's power-saving
   * behaviour. Measured: no byte of the settings read follows it, and the
   * vendor app never reads it back either, so a write cannot be confirmed and
   * is reported as applied once sent.
   */
  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    const identity = await this.readWritableIdentity();
    const settings = await this.readSettings(identity);
    await this.write(zifriendEncodeSensor({ ...sensorOf(settings), eSports: enabled }));
    this.eSportsWritten = enabled;
    return enabled;
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    const packet = zifriendEncodeDebounce(debounceMs);
    const identity = await this.readWritableIdentity();
    await this.write(packet);
    const confirmed = (await this.confirm(identity, (next) => next.debounceMs === debounceMs)).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The mouse kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return debounceMs;
  }

  /**
   * Read-only lighting probe (0x12). The vendor driver ships lighting code but
   * hides the tab for the M6; a mode count of zero confirms there is nothing
   * to drive. Not used by the status read.
   */
  async readLightingInfo(): Promise<ZifriendLightingInfo> {
    const identity = await this.readWritableIdentity();
    return zifriendDecodeLightingInfo(await this.request(identity, zifriendRequest(CMD.lightingInfo), CMD.lightingInfo));
  }

  private battery(identity: ZifriendIdentity): Pick<MouseStatus, "batteryPercent" | "batteryState"> {
    return {
      batteryPercent: identity.batteryPercent,
      batteryState: identity.powerState === 1 ? "Charging" : identity.powerState === 2 ? "Full" : identity.batteryPercent === null ? "Unknown" : "Discharging",
    };
  }

  private label(identity: ZifriendIdentity): string {
    return identity.productId === ZIFRIEND_M6_PRODUCT_ID || this.device.productId === ZIFRIEND_M6_PRODUCT_ID
      ? "Zifriend M6"
      : this.device.productName || "Zifriend mouse";
  }

  private limitedStatus(identity: ZifriendIdentity, note: string): MouseStatus {
    const name = this.label(identity);
    const wireless = identity.connection !== "usb";
    const linked = identity.connection === "usb" || identity.linked;
    return {
      brand: "Zifriend",
      name,
      ui: { family: "zifriend", defaultDisplayName: name, settingsReady: false, statusNote: note },
      ...(linked ? this.battery(identity) : { batteryPercent: null, batteryState: "Unknown" as const }),
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: wireless ? "Wireless" : "Wired",
      connectionDetail: identity.connection === "bluetooth" ? "Bluetooth" : wireless ? "2.4 GHz receiver" : "USB",
      liftOffDistance: null,
      firmware: [zifriendFirmwareLabel(identity.firmware)],
    };
  }

  private async writeSensor(change: Partial<ZifriendSensorWrite>, done: (next: ZifriendSettings) => boolean): Promise<ZifriendSettings> {
    const identity = await this.readWritableIdentity();
    const settings = await this.readSettings(identity);
    // E-sports is left out (sent as 0) so a sensor write never flips it.
    await this.write(zifriendEncodeSensor({ ...sensorOf(settings), ...change, eSports: undefined }));
    const confirmed = await this.confirm(identity, done);
    if (!done(confirmed)) throw new Error("The mouse did not keep the sensor change.");
    return confirmed;
  }

  /** Re-reads 0x07 until `done` holds or the attempts run out, and returns the last read. */
  private async confirm(identity: ZifriendIdentity, done: (next: ZifriendSettings) => boolean): Promise<ZifriendSettings> {
    let last = await this.readSettings(identity);
    for (let attempt = 1; attempt < CONFIRM_ATTEMPTS && !done(last); attempt += 1) {
      await delay(CONFIRM_RETRY_MS);
      last = await this.readSettings(identity);
    }
    return last;
  }

  /** Fresh on every call: the battery and link state live in this answer. */
  private async readIdentity(): Promise<ZifriendIdentity> {
    const fallback = this.identity ?? undefined;
    const identity = zifriendDecodeIdentity(await this.request(fallback, zifriendRequest(CMD.identity), CMD.identity));
    this.identity = identity;
    return identity;
  }

  private async readWritableIdentity(): Promise<ZifriendIdentity> {
    const identity = await this.readIdentity();
    if (identity.connection === "bluetooth" || identity.connection === "unknown") {
      throw new Error("Change the mouse settings over the cable or the 2.4 GHz receiver.");
    }
    if (identity.connection === "wireless" && !identity.linked) throw new Error("The receiver cannot hear the mouse. Wake it and try again.");
    return identity;
  }

  /** 0x07, with the vendor's 2.4 GHz wake (0x0c 0x02) and one retry if the receiver gave no answer. */
  private async readSettings(identity: ZifriendIdentity): Promise<ZifriendSettings> {
    try {
      return zifriendDecodeSettings(await this.request(identity, zifriendRequest(CMD.settings), CMD.settings));
    } catch (error) {
      if (identity.connection !== "wireless") throw error;
      await this.request(identity, zifriendRequest(CMD.radioWake, 0x02), CMD.radioWake).catch(() => undefined);
      try {
        return zifriendDecodeSettings(await this.request(identity, zifriendRequest(CMD.settings), CMD.settings));
      } catch {
        throw new Error(REPLUG_HINT);
      }
    }
  }

  /** Receiver 0x03: which mouse is paired. Exposed for diagnostics. */
  async readPairedMouse(): Promise<{ vendorId: number; productId: number } | null> {
    if (this.device.productId !== ZIFRIEND_M6_RECEIVER_PRODUCT_ID) return null;
    return zifriendDecodePairedMouse(await this.request(this.identity ?? undefined, zifriendRequest(CMD.pairedMouse), CMD.pairedMouse));
  }

  /** A write's answer carries nothing to check, so it is only drained; the re-read confirms. */
  private async write(packet: Uint8Array): Promise<void> {
    const command = packet[0] ?? 0;
    await this.request(this.identity ?? undefined, packet, command).catch(() => undefined);
  }

  /**
   * Sends one 20-byte feature report and reads the same report back until it
   * answers the command. Behind the receiver the first read waits, as the
   * vendor driver does, so the mouse has time to answer over the air.
   */
  private async request(identity: ZifriendIdentity | undefined, packet: Uint8Array, command: number): Promise<Uint8Array> {
    if (packet.length !== REPORT_LENGTH) throw new RangeError("ZIFRIEND settings reports are 20 bytes.");
    const viaReceiver = identity ? identity.connection === "wireless" : this.device.productId === ZIFRIEND_M6_RECEIVER_PRODUCT_ID;
    const run = this.queue.then(async () => {
      await this.open();
      await this.device.sendFeatureReport(REPORT_ID, packet.slice());
      let lastError: unknown = null;
      for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt += 1) {
        if (attempt > 0 || viaReceiver) await delay(attempt > 0 ? ANSWER_RETRY_MS : RECEIVER_ANSWER_DELAY_MS);
        try {
          return zifriendAnswer(await this.device.receiveFeatureReport(REPORT_ID), REPORT_ID, command).slice();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`The mouse did not answer command 0x${command.toString(16)}.`);
    });
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

function hasControlCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === USAGE_PAGE
      && collection.usage === USAGE
      && (collection.featureReports ?? []).some((report) => report.reportId === REPORT_ID))
    || hasControlCollection(collection.children ?? []));
}

function sensorOf(settings: ZifriendSettings): ZifriendSensorWrite {
  return {
    lod: settings.lod === LIFT_OFF.High ? LIFT_OFF.High : LIFT_OFF.Low,
    rippleControl: settings.rippleControl,
    angleSnapping: settings.angleSnapping,
    motionSync: settings.motionSync,
    scrollReversed: settings.scrollReversed,
  };
}

function requireDpi(dpi: number): void {
  if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
    throw new RangeError(`DPI must be a multiple of ${DPI_STEP} between ${DPI_MIN} and ${DPI_MAX}.`);
  }
}

function requireStage(stage: number, stageCount: number): void {
  if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
    throw new RangeError(`DPI stage must be between 1 and ${stageCount}.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
