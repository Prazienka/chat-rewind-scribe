/**
 * Napojení na Google Gemini API (bezplatná úroveň z Google AI Studio).
 * Klíč i modely se berou z proměnných prostředí serveru, nikdy z prohlížeče.
 *
 * Gemini streamuje vlastní formát; převádíme ho na události, které klient
 * už umí číst (src/lib/pipeline.ts):
 *   text:   response.output_text.delta → response.completed
 *   přepis: transcript.text.delta      → transcript.text.done
 */

export type ServerEnv = Record<string, string | undefined>;

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export const geminiKey = (env: ServerEnv) => env["GEMINI_API_KEY"];

/**
 * Modely v pořadí, v jakém se zkoušejí. Nejnovější Flash bývá na bezplatné
 * úrovni občas přetížený (503), proto následují dostupnější modely.
 */
export const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

function modelList(value: string | undefined): string[] {
  const list = (value ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_MODELS;
}

/** Modely pro korekturu, shrnutí a překlad (GEMINI_TEXT_MODELS, oddělené čárkou). */
export const textModels = (env: ServerEnv) => modelList(env["GEMINI_TEXT_MODELS"]);
/** Modely pro přepis řeči (GEMINI_TRANSCRIBE_MODELS, oddělené čárkou). */
export const transcribeModels = (env: ServerEnv) => modelList(env["GEMINI_TRANSCRIBE_MODELS"]);

export function streamUrl(model: string): string {
  return `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function geminiHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", "x-goog-api-key": key };
}

/** Tělo požadavku pro textovou úlohu se systémovými pokyny. */
export function textBody(instructions: string, input: string, temperature = 0.2): string {
  return JSON.stringify({
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: "user", parts: [{ text: input }] }],
    generationConfig: { temperature },
  });
}

/** Tělo požadavku pro přepis zvuku (base64 přímo v požadavku, limit Gemini je 20 MB). */
export function transcribeBody(audioBase64: string, mimeType: string, prompt: string): string {
  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioBase64 } }],
      },
    ],
    generationConfig: { temperature: 0 },
  });
}

/** Vytáhne text z jedné streamované odpovědi Gemini. */
export function chunkText(payload: unknown): string {
  const candidates = (payload as { candidates?: unknown[] } | null)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";
  const parts = (candidates[0] as { content?: { parts?: unknown[] } })?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const p = part as { text?: unknown; thought?: unknown };
      // Myšlenkové části modelu do výsledku nepatří.
      return typeof p.text === "string" && p.thought !== true ? p.text : "";
    })
    .join("");
}

/**
 * Převede SSE stream Gemini na SSE stream ve formátu, který čte klient.
 * Řádky, které nejsou JSON, se přeskočí; na konci se pošle závěrečná událost.
 */
export function toClientStream(
  upstream: ReadableStream<Uint8Array>,
  mode: "text" | "transcript",
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const deltaType = mode === "text" ? "response.output_text.delta" : "transcript.text.delta";
  let buffer = "";
  let full = "";

  const emit = (controller: TransformStreamDefaultController<Uint8Array>, event: object) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

  const handleLine = (line: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    const text = chunkText(payload);
    if (!text) return;
    full += text;
    emit(controller, { type: deltaType, delta: text });
  };

  return upstream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line, controller);
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) handleLine(buffer, controller);
        emit(
          controller,
          mode === "text"
            ? { type: "response.completed", text: full }
            : { type: "transcript.text.done", text: full },
        );
      },
    }),
  );
}

export function eventStreamResponse(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      ...headers,
    },
  });
}

const QUOTA = /RESOURCE_EXHAUSTED|quota/i;

/** Srozumitelná česká hláška podle odpovědi Gemini. */
export function describeGeminiError(status: number, detail: string, action: string): string {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) {
    return "Klíč Gemini je neplatný. Zkontrolujte GEMINI_API_KEY v nastavení serveru.";
  }
  if (status === 401 || status === 403) {
    return "Gemini odmítlo přístup. Zkontrolujte GEMINI_API_KEY a že je Gemini API povolené.";
  }
  if (status === 429 && /per day|PerDay/i.test(detail)) {
    return "Denní bezplatný limit Gemini je vyčerpaný. Zkuste to zítra, nebo zapněte placenou úroveň.";
  }
  if (status === 429 || QUOTA.test(detail)) {
    return "Gemini je teď vytížené (limit bezplatné úrovně). Zkuste to prosím za chvíli.";
  }
  if (status === 404) return "Model Gemini nebyl nalezen. Zkontrolujte název modelu v nastavení.";
  if (status === 413) return "Část zvuku je pro Gemini příliš velká.";
  if (status >= 500) return "Služba Gemini je momentálně nedostupná.";
  return `${action} se nepodařilo dokončit (${status}).`;
}

/**
 * Stav pro klienta. Denní limit se opakováním nespraví, takže ho hlásíme
 * jako 402 (klient ho neopakuje); krátkodobé přetížení zůstává 429.
 */
export function clientStatus(status: number, detail: string): number {
  if (status === 429 && /per day|PerDay/i.test(detail)) return 402;
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(detail)) return 401;
  return status;
}

export const missingKeyResponse = () =>
  new Response(
    JSON.stringify({
      error: "AI není nastavená: na serveru chybí klíč Gemini (GEMINI_API_KEY).",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );

/** Base64 pro zvuk; Buffer je k dispozici v Node i ve Workers (nodejs_compat). */
export function toBase64(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64");
}
