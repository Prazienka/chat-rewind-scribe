/**
 * Rozšiřovací bod pro nativní nahrávání na pozadí.
 *
 * Projekt je dnes čistá webová (PWA) aplikace – žádný Capacitor ani nativní obal
 * v repozitáři není, takže tady ŽÁDNÉ nativní nahrávání na pozadí neexistuje.
 * Aby se webová vrstva nemusela později přepisovat, prochází dotaz na nativní
 * rekordér tímto rozhraním. Jakmile přidáme Capacitor plugin (Android Foreground
 * Service s typem `microphone`, iOS `UIBackgroundModes: audio` + AVAudioSession),
 * stačí zaregistrovat implementaci přes `registerNativeRecorder`.
 */

export type NativeRecorderStatus = {
  /** Drží záznam nativní služba, která přežije pozadí i zamknutý displej? */
  backgroundCapture: boolean;
  platform: "web" | "android" | "ios";
};

export type NativeRecorder = {
  status: () => Promise<NativeRecorderStatus>;
  start: (options: { sessionId: string; sampleRate: number }) => Promise<void>;
  stop: () => Promise<void>;
};

let registered: NativeRecorder | null = null;

export function registerNativeRecorder(recorder: NativeRecorder): void {
  registered = recorder;
}

/** Vrátí nativní rekordér, pokud nějaký obal aplikace skutečně existuje. */
export function getNativeRecorder(): NativeRecorder | null {
  if (registered) return registered;
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (capacitor?.isNativePlatform?.()) {
    // Nativní obal je přítomný, ale plugin pro záznam zatím registrovaný není.
    return null;
  }
  return null;
}

/**
 * Věta pro UI o tom, co platforma při zamknutém displeji skutečně umí.
 * Nic negarantuje – webový prohlížeč to garantovat neumí.
 */
export function backgroundCapabilityNote(userAgent: string): string {
  const ios = /iPad|iPhone|iPod/.test(userAgent) || /Macintosh/.test(userAgent) === false && /Safari/.test(userAgent) && /Version\//.test(userAgent);
  if (ios) {
    return "Na iPhonu a iPadu může Safari při zamknutí displeje mikrofon uspat. Nahrávka se neztratí – uložené části zůstanou a po návratu se snímání samo obnoví.";
  }
  return "Nahrávání pokračuje na pozadí, pokud to zařízení a prohlížeč dovolí. Uložené části se neztratí a po návratu se stav obnoví.";
}
