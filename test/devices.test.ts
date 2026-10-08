import { describe, expect, test } from "bun:test";
import {
  androidDeviceType,
  androidName,
  iosDeviceType,
  iosRuntimeVersion,
  normalizeScreen,
  parseAdbDevices,
  parseSimctlDevices,
} from "../src/devices/devices";

const SAMPLE = `List of devices attached
emulator-5556          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
R5CT123ABCD            device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:2
emulator-5558          offline transport_id:3
ZY22XXXXXX             unauthorized usb:1-2 transport_id:4

`;

describe("parseAdbDevices", () => {
  const devices = parseAdbDevices(SAMPLE);

  test("only rows in state `device` are returned", () => {
    expect(devices.map((d) => d.serial)).toEqual(["emulator-5556", "R5CT123ABCD"]);
  });

  test("emulator serials are emulators with the model: token", () => {
    expect(devices[0]).toEqual({ serial: "emulator-5556", model: "sdk_gphone64_arm64", kind: "emulator" });
  });

  test("USB serials are physical", () => {
    expect(devices[1]).toEqual({ serial: "R5CT123ABCD", model: "SM_G973F", kind: "physical" });
  });

  test("header-only output yields no devices", () => {
    expect(parseAdbDevices("List of devices attached\n\n")).toEqual([]);
  });

  test("a device row without a model token falls back to unknown", () => {
    expect(parseAdbDevices("List of devices attached\n0123456789 device\n")[0].model).toBe("unknown");
  });
});

describe("normalizeScreen", () => {
  test("physical size becomes WxH with a multiplication sign", () => {
    expect(normalizeScreen("Physical size: 1440x3120\n")).toBe("1440×3120");
  });

  test("an override wins because it is what apps render at", () => {
    expect(normalizeScreen("Physical size: 1440x3120\nOverride size: 720x1560\n")).toBe("720×1560");
  });

  test("unreadable output is null", () => {
    expect(normalizeScreen("error: closed")).toBeNull();
  });
});

describe("androidDeviceType", () => {
  test.each([
    ["emulator,nosdcard", "phone"],
    ["default", "phone"],
    ["tablet,nosdcard", "tablet"],
    ["watch", "watch"],
    ["tv", "tv"],
    ["emulator,tv", "tv"],
    ["", "unknown"],
  ])("%s → %s", (characteristics, expected) => {
    expect(androidDeviceType(characteristics)).toBe(expected as ReturnType<typeof androidDeviceType>);
  });
});

describe("androidName", () => {
  test("an AVD name loses its underscores", () => {
    expect(androidName({ avdName: "Pixel_7_Pro_API_34_2", model: "sdk_gphone64_arm64", serial: "emulator-5556" })).toBe("Pixel 7 Pro API 34 2");
  });

  test("physical devices prefer the market name, then the model, then the serial", () => {
    expect(androidName({ marketName: "Galaxy S10", model: "SM_G973F", serial: "R5" })).toBe("Galaxy S10");
    expect(androidName({ model: "SM_G973F", serial: "R5" })).toBe("SM G973F");
    expect(androidName({ model: "unknown", serial: "R5" })).toBe("R5");
  });
});

describe("simulators", () => {
  test("runtime keys become OS versions", () => {
    expect(iosRuntimeVersion("com.apple.CoreSimulator.SimRuntime.iOS-26-1")).toBe("iOS 26.1");
    expect(iosRuntimeVersion("com.apple.CoreSimulator.SimRuntime.watchOS-11-0")).toBe("watchOS 11.0");
    expect(iosRuntimeVersion("garbage")).toBeNull();
  });

  test("device type comes from the simulator device-type identifier", () => {
    expect(iosDeviceType("com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro")).toBe("phone");
    expect(iosDeviceType("com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4")).toBe("tablet");
    expect(iosDeviceType("com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm")).toBe("watch");
    expect(iosDeviceType("com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K")).toBe("tv");
    expect(iosDeviceType(undefined, "iPhone 15")).toBe("phone");
    expect(iosDeviceType("com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro")).toBe("unknown");
  });

  test("parseSimctlDevices keeps booted state, drops unavailable simulators", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-1": [
          { udid: "A", name: "iPhone 16", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
          { udid: "B", name: "iPhone 15", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15" },
          { udid: "C", name: "Old", state: "Shutdown", isAvailable: false },
        ],
        "com.apple.CoreSimulator.SimRuntime.watchOS-26-1": [
          { udid: "W", name: "Apple Watch", state: "Booted", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm" },
        ],
      },
    });
    expect(parseSimctlDevices(json)).toEqual([
      { udid: "A", name: "iPhone 16", booted: true, osVersion: "iOS 26.1", deviceType: "phone" },
      { udid: "B", name: "iPhone 15", booted: false, osVersion: "iOS 26.1", deviceType: "phone" },
      { udid: "W", name: "Apple Watch", booted: true, osVersion: "watchOS 26.1", deviceType: "watch" },
    ]);
    expect(parseSimctlDevices("not json")).toEqual([]);
  });
});
