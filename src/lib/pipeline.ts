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
export const TRANSLATE_CHUNK_CHARS = 3000;
const TRANSCRIBE_TIMEOUT_MS = 90_000;
const TEXT_STALL_MS = 120_000;

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
      lastError = "Spojení se přerušilo nebo vypršel časový limit.";
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

export type LongTextResult = {
  /** Spojený výsledek v původním pořadí. */
  text: string;
  /** Jednotlivé hotové části; prázdný řetězec = část se nepodařila. */
  parts: string[];
  total: number;
  failed: number;
  failedIndexes: number[];
  /** Konkrétní popis poslední chyby pro UI. */
  error?: string;
};

type ChunkOutcome = { text: string; error?: string; terminal?: boolean };

/** Lidsky pochopitelná hláška podle stavu odpovědi serveru. */
function describeHttpFailure(status: number, serverMessage: string): string {
  if (serverMessage) return serverMessage;
  if (status === 400) return "Text k odeslání nebyl přijat (prázdný nebo poškozený obsah).";
  if (status === 401 || status === 403) return "Přístup k AI službě byl odmítnut.";
  if (status === 402) return "V pracovním prostoru chybí AI kredity.";
  if (status === 413) return "Část textu je příliš dlouhá.";
  if (status === 429) return "Příliš mnoho požadavků, zkuste to prosím za chvíli.";
  if (status >= 500) return `AI služba je momentálně nedostupná (${status}).`;
  return `Zpracování se nepodařilo (${status}).`;
}

/** Jedna část textu → odpověď modelu. Hlídáme zastavení streamu, ne celkovou délku. */
async function runTextChunk(
  endpoint: string,
  part: string,
  payload: Record<string, unknown> | undefined,
  onDelta: (output: string) => void,
): Promise<ChunkOutcome> {
  let lastError = "Zpracování části se nepodařilo.";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    let stall: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => controller.abort(), TEXT_STALL_MS);
    };
    let output = "";
    try {
      arm();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, text: part }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const serverMessage = await errorMessage(response, "");
        lastError = describeHttpFailure(response.status, serverMessage);
        // Vstupní a přístupové chyby nemá smysl opakovat.
        if ([400, 401, 402, 403, 413].includes(response.status)) {
          return { text: "", error: lastError, terminal: true };
        }
        await sleep(attempt * 1500);
        continue;
      }
      await readSse(response, (event) => {
        arm();
        if (event.type === "response.output_text.delta" && event.delta) {
          output += event.delta;
          onDelta(output);
        } else if (event.type === "response.completed" && !output && event.text) {
          output = event.text;
          onDelta(output);
        }
      });
      if (output.trim()) return { text: output.trim() };
      lastError = "AI služba nevrátila žádný přeložený text.";
    } catch {
      lastError = "Spojení se přerušilo nebo AI služba přestala odpovídat.";
    } finally {
      if (stall) clearTimeout(stall);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(attempt * 1500);
  }
  return { text: "", error: lastError };
}

/**
 * Pošle dlouhý text po částech na zadaný endpoint a spojí odpovědi v původním pořadí.
 * Už hotové části lze předat v `initialParts`, takže opakování dokončí jen to, co chybí.
 */
export async function processLongText(
  endpoint: string,
  text: string,
  options: {
    payload?: Record<string, unknown>;
    limit?: number;
    preserveInputOnFailure?: boolean;
    initialParts?: string[];
    onPartial?: (text: string) => void;
    onProgress?: (progress: StageProgress) => void;
  } = {},
): Promise<LongTextResult> {
  const source = splitText(text, options.limit ?? TEXT_CHUNK_CHARS);
  const reuse =
    options.initialParts && options.initialParts.length === source.length
      ? options.initialParts
      : undefined;
  const results: string[] = source.map((_, index) => {
    const existing = reuse?.[index];
    return existing && existing.trim() ? existing : "";
  });
  const failedIndexes: number[] = [];
  let lastError: string | undefined;

  const joined = () =>
    results
      .map((value, index) =>
        value.trim()
          ? value
          : options.preserveInputOnFailure
            ? (source[index] ?? "")
            : `[část ${index + 1} se nepodařilo zpracovat]`,
      )
      .join("\n\n")
      .trim();

  const report = (done: number) => {
    options.onPartial?.(joined());
    options.onProgress?.({
      done,
      total: source.length,
      percent: Math.round((done / source.length) * 100),
    });
  };

  let terminal = false;
  for (let index = 0; index < source.length; index++) {
    const part = source[index];
    if (!part) continue;
    if (results[index]?.trim()) {
      report(index + 1);
      continue;
    }
    if (terminal) {
      failedIndexes.push(index);
      continue;
    }
    const outcome = await runTextChunk(endpoint, part, options.payload, (output) => {
      const preview = [...results.slice(0, index), output].filter(Boolean).join("\n\n");
      options.onPartial?.(preview);
    });
    if (outcome.text) {
      results[index] = outcome.text;
    } else {
      failedIndexes.push(index);
      lastError = outcome.error ?? lastError;
      if (outcome.terminal) terminal = true;
    }
    report(index + 1);
    await sleep(0);
  }

  return {
    text: joined(),
    parts: results,
    total: source.length,
    failed: failedIndexes.length,
    failedIndexes,
    ...(lastError ? { error: lastError } : {}),
  };
}
