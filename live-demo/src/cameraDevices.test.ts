import { describe, expect, it, vi } from "vitest";
import { openCamera, preferredComputerCamera } from "./cameraDevices";

const device = (deviceId: string, label: string) => ({ deviceId, label, kind: "videoinput" }) as MediaDeviceInfo;
function stream(id: string) {
  const track = { label: id, getSettings: () => ({ deviceId: id }), stop: vi.fn() };
  return { value: { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream, stop: track.stop };
}

describe("camera source selection", () => {
  it("chooses the integrated webcam over a phone and USB device", () => {
    expect(preferredComputerCamera([device("phone", "iPhone camera"), device("usb", "USB camera"), device("pc", "Integrated Camera")])?.deviceId).toBe("pc");
  });

  it("requests the computer's exact device and never opens the listed phone", async () => {
    const pc = stream("pc");
    const getUserMedia = vi.fn().mockResolvedValue(pc.value);
    await openCamera({ enumerateDevices: async () => [device("phone", "Android camera"), device("pc", "USB camera")], getUserMedia } as unknown as MediaDevices);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, deviceId: { exact: "pc" } }, audio: false });
  });

  it("stops a hidden-label default phone before switching to the computer", async () => {
    const phone = stream("phone"), pc = stream("pc");
    const enumerateDevices = vi.fn().mockResolvedValueOnce([device("", "")])
      .mockResolvedValue([device("phone", "Bluetooth camera"), device("pc", "Integrated Camera")]);
    const getUserMedia = vi.fn().mockResolvedValueOnce(phone.value).mockImplementationOnce(() => {
      expect(phone.stop).toHaveBeenCalledOnce();
      return Promise.resolve(pc.value);
    });
    const opened = await openCamera({ enumerateDevices, getUserMedia } as unknown as MediaDevices);
    expect(opened.stream).toBe(pc.value);
    expect(pc.stop).not.toHaveBeenCalled();
  });

  it("respects an explicitly selected device", async () => {
    const usb = stream("usb");
    const getUserMedia = vi.fn().mockResolvedValue(usb.value);
    await openCamera({ enumerateDevices: async () => [device("pc", "Integrated Camera"), device("usb", "External camera")], getUserMedia } as unknown as MediaDevices, "usb");
    expect(getUserMedia.mock.calls[0][0].video.deviceId).toEqual({ exact: "usb" });
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("does not silently fall back to a phone when no computer camera exists", async () => {
    const getUserMedia = vi.fn();
    await expect(openCamera({ enumerateDevices: async () => [device("phone", "iPhone")], getUserMedia } as unknown as MediaDevices)).rejects.toThrow("Only phone");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops the opened stream when listing permitted devices fails", async () => {
    const pc = stream("pc");
    const enumerateDevices = vi.fn().mockResolvedValueOnce([device("pc", "Integrated Camera")]).mockRejectedValueOnce(new Error("Disconnected"));
    await expect(openCamera({ enumerateDevices, getUserMedia: async () => pc.value } as unknown as MediaDevices)).rejects.toThrow("Disconnected");
    expect(pc.stop).toHaveBeenCalledOnce();
  });
});
