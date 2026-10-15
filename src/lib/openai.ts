/**
 * Přímé napojení na OpenAI (místo AI brány Lovable).
 * Klíč i modely se berou z proměnných prostředí serveru, nikdy z prohlížeče.
 */

export type ServerEnv = Record<string, string | undefined>;

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Hlavní textový model (korektura, shrnutí, překlad). */
export const textModel = (env: ServerEnv) => env["OPENAI_TEXT_MODEL"] || "gpt-5-mini";
/** Záložní textový model pro překlad, když hlavní model selže. */
export const fallbackTextModel = (env: ServerEnv) => env["OPENAI_FALLBACK_MODEL"] || "gpt-4.1-mini";
/** Model pro přepis řeči na text. */
export const transcribeModel = (env: ServerEnv) =>
  env["OPENAI_TRANSCRIBE_MODEL"] || "gpt-4o-transcribe";

/** Modely s „přemýšlením“ (gpt-5, o-série) berou parametr reasoning, ostatní ho odmítnou. */
export function supportsReasoning(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model);
}

/** Tělo požadavku na Responses API se streamem. */
export function responsesBody(
  model: string,
  instructions: string,
  input: string,
  effort: "minimal" | "low" | "medium" = "low",
): string {
  return JSON.stringify({
    model,
    stream: true,
    store: false,
    instructions,
    input,
    ...(supportsReasoning(model) ? { reasoning: { effort } } : {}),
  });
}

export function openaiHeaders(key: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

/** Srozumitelná česká hláška podle odpovědi OpenAI. */
export function describeOpenAIError(status: number, detail: string, action: string): string {
  if (status === 401) return "Klíč OpenAI je neplatný. Zkontrolujte OPENAI_API_KEY v nastavení serveru.";
  if (status === 402 || /insufficient_quota|billing/i.test(detail)) {
    return "Na účtu OpenAI došel kredit. Doplňte ho na platform.openai.com a zkuste to znovu.";
  }
  if (status === 403) return "OpenAI odmítlo přístup k modelu pro tento klíč.";
  if (status === 429) return "Příliš mnoho požadavků na OpenAI, zkuste to prosím za chvíli.";
  if (status >= 500) return "Služba OpenAI je momentálně nedostupná.";
  return `${action} se nepodařilo dokončit (${status}).`;
}

/** Stav pro klienta: vyčerpaný kredit hlásíme jako 402, aby se zbytečně neopakoval. */
export function clientStatus(status: number, detail: string): number {
  return /insufficient_quota|billing/i.test(detail) ? 402 : status;
}

export const missingKeyResponse = () =>
  new Response(
    JSON.stringify({
      error: "AI není nastavená: na serveru chybí klíč OpenAI (OPENAI_API_KEY).",
    }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
