import assert from "node:assert/strict";
import { test } from "node:test";
import { ZifriendHidClient } from "./hid.ts";
import { createSupportedClient, DEVICE_DRIVERS } from "../registry.ts";
import { SUPPORTED_HID_FILTERS } from "../vendors.ts";

/**
 * Plays the M6 firmware as the vendor driver sees it: every command is a
 * 20-byte feature report 0x51, and its answer is fetched with a feature read
 * of the same report. `keepsReportId` toggles whether the answer starts with
 * the report ID, as it does on some platforms and not on others.
 */
class FakeZifriendM6 {
  vendorId = 0x248a;
  productId = 0xff19;
  productName = "M6";
  opened = false;
  keepsReportId = true;
  /** 0 USB, 3 2.4 GHz (vendor's "2.4G TYPE-A"), 2 Bluetooth. */
  mode = 0;
  linked = true;
  battery = 64;
  power = 0;
  levels = [0x21, 0x21, 0x21];
  dpiStages = [400, 800, 1600, 3200, 4800];
  stageCount = 5;
  flags = 0x35;
  debounce = 8;
  /** Last E-sports byte the mouse received; 0 never arrives from a sensor write. */
  eSports = 1;
  /** Writes land this many settings reads late, like a relay through the receiver. */
  lag = 0;
  private pending: Array<() => void> = [];
  readonly sent: Uint8Array[] = [];
  private answer = new Uint8Array(20);
  readonly collections = [{
    usagePage: 0x8c,
    usage: 0x01,
    featureReports: [{ reportId: 0x51 }, { reportId: 0x52 }],
    inputReports: [{ reportId: 0x54 }],
    outputReports: [],
    children: [],
  }] as unknown as HIDCollectionInfo[];

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    assert.equal(reportId, 0x51);
    const packet = new Uint8Array(data as ArrayBuffer);
    assert.equal(packet.length, 20);
    this.sent.push(packet);
    this.answer = this.handle(packet);
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    if (!this.keepsReportId) return new DataView(this.answer.slice().buffer);
    const bytes = new Uint8Array(21);
    bytes[0] = reportId;
    bytes.set(this.answer, 1);
    return new DataView(bytes.buffer);
  }

  sentCommands(): number[] {
    return this.sent.map((packet) => packet[0]!);
  }

  private apply(change: () => void): void {
    if (this.lag === 0) change();
    else this.pending.push(change);
  }

  private handle(packet: Uint8Array): Uint8Array {
    const answer = new Uint8Array(20);
    answer[0] = packet[0]!;
    switch (packet[0]) {
      case 0x06:
        answer.set([0x06, 2, 0, 0x8a, 0x24, 0x19, 0xff, 0x12, 0x01, this.mode | (this.linked ? 0x08 : 0), this.battery, this.power]);
        break;
      case 0x07: {
        if (this.pending.length) {
          if (this.lag > 0) this.lag -= 1;
          else this.pending.splice(0).forEach((change) => change());
        }
        answer.set(this.levels, 2);
        this.dpiStages.forEach((dpi, index) => answer.set([dpi & 0xff, dpi >> 8], 5 + index * 2));
        answer[15] = this.flags;
        answer[16] = this.stageCount;
        answer[17] = this.debounce;
        break;
      }
      case 0x40: {
        const stages = [1, 2, 3].map((offset) => packet[offset]!);
        const dpi = this.dpiStages.map((_, index) => packet[4 + index * 2]! | (packet[5 + index * 2]! << 8));
        const count = packet[14]!;
        this.apply(() => {
          this.levels = this.levels.map((level, slot) => (stages[slot] === 0xff ? level : (level & 0xf0) | stages[slot]!));
          this.dpiStages = dpi;
          this.stageCount = count;
        });
        break;
      }
      case 0x41: {
        const gears = [1, 2, 3].map((offset) => packet[offset]!);
        assert.deepEqual([...packet.slice(4, 10)], [0x7d, 0x00, 0xf4, 0x01, 0xe8, 0x03]);
        this.apply(() => {
          this.levels = this.levels.map((level, slot) => (gears[slot] === 0xff ? level : (level & 0x0f) | (gears[slot]! << 4)));
        });
        break;
      }
      case 0x42: {
        const [lod, ripple, angle, motion, , scroll, eSports] = [...packet.slice(1, 8)];
        this.apply(() => {
          let flags = this.flags & ~0x5f;
          flags |= lod! & 0x03;
          if (ripple === 1) flags |= 0x04;
          if (angle === 1) flags |= 0x08;
          if (motion === 1) flags |= 0x10;
          if (scroll === 2) flags |= 0x40;
          if (eSports) this.eSports = eSports;
          this.flags = flags;
        });
        break;
      }
      case 0x43:
        this.apply(() => { this.debounce = packet[1]!; });
        break;
      case 0x12:
        answer.set([0x12, 1, 0, 0]);
        break;
      default:
    }
    return answer;
  }
}

function connect(fake = new FakeZifriendM6()): { fake: FakeZifriendM6; client: ZifriendHidClient } {
  return { fake, client: new ZifriendHidClient(fake as unknown as HIDDevice) };
}

test("claims only the M6 product ids on the 0x8c collection", () => {
  const fake = new FakeZifriendM6();
  assert.equal(ZifriendHidClient.isSupported(fake as unknown as HIDDevice), true);
  fake.productId = 0xff32;
  assert.equal(ZifriendHidClient.isSupported(fake as unknown as HIDDevice), true);
  fake.productId = 0xff12;
  assert.equal(ZifriendHidClient.isSupported(fake as unknown as HIDDevice), false);
  const keychron = new FakeZifriendM6();
  keychron.vendorId = 0x3434;
  assert.equal(ZifriendHidClient.isSupported(keychron as unknown as HIDDevice), false);
  const noControl = new FakeZifriendM6();
  (noControl as unknown as { collections: unknown[] }).collections = [{ usagePage: 0x01, usage: 0x02, featureReports: [], children: [] }];
  assert.equal(ZifriendHidClient.isSupported(noControl as unknown as HIDDevice), false);
});

test("registry and picker filters route the M6 to this driver alone", () => {
  const fake = new FakeZifriendM6();
  const claims = DEVICE_DRIVERS.filter((driver) => driver.supports(fake as unknown as HIDDevice)).map((driver) => driver.brand);
  assert.deepEqual(claims, ["Zifriend"]);
  assert.ok(createSupportedClient(fake as unknown as HIDDevice) instanceof ZifriendHidClient);
  for (const productId of [0xff19, 0xff32]) {
    assert.ok(SUPPORTED_HID_FILTERS.some((filter) => filter.vendorId === 0x248a && filter.productId === productId && filter.usagePage === 0x8c && filter.usage === 1));
  }
});

test("reads a wired status: stages, polling, sensor options, debounce and battery", async () => {
  const { client } = connect();
  const status = await client.readStatus();
  assert.equal(status.brand, "Zifriend");
  assert.equal(status.name, "Zifriend M6");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200, 4800]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 500, 1000]);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.rippleControl, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.motionSync, true);
  assert.equal(status.performanceMode, true);
  assert.equal(status.scrollDirection, "Forward");
  assert.equal(status.debounceMs, 8);
  assert.equal(status.batteryPercent, 64);
  assert.equal(status.batteryState, "Discharging");
  assert.deepEqual(status.firmware, ["v1.1.2"]);
  assert.equal(status.ui?.family, "zifriend");
  assert.equal(status.ui?.showAdvancedSection, true);
});

test("works whether or not the platform keeps the report ID on answers", async () => {
  const { fake, client } = connect();
  fake.keepsReportId = false;
  assert.equal((await client.readStatus()).dpi, 800);
});

test("battery is read fresh on every poll and charging is a state, not a gauge animation", async () => {
  const { fake, client } = connect();
  assert.equal((await client.readStatus()).batteryPercent, 64);
  fake.mode = 3;
  fake.battery = 61;
  fake.power = 1;
  const charging = await client.readStatus();
  // The vendor driver drops this report because the link state just changed.
  assert.equal(charging.batteryPercent, 61);
  assert.equal(charging.batteryState, "Charging");
  fake.power = 2;
  fake.battery = 100;
  assert.equal((await client.readStatus()).batteryState, "Full");
  fake.battery = 0xff;
  fake.power = 0;
  const unknown = await client.readStatus();
  assert.equal(unknown.batteryPercent, null);
  assert.equal(unknown.batteryState, "Unknown");
});

test("a mouse the receiver cannot hear reports no battery and no settings", async () => {
  const { fake, client } = connect();
  fake.mode = 3;
  fake.linked = false;
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.batteryPercent, null);
  assert.equal(status.connectionType, "Wireless");
  assert.ok(!fake.sentCommands().includes(0x07));
  await assert.rejects(client.setDpi(1600), /cannot hear/);
});

test("Bluetooth is read-only, as in the vendor software", async () => {
  const { fake, client } = connect();
  fake.mode = 2;
  const status = await client.readStatus();
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.connectionDetail, "Bluetooth");
  await assert.rejects(client.setPollingRate(500), /cable or the 2.4 GHz receiver/);
});

test("DPI writes resend all five stages, change one, and target only the current connection's slot", async () => {
  const { fake, client } = connect();
  fake.mode = 3;
  assert.equal(await client.setDpiStageValue(3, 6400), 6400);
  assert.deepEqual(fake.dpiStages, [400, 800, 1600, 6400, 4800]);
  const write = fake.sent.find((packet) => packet[0] === 0x40)!;
  assert.deepEqual([...write.slice(1, 4)], [0xff, 1, 0xff]);
  assert.equal(await client.setDpi(1200), 1200);
  assert.equal(fake.dpiStages[1], 1200);
  await assert.rejects(client.setDpiStageValue(0, 125), RangeError);
  await assert.rejects(client.setDpiStageValue(5, 800), RangeError);
});

test("stage selection and stage count round-trip", async () => {
  const { fake, client } = connect();
  assert.equal(await client.setActiveDpiStage(4), 4);
  assert.equal(fake.levels[0]! & 0x0f, 4);
  assert.equal(await client.setDpiStageCount(3), 3);
  assert.equal(fake.stageCount, 3);
  assert.equal(fake.levels[0]! & 0x0f, 2, "active stage pulled inside the new count");
  await assert.rejects(client.setDpiStageCount(6), RangeError);
});

test("polling rate writes the gear for the current connection and the hertz table", async () => {
  const { fake, client } = connect();
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(fake.levels[0]! >> 4, 1);
  assert.equal(fake.levels[1], 0x21, "2.4 GHz slot left alone");
  await assert.rejects(client.setPollingRate(2000), RangeError);
});

test("sensor writes keep every other option and never touch E-sports", async () => {
  const { fake, client } = connect();
  await client.setLiftOffDistance("High");
  assert.equal(fake.flags & 0x03, 2);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(await client.setRippleControl(false), false);
  assert.equal(await client.setMotionSync(false), false);
  assert.equal(await client.setScrollDirection("Reverse"), "Reverse");
  assert.equal(fake.flags & 0x5f, 0x02 | 0x08 | 0x40);
  assert.equal(fake.eSports, 1);
  for (const packet of fake.sent.filter((sent) => sent[0] === 0x42)) assert.equal(packet[7], 0);
  await assert.rejects(client.setLiftOffDistance("Medium"), RangeError);
});

test("E-sports (performance mode) is written explicitly and reported from the last write", async () => {
  const { fake, client } = connect();
  assert.equal(await client.setPerformanceMode(false), false);
  assert.equal(fake.eSports, 2);
  assert.equal((await client.readStatus()).performanceMode, false);
  assert.equal(await client.setPerformanceMode(true), true);
  assert.equal(fake.eSports, 1);
});

test("debounce round-trips and is bounded to 0-20 ms", async () => {
  const { fake, client } = connect();
  assert.equal(await client.setDebounceTime(4), 4);
  assert.equal(fake.debounce, 4);
  await assert.rejects(client.setDebounceTime(21), RangeError);
  assert.deepEqual(client.getDebounceOptions().at(-1), 20);
});

test("a write relayed late through the receiver is confirmed by re-reading", async () => {
  const { fake, client } = connect();
  fake.mode = 3;
  fake.lag = 2;
  assert.equal(await client.setDebounceTime(12), 12);
  assert.equal(fake.debounce, 12);
});

test("a write the mouse never keeps is reported, not assumed", async () => {
  const { fake, client } = connect();
  fake.lag = 99;
  await assert.rejects(client.setDebounceTime(3), /kept 8 ms/);
});

test("lighting probe is read only", async () => {
  const { fake, client } = connect();
  assert.deepEqual(await client.readLightingInfo(), { version: 1, modeCount: 0, activeMode: 0 });
  assert.deepEqual(fake.sentCommands(), [0x06, 0x12]);
});
