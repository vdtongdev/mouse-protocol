import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZIFRIEND_COMMAND,
  zifriendActiveStage,
  zifriendAnswer,
  zifriendConnection,
  zifriendDecodeIdentity,
  zifriendDecodeLightingInfo,
  zifriendDecodePairedMouse,
  zifriendDecodeSettings,
  zifriendDecodeStatusEvent,
  zifriendEncodeDebounce,
  zifriendEncodeDpi,
  zifriendEncodePolling,
  zifriendEncodeSensor,
  zifriendFirmwareLabel,
  zifriendPollingGear,
  zifriendRequest,
} from "./index.ts";

function packet(...bytes: number[]): Uint8Array {
  const out = new Uint8Array(20);
  out.set(bytes);
  return out;
}

test("connection modes follow the vendor driver: 0 USB, 1/3/4 2.4 GHz, 2 Bluetooth", () => {
  assert.equal(zifriendConnection(0), "usb");
  for (const mode of [1, 3, 4]) assert.equal(zifriendConnection(mode), "wireless");
  assert.equal(zifriendConnection(2), "bluetooth");
  assert.equal(zifriendConnection(7), "unknown");
});

test("DPI write puts the stage in the current connection's slot and 0xff in the others", () => {
  // Vendor defaults: 400/800/1600/3200/4800, five stages.
  const usb = zifriendEncodeDpi("usb", 1, [400, 800, 1600, 3200, 4800], 5);
  assert.deepEqual([...usb], [...packet(
    0x40, 1, 0xff, 0xff,
    0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0xc0, 0x12,
    5,
  )]);
  const wireless = zifriendEncodeDpi("wireless", 0, [400, 800, 1600, 3200, 26000], 3);
  assert.deepEqual([...wireless.slice(0, 4)], [0x40, 0xff, 0, 0xff]);
  assert.deepEqual([...wireless.slice(12, 15)], [0x90, 0x65, 3]);
});

test("DPI write rejects bad stage counts, active stages and short stage lists", () => {
  assert.throws(() => zifriendEncodeDpi("usb", 0, [400, 800, 1600, 3200, 4800], 0), RangeError);
  assert.throws(() => zifriendEncodeDpi("usb", 0, [400, 800, 1600, 3200, 4800], 6), RangeError);
  assert.throws(() => zifriendEncodeDpi("usb", 3, [400, 800, 1600, 3200, 4800], 3), RangeError);
  assert.throws(() => zifriendEncodeDpi("usb", 0, [400, 800], 2), RangeError);
  assert.throws(() => zifriendEncodeDpi("usb", 0, [400, 800, 1600, 3200, 70000], 5), RangeError);
});

test("polling write carries the gear, then the 125/500/1000 Hz table as little-endian hertz", () => {
  // The vendor driver stores 0x01f4007d and 0x03e8 into bytes 4-9.
  assert.deepEqual([...zifriendEncodePolling("wireless", 2)], [...packet(
    0x41, 0xff, 2, 0xff, 0x7d, 0x00, 0xf4, 0x01, 0xe8, 0x03,
  )]);
  assert.deepEqual([...zifriendEncodePolling("usb", 0).slice(0, 4)], [0x41, 0, 0xff, 0xff]);
  assert.throws(() => zifriendEncodePolling("usb", 3), RangeError);
});

test("sensor write uses 1 on / 2 off, scroll 1 forward / 2 reversed, and leaves E-sports alone unless asked", () => {
  const base = { lod: 1, rippleControl: true, angleSnapping: false, motionSync: true, scrollReversed: false };
  assert.deepEqual([...zifriendEncodeSensor(base)], [...packet(0x42, 1, 1, 2, 1, 0, 1, 0)]);
  assert.deepEqual([...zifriendEncodeSensor({ ...base, lod: 2, scrollReversed: true, eSports: false })], [...packet(0x42, 2, 1, 2, 1, 0, 2, 2)]);
  assert.equal(zifriendEncodeSensor({ ...base, eSports: true })[7], 1);
  assert.throws(() => zifriendEncodeSensor({ ...base, lod: 3 }), RangeError);
});

test("debounce write is 0-20 ms", () => {
  assert.deepEqual([...zifriendEncodeDebounce(8)], [...packet(0x43, 8)]);
  assert.throws(() => zifriendEncodeDebounce(21), RangeError);
  assert.throws(() => zifriendEncodeDebounce(-1), RangeError);
  assert.throws(() => zifriendEncodeDebounce(1.5), RangeError);
});

test("requests are 20 bytes and validate their bytes", () => {
  assert.deepEqual([...zifriendRequest(ZIFRIEND_COMMAND.radioWake, 0x02)], [...packet(0x0c, 0x02)]);
  assert.throws(() => zifriendRequest(0x100), RangeError);
  assert.throws(() => zifriendRequest(0x06, 0x1ff), RangeError);
});

test("answers are accepted with or without the leading report ID", () => {
  const withId = new Uint8Array(21);
  withId.set([0x51, 0x07, 9]);
  assert.deepEqual([...zifriendAnswer(new DataView(withId.buffer), 0x51, 0x07).slice(0, 2)], [0x07, 9]);
  const without = packet(0x07, 9);
  assert.deepEqual([...zifriendAnswer(without, 0x51, 0x07).slice(0, 2)], [0x07, 9]);
  assert.throws(() => zifriendAnswer(packet(0x06), 0x51, 0x07), /Unexpected/);
});

test("identity answer: IDs, firmware, link bits, battery and power state", () => {
  const identity = zifriendDecodeIdentity(packet(
    0x06, 0x02, 0x00, 0x8a, 0x24, 0x19, 0xff, 0x12, 0x01, 0x03 | 0x08, 73, 0x01,
  ));
  assert.deepEqual(identity, {
    protocolVersion: 2,
    vendorId: 0x248a,
    productId: 0xff19,
    firmware: 0x0112,
    connection: "wireless",
    linked: true,
    batteryPercent: 73,
    powerState: 1,
  });
  assert.equal(zifriendFirmwareLabel(identity.firmware), "v1.1.2");
  assert.equal(zifriendDecodeIdentity(packet(0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff)).batteryPercent, null);
  assert.throws(() => zifriendDecodeIdentity(packet(0x07)), /identity/);
});

test("settings answer: levels, five stages, flags, stage count and debounce", () => {
  // Factory sensor flags 53 (0x35): LOD 1, ripple, motion sync, bit 5.
  const settings = zifriendDecodeSettings(packet(
    0x07, 0, 0x21, 0x12, 0x00,
    0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0xc0, 0x12,
    0x35, 5, 8,
  ));
  assert.deepEqual(settings, {
    profile: 0,
    levels: [0x21, 0x12, 0x00],
    dpiStages: [400, 800, 1600, 3200, 4800],
    stageCount: 5,
    lod: 1,
    rippleControl: true,
    angleSnapping: false,
    motionSync: true,
    eSportsBit: true,
    scrollReversed: false,
    debounceMs: 8,
  });
  assert.equal(zifriendActiveStage(settings, "usb"), 1);
  assert.equal(zifriendPollingGear(settings, "usb"), 2);
  assert.equal(zifriendActiveStage(settings, "wireless"), 2);
  assert.equal(zifriendPollingGear(settings, "wireless"), 1);
  const reversed = zifriendDecodeSettings(packet(0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x4a, 2, 0));
  assert.equal(reversed.scrollReversed, true);
  assert.equal(reversed.angleSnapping, true);
  assert.equal(reversed.lod, 2);
});

test("settings answer is rejected when truncated or the stage count is impossible", () => {
  assert.throws(() => zifriendDecodeSettings(new Uint8Array([0x07, 0, 0])), /Truncated/);
  assert.throws(() => zifriendDecodeSettings(packet(0x07)), /stage count 0/);
  const sixStages = packet(0x07);
  sixStages[16] = 6;
  assert.throws(() => zifriendDecodeSettings(sixStages), /stage count 6/);
});

test("active stage is kept inside the stage count", () => {
  const settings = zifriendDecodeSettings(packet(0x07, 0, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 2, 0));
  assert.equal(zifriendActiveStage(settings, "usb"), 1);
});

test("receiver pairing, lighting info and status events decode", () => {
  assert.deepEqual(zifriendDecodePairedMouse(packet(0x03, 1, 0x8a, 0x24, 0x19, 0xff)), { vendorId: 0x248a, productId: 0xff19 });
  assert.equal(zifriendDecodePairedMouse(packet(0x03)), null);
  assert.deepEqual(zifriendDecodeLightingInfo(packet(0x12, 1, 0, 0)), { version: 1, modeCount: 0, activeMode: 0 });
  assert.deepEqual(zifriendDecodeStatusEvent(packet(0xe2, 3, 1, 2, 100, 1, 2)), {
    connection: "wireless",
    linked: true,
    powerState: 2,
    batteryPercent: 100,
    activeStage: 1,
    pollingGear: 2,
  });
  assert.equal(zifriendDecodeStatusEvent(packet(0xe3)), null);
});
