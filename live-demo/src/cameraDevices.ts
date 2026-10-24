const REMOTE_CAMERA = /iphone|android|phone|mobile|bluetooth|continuity|droidcam|iriun|camo|手机|蓝牙/i;
const BUILT_IN_CAMERA = /integrated|built[ -]?in|internal|facetime|内置/i;

/** Device labels are hints; the selector always lets the user choose explicitly. */
export function preferredComputerCamera(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const cameras = devices.filter((d) => d.kind === "videoinput" && !REMOTE_CAMERA.test(d.label));
  return cameras.find((d) => BUILT_IN_CAMERA.test(d.label)) ?? cameras[0];
}

export async function openCamera(media: MediaDevices, selectedId = "") {
  const before = (await media.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const preferred = preferredComputerCamera(before);
  if (!selectedId && before.length && before.every((d) => d.label) && !preferred) {
    throw new Error("Only phone or wireless cameras were found. Connect your computer webcam, then choose it in Camera source.");
  }
  const acquire = (id?: string) => media.getUserMedia({
    video: {
      width: { ideal: 1280 }, height: { ideal: 720 },
      ...(id ? { deviceId: { exact: id } } : { facingMode: "user" }),
    },
    audio: false,
  });
  let stream = await acquire(selectedId || preferred?.deviceId);
  try {
    const devices = (await media.enumerateDevices()).filter((d) => d.kind === "videoinput");
    // Labels may only become available after permission. Re-check the browser's default.
    if (!selectedId) {
      const computer = preferredComputerCamera(devices);
      if (!computer && devices.length && devices.every((d) => d.label)) {
        throw new Error("Only phone or wireless cameras were found. Choose a computer webcam in Camera source.");
      }
      if (computer?.deviceId && computer.deviceId !== stream.getVideoTracks()[0]?.getSettings().deviceId) {
        stream.getTracks().forEach((track) => track.stop());
        stream = await acquire(computer.deviceId);
      }
    }
    return { stream, devices };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}
