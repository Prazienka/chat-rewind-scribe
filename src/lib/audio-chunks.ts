import { encodeWav } from "./wav";

/** Délka jednoho bezpečného segmentu nahrávky v sekundách. */
export const SEGMENT_SECONDS = 240;
/** Vzorkovací frekvence, se kterou pracuje přepis (16 kHz mono = nejlepší poměr kvalita/velikost). */
export const TARGET_RATE = 16000;
/** Maximální délka jedné nahrávky – 2 hodiny. */
export const MAX_RECORDING_SECONDS = 120 * 60;
/** Maximální velikost importovaného souboru. */
export const MAX_IMPORT_BYTES = 300 * 1024 * 1024;

const HEADER_BYTES = 44;

function wavHeader(dataBytes: number, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(HEADER_BYTES);
  const view = new DataView(buffer);
  const write = (pos: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return buffer;
}

/**
 * Spojí WAV segmenty do jednoho souboru. Data se nečtou do paměti – používají se
 * líné výřezy Blobu, takže i dvouhodinová nahrávka se spojí bez zatížení RAM.
 */
export function mergeWavBlobs(blobs: Blob[], sampleRate = TARGET_RATE): Blob {
  const parts: BlobPart[] = [];
  let dataBytes = 0;
  for (const blob of blobs) {
    if (blob.size <= HEADER_BYTES) continue;
    dataBytes += blob.size - HEADER_BYTES;
    parts.push(blob.slice(HEADER_BYTES));
  }
  return new Blob([wavHeader(dataBytes, sampleRate), ...parts], { type: "audio/wav" });
}

/** Rozdělí PCM data na WAV segmenty o dané délce. */
export function pcmToWavChunks(
  chunks: Float32Array[],
  sampleRate: number,
  seconds = SEGMENT_SECONDS,
): Blob[] {
  const perChunk = Math.max(1, Math.floor(seconds * sampleRate));
  const out: Blob[] = [];
  let buffer: Float32Array[] = [];
  let count = 0;
  for (const chunk of chunks) {
    buffer.push(chunk);
    count += chunk.length;
    if (count >= perChunk) {
      out.push(encodeWav(buffer, sampleRate, TARGET_RATE));
      buffer = [];
      count = 0;
    }
  }
  if (count > 0) out.push(encodeWav(buffer, sampleRate, TARGET_RATE));
  return out;
}

function toMono(audio: AudioBuffer): Float32Array {
  if (audio.numberOfChannels === 1) return audio.getChannelData(0);
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0);
  }
  for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) / audio.numberOfChannels;
  return mono;
}

/**
 * Dekóduje libovolný zvukový soubor (MP3, M4A, WEBM…) a rozdělí ho na WAV segmenty
 * v původním pořadí. Dekódování rovnou převzorkuje na 16 kHz, aby dlouhé nahrávky
 * nespotřebovaly zbytečně paměť.
 */
export async function fileToWavChunks(file: Blob, seconds = SEGMENT_SECONDS): Promise<Blob[]> {
  const bytes = await file.arrayBuffer();
  const Offline =
    (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext })
      .OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline) throw new Error("decode-unsupported");
  const ctx = new Offline(1, 1, TARGET_RATE);
  const audio = await ctx.decodeAudioData(bytes);
  const mono = toMono(audio);
  const rate = audio.sampleRate;
  const perChunk = Math.max(1, Math.floor(seconds * rate));
  const out: Blob[] = [];
  for (let offset = 0; offset < mono.length; offset += perChunk) {
    const slice = mono.subarray(offset, Math.min(mono.length, offset + perChunk));
    out.push(encodeWav([new Float32Array(slice)], rate, TARGET_RATE));
  }
  return out;
}

/** Přibližná délka nahrávky ze WAV segmentů (16bit mono). */
export function wavChunksDuration(blobs: Blob[], sampleRate = TARGET_RATE): number {
  const bytes = blobs.reduce((sum, blob) => sum + Math.max(0, blob.size - HEADER_BYTES), 0);
  return bytes / 2 / sampleRate;
}
