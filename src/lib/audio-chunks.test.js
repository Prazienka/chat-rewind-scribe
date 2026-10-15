import { describe, expect, it } from "vitest";

import {
  MAX_RECORDING_SECONDS,
  RECORDING_CHECKPOINT_SECONDS,
  SEGMENT_SECONDS,
  TARGET_RATE,
  coalesceWavChunks,
  mergeWavBlobs,
  pcmToWavChunks,
  wavChunksDuration,
} from "./audio-chunks";

describe("long recording audio chunks", () => {
  it("keeps the requested 120 minute maximum", () => {
    expect(MAX_RECORDING_SECONDS).toBe(120 * 60);
    expect(RECORDING_CHECKPOINT_SECONDS).toBeLessThan(SEGMENT_SECONDS);
  });

  it("creates ordered transcription chunks below the server limit", () => {
    const minute = new Float32Array(TARGET_RATE * 60);
    const chunks = pcmToWavChunks(Array.from({ length: 10 }, () => minute), TARGET_RATE);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.size < 30 * 1024 * 1024)).toBe(true);
    expect(Math.round(wavChunksDuration(chunks))).toBe(600);
  });

  it("coalesces checkpoints without changing duration", () => {
    const checkpoint = new Float32Array(TARGET_RATE * RECORDING_CHECKPOINT_SECONDS);
    checkpoint.fill(0.1);
    const saved = pcmToWavChunks(
      // 10 minut zvuku bez ohledu na to, jak často se ukládá (dřív 30 s, teď 8 s).
      Array.from({ length: Math.round(600 / RECORDING_CHECKPOINT_SECONDS) }, () => checkpoint),
      TARGET_RATE,
      RECORDING_CHECKPOINT_SECONDS,
    );
    const processing = coalesceWavChunks(saved);
    expect(processing).toHaveLength(3);
    expect(Math.round(wavChunksDuration(processing))).toBe(600);
    expect(Math.round(wavChunksDuration([mergeWavBlobs(saved)]))).toBe(600);
  });
});