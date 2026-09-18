import { describe, expect, it } from "vitest";
import {
  DATA_STALE_MS,
  initialSessionState,
  isDataStale,
  parsePersistedSession,
  reduceSession,
  sessionLabel,
  toPersistedSession,
} from "./recording-session.ts";

const start = (at = 1000) =>
  reduceSession(initialSessionState, { type: "start", sessionId: "s1", at });

describe("recording session state machine", () => {
  it("survives background and foreground without stopping", () => {
    let state = start();
    state = reduceSession(state, { type: "background", at: 1100 });
    expect(state.phase).toBe("background");
    expect(sessionLabel(state)).toBe("Na pozadí");
    state = reduceSession(state, { type: "data", at: 1200 });
    expect(state.phase).toBe("background");
    state = reduceSession(state, { type: "foreground", at: 1300 });
    expect(state.phase).toBe("recording");
    expect(state.stopRequested).toBe(false);
  });

  it("treats a lock-like visibility change as background, never as saved", () => {
    let state = start();
    state = reduceSession(state, { type: "background", at: 2000 });
    state = reduceSession(state, { type: "background", at: 2500 });
    expect(state.phase).toBe("background");
    expect(sessionLabel(state)).not.toBe("Uloženo");
  });

  it("maps unexpected recorder stop and interruption to interrupted", () => {
    let state = start();
    state = reduceSession(state, { type: "interrupted", at: 3000, reason: "track-ended" });
    expect(state.phase).toBe("interrupted");
    expect(state.reason).toBe("track-ended");
    state = reduceSession(state, { type: "recovering", at: 3100 });
    expect(state.phase).toBe("recovering");
    state = reduceSession(state, { type: "recovery-failed", at: 3200, reason: "no-stream" });
    expect(state.phase).toBe("interrupted");
    expect(state.awaitingRecovery).toBe(true);
  });

  it("recovers back into recording after a successful resume", () => {
    let state = start();
    state = reduceSession(state, { type: "interrupted", at: 4000 });
    state = reduceSession(state, { type: "recovering", at: 4100 });
    state = reduceSession(state, { type: "recovered", at: 4200 });
    expect(state.phase).toBe("recording");
    expect(state.lastChunkAt).toBe(4200);
    expect(state.reason).toBe(null);
  });

  it("gives explicit stop priority over a racing resume", () => {
    let state = start();
    state = reduceSession(state, { type: "user-stop", at: 5000 });
    state = reduceSession(state, { type: "recovering", at: 5001 });
    state = reduceSession(state, { type: "recovered", at: 5002 });
    state = reduceSession(state, { type: "background", at: 5003 });
    expect(state.stopRequested).toBe(true);
    expect(state.phase).toBe("recording");
    state = reduceSession(state, { type: "checkpoint", at: 5010, segments: 3, seconds: 90 });
    expect(state.confirmedSegments).toBe(3);
    state = reduceSession(state, { type: "saved", at: 5020 });
    expect(state.phase).toBe("saved");
  });

  it("keeps confirmed chunks monotonic", () => {
    let state = start();
    state = reduceSession(state, { type: "checkpoint", at: 6000, segments: 4, seconds: 120 });
    state = reduceSession(state, { type: "checkpoint", at: 6100, segments: 2, seconds: 60 });
    expect(state.confirmedSegments).toBe(4);
    expect(state.confirmedSeconds).toBe(120);
  });

  it("detects a silent browser that stopped delivering data", () => {
    let state = start(0);
    state = reduceSession(state, { type: "data", at: 1000 });
    expect(isDataStale(state, 1000 + DATA_STALE_MS - 1)).toBe(false);
    expect(isDataStale(state, 1000 + DATA_STALE_MS + 1)).toBe(true);
    const stopped = reduceSession(state, { type: "user-stop", at: 1500 });
    const saved = reduceSession(stopped, { type: "saved", at: 1600 });
    expect(isDataStale(saved, 99999)).toBe(false);
  });

  it("persists and restores chunk recovery info", () => {
    let state = start(7000);
    state = reduceSession(state, { type: "checkpoint", at: 7100, segments: 5, seconds: 150 });
    const persisted = toPersistedSession(state);
    expect(persisted).toMatchObject({ session: "s1", segments: 5, seconds: 150, active: true });
    const restored = parsePersistedSession(JSON.stringify(persisted));
    expect(restored?.awaitingRecovery).toBe(true);
    expect(parsePersistedSession("nonsense")).toBe(null);
    expect(parsePersistedSession(null)).toBe(null);
  });
});
