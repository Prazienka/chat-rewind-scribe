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

/** Jak dlouho maximálně čekáme na uvolnění mikrofonu (hovor), než zkusíme nový stream. */
export const MUTED_WAIT_MS = 15000;

export type RecoveryAction = "none" | "ok" | "wait" | "resume";

/**
 * Co dělat se snímáním při kontrole zdraví nahrávky.
 *  - "wait": mikrofon drží systém (hovor, Siri) – session běží dál, nic nerozebíráme.
 *  - "resume": snímání je mrtvé a smí se znovu rozběhnout.
 *  - "ok": vše běží; "none": nahrávání neběží nebo stránka není vidět.
 */
export function recoveryAction(input: {
  active: boolean;
  stopRequested: boolean;
  visible: boolean;
  trackLive: boolean;
  trackMuted: boolean;
  contextState: string | null;
  dataStale: boolean;
  /** Jak dlouho už přerušení trvá (ms). */
  interruptedForMs: number;
  /** Smí se teď zkusit obnova (backoff po neúspěšném pokusu)? */
  retryAllowed: boolean;
}): RecoveryAction {
  if (!input.active || input.stopRequested || !input.visible) return "none";
  const systemHolds =
    (input.trackLive && input.trackMuted) || input.contextState === "interrupted";
  const healthy = input.trackLive && input.contextState === "running" && !input.dataStale;
  if (healthy && !input.trackMuted) return "ok";
  if (systemHolds && input.interruptedForMs < MUTED_WAIT_MS) return "wait";
  return input.retryAllowed ? "resume" : "wait";
}

/** Prodleva před dalším pokusem o obnovu po `failures` neúspěších. */
export const retryDelayMs = (failures: number) => Math.min(15000, 2000 * 2 ** Math.max(0, failures - 1));
