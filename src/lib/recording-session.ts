/**
 * Stavový automat nahrávací session – čistá logika bez UI a bez Web API.
 *
 * Pravidla:
 *  - Session ukončí jen výslovný `user-stop` (nebo dosažení limitu), nikdy přechod
 *    do pozadí, ztráta zaměření ani zamknutí displeje.
 *  - Neočekávané ukončení streamu/rekordéru vede do stavu `interrupted`,
 *    nikdy do `saved`.
 *  - Potvrzené části (`confirmedSegments` / `confirmedSeconds`) se nikdy nesnižují.
 */

export type RecordingPhase =
  | "idle"
  | "recording"
  | "background"
  | "interrupted"
  | "recovering"
  | "saved"
  | "error";

export type RecordingSessionState = {
  phase: RecordingPhase;
  /** Id session, pod kterým jsou v IndexedDB uložené segmenty. */
  sessionId: string | null;
  /** Kdy naposledy skutečně přišla data z mikrofonu (ms). */
  lastChunkAt: number | null;
  /** Kdy byla naposledy část bezpečně uložená (ms). */
  lastCheckpointAt: number | null;
  confirmedSegments: number;
  confirmedSeconds: number;
  /** Uživatel stiskl Stop – žádná automatická událost už session nerozběhne. */
  stopRequested: boolean;
  /** Čeká rozpracovaná nahrávka na rozhodnutí uživatele? */
  awaitingRecovery: boolean;
  reason: string | null;
};

export type RecordingEvent =
  | { type: "start"; sessionId: string; at: number }
  | { type: "data"; at: number }
  | { type: "checkpoint"; at: number; segments: number; seconds: number }
  | { type: "background"; at: number }
  | { type: "foreground"; at: number }
  | { type: "interrupted"; at: number; reason?: string }
  | { type: "recovering"; at: number }
  | { type: "recovered"; at: number }
  | { type: "recovery-failed"; at: number; reason?: string }
  | { type: "user-stop"; at: number }
  | { type: "saved"; at: number }
  | { type: "discarded"; at: number }
  | { type: "error"; at: number; reason?: string };

/** Po jaké době bez dat z mikrofonu považujeme snímání za přerušené. */
export const DATA_STALE_MS = 6000;

export const initialSessionState: RecordingSessionState = {
  phase: "idle",
  sessionId: null,
  lastChunkAt: null,
  lastCheckpointAt: null,
  confirmedSegments: 0,
  confirmedSeconds: 0,
  stopRequested: false,
  awaitingRecovery: false,
  reason: null,
};

const LIVE: RecordingPhase[] = ["recording", "background", "interrupted", "recovering"];

export const isLive = (state: RecordingSessionState) => LIVE.includes(state.phase);

export function reduceSession(
  state: RecordingSessionState,
  event: RecordingEvent,
): RecordingSessionState {
  // Stop má absolutní prioritu: po jeho vyžádání nesmí žádné obnovování session vzkřísit.
  if (state.stopRequested && event.type !== "saved" && event.type !== "discarded") {
    if (event.type === "checkpoint") {
      return {
        ...state,
        lastCheckpointAt: event.at,
        confirmedSegments: Math.max(state.confirmedSegments, event.segments),
        confirmedSeconds: Math.max(state.confirmedSeconds, event.seconds),
      };
    }
    if (event.type === "error") return { ...state, phase: "error", reason: event.reason ?? null };
    return state;
  }

  switch (event.type) {
    case "start":
      return {
        ...initialSessionState,
        phase: "recording",
        sessionId: event.sessionId,
        lastChunkAt: event.at,
      };
    case "data":
      if (!isLive(state)) return state;
      return {
        ...state,
        lastChunkAt: event.at,
        phase: state.phase === "background" ? "background" : "recording",
        reason: state.phase === "recording" ? null : state.reason,
      };
    case "checkpoint":
      return {
        ...state,
        lastCheckpointAt: event.at,
        confirmedSegments: Math.max(state.confirmedSegments, event.segments),
        confirmedSeconds: Math.max(state.confirmedSeconds, event.seconds),
      };
    case "background":
      if (!isLive(state)) return state;
      return state.phase === "recording" ? { ...state, phase: "background" } : state;
    case "foreground":
      if (state.phase !== "background") return state;
      return { ...state, phase: "recording" };
    case "interrupted":
      if (!isLive(state)) return state;
      return { ...state, phase: "interrupted", reason: event.reason ?? null };
    case "recovering":
      if (!isLive(state)) return state;
      return { ...state, phase: "recovering" };
    case "recovered":
      if (!isLive(state)) return state;
      return { ...state, phase: "recording", lastChunkAt: event.at, reason: null };
    case "recovery-failed":
      if (!isLive(state)) return state;
      return {
        ...state,
        phase: "interrupted",
        awaitingRecovery: true,
        reason: event.reason ?? null,
      };
    case "user-stop":
      return { ...state, stopRequested: true, phase: "recording", reason: null };
    case "saved":
      return { ...initialSessionState, phase: "saved" };
    case "discarded":
      return { ...initialSessionState };
    case "error":
      return { ...state, phase: "error", reason: event.reason ?? null };
    default:
      return state;
  }
}

/** Přestal prohlížeč dodávat data, i když session stále běží? */
export function isDataStale(
  state: RecordingSessionState,
  now: number,
  timeout = DATA_STALE_MS,
): boolean {
  if (state.phase !== "recording" && state.phase !== "background") return false;
  if (state.lastChunkAt === null) return false;
  return now - state.lastChunkAt > timeout;
}

/** Krátký stav pro UI. Nikdy neříká „zastaveno“, pokud stop nebyl vyžádaný. */
export function sessionLabel(state: RecordingSessionState): string {
  switch (state.phase) {
    case "recording":
      return "Nahrávání";
    case "background":
      return "Na pozadí";
    case "interrupted":
      return "Přerušeno";
    case "recovering":
      return "Obnovuji";
    case "saved":
      return "Uloženo";
    case "error":
      return "Chyba";
    default:
      return "Připraveno";
  }
}

export type PersistedSession = {
  session: string;
  seconds: number;
  segments: number;
  lastChunkAt: number | null;
  active: boolean;
  awaitingRecovery: boolean;
};

export function toPersistedSession(state: RecordingSessionState): PersistedSession | null {
  if (!state.sessionId) return null;
  return {
    session: state.sessionId,
    seconds: state.confirmedSeconds,
    segments: state.confirmedSegments,
    lastChunkAt: state.lastChunkAt,
    active: isLive(state),
    awaitingRecovery: state.awaitingRecovery || isLive(state),
  };
}

export function parsePersistedSession(raw: string | null): PersistedSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedSession>;
    if (!value || typeof value.session !== "string" || value.session.length === 0) return null;
    return {
      session: value.session,
      seconds: typeof value.seconds === "number" ? value.seconds : 0,
      segments: typeof value.segments === "number" ? value.segments : 0,
      lastChunkAt: typeof value.lastChunkAt === "number" ? value.lastChunkAt : null,
      active: value.active !== false,
      awaitingRecovery: value.awaitingRecovery !== false,
    };
  } catch {
    return null;
  }
}
