/**
 * Čistá logika odolnosti nahrávání (bez Web API, testovatelná).
 */

export type PlatformKind = "ios-safari" | "ios-pwa" | "android" | "android-pwa" | "desktop";

export type PlatformInfo = {
  kind: PlatformKind;
  installed: boolean;
  /** Pravdivá věta o tom, co platforma při zamknutí umí. */
  note: string;
  /** Doporučení instalace na plochu, pokud dává smysl. */
  installHint: string | null;
};

export function detectPlatform(userAgent: string, standalone: boolean): PlatformInfo {
  const ios = /iPad|iPhone|iPod/.test(userAgent);
  const android = /Android/i.test(userAgent);
  if (ios) {
    return {
      kind: standalone ? "ios-pwa" : "ios-safari",
      installed: standalone,
      note:
        "iPhone může při zamknutí displeje mikrofon webové aplikace uspat. Nahrávka se ukládá každých pár sekund a po odemčení se snímání samo obnoví.",
      installHint: standalone
        ? null
        : "Tip: přidejte si aplikaci na plochu (Sdílet → Přidat na plochu) a nechte displej rozsvícený.",
    };
  }
  if (android) {
    return {
      kind: standalone ? "android-pwa" : "android",
      installed: standalone,
      note:
        "Android obvykle nahrává dál i se zhasnutým displejem, pokud systém prohlížeč neuspí kvůli úspoře baterie.",
      installHint: standalone
        ? null
        : "Tip: nainstalujte si aplikaci (menu ⋮ → Instalovat aplikaci) a vypněte pro prohlížeč optimalizaci baterie.",
    };
  }
  return {
    kind: "desktop",
    installed: standalone,
    note: "Nahrávání pokračuje i v jiné záložce, dokud počítač neusne.",
    installHint: null,
  };
}

export type Gap = { at: number; seconds: number };

/** Zaznamená mezeru v nahrávce, pokud byla delší než sekunda. */
export function addGap(gaps: Gap[], lastDataAt: number | null, now: number, offset: number): Gap[] {
  if (lastDataAt === null) return gaps;
  const seconds = Math.round((now - lastDataAt) / 1000);
  if (seconds < 2) return gaps;
  return [...gaps, { at: Math.round(offset), seconds }];
}

export const totalGapSeconds = (gaps: Gap[] | undefined) =>
  (gaps ?? []).reduce((sum, g) => sum + g.seconds, 0);

/** Má se snímání automaticky obnovit? Stop od uživatele má vždy přednost. */
export function shouldAutoResume(input: {
  active: boolean;
  stopRequested: boolean;
  visible: boolean;
  trackLive: boolean;
  contextRunning: boolean;
  dataStale: boolean;
}): boolean {
  if (!input.active || input.stopRequested || !input.visible) return false;
  return !input.trackLive || !input.contextRunning || input.dataStale;
}
