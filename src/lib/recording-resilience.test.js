import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import { addGap, detectPlatform, shouldAutoResume, totalGapSeconds } from "./recording-resilience.ts";
import { deleteSegments, loadSegments, saveSegment } from "./audio-store.ts";
import {
  initialSessionState,
  parsePersistedSession,
  reduceSession,
  toPersistedSession,
} from "./recording-session.ts";

const live = {
  active: true,
  stopRequested: false,
  visible: true,
  trackLive: true,
  contextRunning: true,
  dataStale: false,
};

describe("automatická obnova snímání", () => {
  it("obnoví snímání, když prohlížeč ukončí mikrofon", () => {
    expect(shouldAutoResume({ ...live, trackLive: false })).toBe(true);
  });

  it("obnoví snímání po uspání AudioContextu nebo když přestanou chodit data", () => {
    expect(shouldAutoResume({ ...live, contextRunning: false })).toBe(true);
    expect(shouldAutoResume({ ...live, dataStale: true })).toBe(true);
  });

  it("stop od uživatele má vždy přednost", () => {
    expect(shouldAutoResume({ ...live, trackLive: false, stopRequested: true })).toBe(false);
  });

  it("na pozadí čeká na návrat aplikace a zdravé snímání nechává být", () => {
    expect(shouldAutoResume({ ...live, trackLive: false, visible: false })).toBe(false);
    expect(shouldAutoResume(live)).toBe(false);
  });

  it("zaznamená mezeru jen delší než sekundu", () => {
    let gaps = addGap([], 10_000, 10_800, 12);
    expect(gaps).toEqual([]);
    gaps = addGap(gaps, 10_000, 16_000, 12);
    gaps = addGap(gaps, 20_000, 23_000, 40);
    expect(gaps).toEqual([
      { at: 12, seconds: 6 },
      { at: 40, seconds: 3 },
    ]);
    expect(totalGapSeconds(gaps)).toBe(9);
    expect(addGap(gaps, null, 50_000, 60)).toBe(gaps);
  });

  it("radí podle platformy a nainstalovanou aplikaci nepřemlouvá", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";
    expect(detectPlatform(iphone, false).kind).toBe("ios-safari");
    expect(detectPlatform(iphone, false).installHint).not.toBeNull();
    expect(detectPlatform(iphone, true).installHint).toBeNull();
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 15) Chrome/130", false).kind).toBe("android");
  });
});

const wav = (label) => new Blob([label], { type: "audio/wav" });

describe("ukládání částí nahrávky do IndexedDB", () => {
  it("každou část uloží hned a vrátí je ve správném pořadí", async () => {
    for (let index = 0; index < 12; index++) await saveSegment("sess-a", index, wav(`a${index}`));
    await saveSegment("sess-b", 0, wav("b0"));
    const segments = await loadSegments("sess-a");
    expect(segments).toHaveLength(12);
    const texts = await Promise.all(segments.map((blob) => blob.text()));
    expect(texts).toEqual(Array.from({ length: 12 }, (_, i) => `a${i}`));
    expect(await loadSegments("sess-b")).toHaveLength(1);
  });

  it("smazání jedné session nesahá na jiné", async () => {
    await deleteSegments("sess-a");
    expect(await loadSegments("sess-a")).toEqual([]);
    expect(await loadSegments("sess-b")).toHaveLength(1);
  });
});

describe("obnova nedokončené nahrávky", () => {
  it("po pádu aplikace najde session i uložené části", async () => {
    let state = reduceSession(initialSessionState, { type: "start", sessionId: "crash-1", at: 1000 });
    for (let index = 0; index < 3; index++) {
      await saveSegment("crash-1", index, wav(`c${index}`));
      state = reduceSession(state, {
        type: "checkpoint",
        at: 2000 + index * 8000,
        segments: index + 1,
        seconds: (index + 1) * 8,
      });
    }
    // Do localStorage se ukládá jen tento snímek; stránka pak spadne.
    const saved = JSON.stringify(toPersistedSession(state));

    const draft = parsePersistedSession(saved);
    expect(draft).not.toBeNull();
    expect(draft.session).toBe("crash-1");
    expect(draft.awaitingRecovery).toBe(true);
    const segments = await loadSegments(draft.session);
    expect(segments).toHaveLength(3);
    expect(draft.seconds).toBe(24);
  });
});
