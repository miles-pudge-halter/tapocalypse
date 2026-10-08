import { describe, expect, test } from "bun:test";
import { parseAdbDevices } from "../src/devices/devices";

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
