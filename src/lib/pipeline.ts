/**
 * Zpracování dlouhých nahrávek: přepis po segmentech, opravy a překlad po částech.
 * Vše běží postupně, s opakováním při chybě, a výsledek se spojí v původním pořadí.
 */

export type StageProgress = {
  done: number;
  total: number;
  percent: number;
};

const MAX_ATTEMPTS = 3;
const TEXT_CHUNK_CHARS = 8000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;
const TEXT_TIMEOUT_MS = 75_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SseEvent = { type?: string; delta?: string; text?: string };

async function readSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("no-body");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        onEvent(JSON.parse(payload) as SseEvent);
      } catch {
        /* poškozená událost – ignorujeme */
      }
    }
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data?.error || fallback;
  } catch {
    return fallback;
  }
}

/** Jeden segment zvuku → text. Při chybě se pokus opakuje. */
async function transcribeChunk(
  chunk: Blob,
  language: string,
  index: number,
): Promise<{ text: string; error?: string }> {
  let lastError = "Přepis části se nepodařil.";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const body = new FormData();
      body.append("file", chunk, `cast-${index + 1}.wav`);
      body.append("language", language);
      const response = await fetch("/api/transcribe", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        lastError = await errorMessage(response, lastError);
        // Chyby vstupu nemá smysl opakovat.
        if (response.status === 400 || response.status === 413) break;
        clearTimeout(timeout);
        await sleep(attempt * 1500);
        continue;
      }
      let text = "";
      await readSse(response, (event) => {
        if (event.type === "transcript.text.delta" && event.delta) text += event.delta;
        else if (event.type === "transcript.text.done") text = event.text ?? text;
      });
      clearTimeout(timeout);
      if (text.trim()) return { text: text.trim() };
      lastError = "Přepis části nevrátil žádný text.";
    } catch {
      lastError = "Spojení se přerušilo.";
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1500);
  }
  return { text: "", error: lastError };
}

export type TranscribeResult = {
  text: string;
  failed: number[];
};

/**
 * Přepíše všechny segmenty postupně a spojí je v původním pořadí.
 * Selhaná část se označí, ale ostatní se nezahodí.
 */
export async function transcribeChunks(
  chunks: Blob[],
  language: string,
  handlers: {
    onPartial?: (text: string) => void;
    onProgress?: (progress: StageProgress) => void;
  } = {},
): Promise<TranscribeResult> {
  const parts: string[] = [];
  const failed: number[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const result = await transcribeChunk(chunk, language, index);
    if (result.error) {
      failed.push(index);
      parts.push(`[část ${index + 1} se nepodařilo přepsat]`);
    } else if (result.text) {
      parts.push(result.text);
    }
    const joined = parts.join("\n\n");
    handlers.onPartial?.(joined);
    handlers.onProgress?.({
      done: index + 1,
      total: chunks.length,
      percent: Math.round(((index + 1) / chunks.length) * 100),
    });
    // Ustupme prohlížeči, aby rozhraní zůstalo plynulé.
    await sleep(0);
  }
  return { text: parts.join("\n\n").trim(), failed };
}

/** Rozdělí dlouhý text na části podle odstavců a vět, aby se nepřekročil limit modelu. */
export function splitText(text: string, limit = TEXT_CHUNK_CHARS): string[] {
  if (text.length <= limit) return [text];
  const blocks = text.split(/\n{2,}/);
  const parts: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) parts.push(current.trim());
    current = "";
  };
  for (const block of blocks) {
    const pieces =
      block.length <= limit ? [block] : (block.match(/[^.!?]+[.!?]*\s*/g) ?? [block]);
    for (const piece of pieces) {
      if (current.length + piece.length > limit && current) push();
      if (piece.length > limit) {
        for (let i = 0; i < piece.length; i += limit) parts.push(piece.slice(i, i + limit));
        continue;
      }
      current += piece;
    }
    current += "\n\n";
  }
  push();
  return parts.filter(Boolean);
}

/**
 * Pošle dlouhý text po částech na zadaný endpoint a spojí odpovědi v původním pořadí.
 * Streamovaný mezivýsledek předáváme dál, aby UI hned ukazovalo postup.
 */
export async function processLongText(
  endpoint: string,
  text: string,
  options: {
    payload?: Record<string, unknown>;
    limit?: number;
    onPartial?: (text: string) => void;
    onProgress?: (progress: StageProgress) => void;
  } = {},
): Promise<{ text: string; failed: number }> {
  const parts = splitText(text, options.limit ?? TEXT_CHUNK_CHARS);
  const done: string[] = [];
  let failed = 0;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part) continue;
    let output = "";
    let ok = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
      output = "";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TEXT_TIMEOUT_MS);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...options.payload, text: part }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          if (response.status === 400) break;
          clearTimeout(timeout);
          await sleep(attempt * 1500);
          continue;
        }
        await readSse(response, (event) => {
          if (event.type === "response.output_text.delta" && event.delta) {
            output += event.delta;
            options.onPartial?.([...done, output].join("\n\n"));
          }
        });
        ok = output.trim().length > 0;
        if (!ok) await sleep(attempt * 1000);
      } catch {
        if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1500);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (ok) done.push(output.trim());
    else {
      failed++;
      done.push(`[část ${index + 1} se nepodařilo zpracovat]`);
    }
    options.onPartial?.(done.join("\n\n"));
    options.onProgress?.({
      done: index + 1,
      total: parts.length,
      percent: Math.round(((index + 1) / parts.length) * 100),
    });
    await sleep(0);
  }

  return { text: done.join("\n\n").trim(), failed };
}
