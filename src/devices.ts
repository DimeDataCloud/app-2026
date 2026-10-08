export type InputPreset = 'code-usb' | 'code-phones' | 'phone-mic';

export const PRESETS: Record<InputPreset, { label: string; gain: number; hint: string }> = {
  'code-usb': {
    label: 'CODE USB (OTG cable)',
    gain: 1,
    hint: 'Pick the "USB Audio" input. If it does not appear, your phone does not support the CODE as a USB input: use the phones-out option.',
  },
  'code-phones': {
    label: 'CODE phones out → mic input',
    gain: 0.5,
    hint: 'Start with the amp volume LOW. Phone mic inputs clip easily; watch the clip light.',
  },
  'phone-mic': {
    label: 'Phone mic near the amp',
    gain: 1.5,
    hint: 'Point the mic at the speaker. Use headphones for the remote sound to avoid feedback.',
  },
};

const BT_RE = /bluetooth|airpods|buds|\bbt\b|headset|hands-?free|\bhfp\b|a2dp/i;
const USB_RE = /usb|marshall|\bcode\b/i;

export function isBluetoothLabel(label: string): boolean {
  // USB-C headset adapters are wired.
  if (/usb/i.test(label)) return false;
  return BT_RE.test(label);
}

export function isUsbAudioLabel(label: string): boolean {
  return USB_RE.test(label);
}

/** Bluetooth adds 150–300 ms; warn when the device or the measured latency says so. */
export function bluetoothWarning(labels: string[], outputLatencyMs: number): boolean {
  return labels.some(isBluetoothLabel) || outputLatencyMs > 100;
}

export async function listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export function suggestPreset(inputs: MediaDeviceInfo[]): { preset: InputPreset; deviceId?: string } {
  const usb = inputs.find((d) => isUsbAudioLabel(d.label));
  if (usb) return { preset: 'code-usb', deviceId: usb.deviceId };
  return { preset: 'phone-mic' };
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
