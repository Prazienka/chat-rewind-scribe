/**
 * Volání Gemini s automatickým přepnutím na další model, když je ten předchozí
 * nedostupný, přetížený nebo neexistuje. Na bezplatné úrovni bývají nejnovější
 * modely občas vytížené (503), proto je pořadí od nejlepšího k nejdostupnějšímu.
 * Bez závislosti na routeru, aby šlo logiku testovat.
 */

import {
  describeGeminiError,
  eventStreamResponse,
  geminiHeaders,
  streamUrl,
  toClientStream,
} from "./gemini";

export type ModelFailure = { model: string; status: number; message: string };

export type FallbackResult =
  | { ok: true; model: string; response: Response }
  | { ok: false; failures: ModelFailure[] };

export type FallbackOptions = {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Jak dlouho čekáme na začátek odpovědi jednoho modelu. */
  connectTimeoutMs?: number;
  /** Pokusy u jednoho modelu při dočasné chybě (síť, 500). */
  attemptsPerModel?: number;
  /** Pauza před dalším pokusem u stejného modelu. */
  backoff?: (attempt: number) => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Denní limit bezplatné úrovně se opakováním nespraví. */
const DAILY_LIMIT = /per day|PerDay/i;
const INVALID_KEY = /API key not valid|API_KEY_INVALID/i;

/**
 * Výsledek jednoho modelu: odpověď, nebo důvod selhání a zda má smysl
 * zkoušet další model („next") či rovnou skončit („stop").
 */
async function tryModel(
  model: string,
  key: string,
  body: string,
  action: string,
  settings: Required<Omit<FallbackOptions, "fetchImpl">> & { fetchImpl: typeof fetch },
): Promise<Response | (ModelFailure & { stop: boolean })> {
  const { signal, fetchImpl } = settings;
  let last: ModelFailure & { stop: boolean } = {
    model,
    status: 0,
    message: "Gemini neodpovídá (vypršel čas).",
    stop: false,
  };
  for (let attempt = 1; attempt <= settings.attemptsPerModel; attempt++) {
    // Klient už odešel – nemá smysl volat další model.
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, settings.connectTimeoutMs);
    try {
      const response = await fetchImpl(streamUrl(model), {
        method: "POST",
        headers: geminiHeaders(key),
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok && response.body) return response;
      const detail = await response.text().catch(() => "");
      console.error(`[gemini] ${action} ${model} ${response.status}: ${detail.slice(0, 300)}`);
      const daily = response.status === 429 && DAILY_LIMIT.test(detail);
      const invalidKey = INVALID_KEY.test(detail) || response.status === 401 || response.status === 403;
      last = {
        model,
        // Vyčerpaný denní limit hlásíme jako 402, neplatný klíč jako 401 – obojí je trvalé.
        status: daily ? 402 : invalidKey ? 401 : response.status,
        message: describeGeminiError(response.status, detail, action),
        // Špatný klíč ani vadný vstup jiný model nespraví.
        stop: invalidKey || (response.status === 400 && !invalidKey) || response.status === 413,
      };
      if (last.stop) return last;
      // Přetížení (503/429), denní limit modelu nebo chybějící model: rovnou zkusit další model.
      if ([404, 429, 503].includes(response.status) || daily) return last;
    } catch (error) {
      clearTimeout(timer);
      if (signal.aborted) throw error;
      console.error(`[gemini] ${action} ${model} network/timeout`, error);
      last = { model, status: 0, message: "Gemini neodpovídá (vypršel čas).", stop: false };
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (attempt < settings.attemptsPerModel) await sleep(settings.backoff(attempt));
  }
  return last;
}

/**
 * Zkouší modely postupně a vrátí první úspěšnou streamovanou odpověď,
 * nebo seznam důvodů, proč selhaly všechny. Zrušení klientem se propaguje jako výjimka.
 */
export async function streamWithFallback(
  models: string[],
  key: string,
  body: string,
  action: string,
  options: FallbackOptions,
): Promise<FallbackResult> {
  const settings = {
    signal: options.signal,
    fetchImpl: options.fetchImpl ?? fetch,
    connectTimeoutMs: options.connectTimeoutMs ?? 20_000,
    attemptsPerModel: options.attemptsPerModel ?? 2,
    backoff: options.backoff ?? ((attempt: number) => attempt * 1000 + Math.random() * 300),
  };
  const failures: ModelFailure[] = [];
  for (const model of models) {
    const result = await tryModel(model, key, body, action, settings);
    if (result instanceof Response) return { ok: true, model, response: result };
    const { stop, ...failure } = result;
    failures.push(failure);
    if (stop) break;
  }
  return { ok: false, failures };
}

/** Jedna srozumitelná hláška ze všech selhání (stejné důvody se neopakují). */
export function failureMessage(failures: ModelFailure[], action: string): string {
  const reasons = [...new Set(failures.map((f) => f.message))];
  return `${action}: nepodařilo se. ${reasons.join(" ")}`;
}

/** HTTP stav pro klienta, když selžou všechny modely. */
export function failureStatus(failures: ModelFailure[]): number {
  if (failures.some((f) => f.status === 401)) return 401;
  if (failures.some((f) => f.status === 400)) return 400;
  if (failures.some((f) => f.status === 413)) return 413;
  const transient = failures.some((f) => f.status === 0 || f.status === 429 || f.status >= 500);
  if (transient) return 503;
  if (failures.some((f) => f.status === 402)) return 402;
  return 502;
}

/**
 * Celé volání pro serverový endpoint: zkusí modely postupně a vrátí buď stream
 * ve formátu klienta, nebo JSON s konkrétním důvodem selhání.
 */
export async function geminiStreamResponse(
  models: string[],
  key: string,
  body: string,
  action: string,
  mode: "text" | "transcript",
  request: Request,
): Promise<Response> {
  let result: FallbackResult;
  try {
    result = await streamWithFallback(models, key, body, action, { signal: request.signal });
  } catch {
    // Klient požadavek zrušil.
    return new Response(null, { status: 499 });
  }
  if (result.ok) {
    return eventStreamResponse(toClientStream(result.response.body!, mode), {
      "X-Gemini-Model": result.model,
    });
  }
  return new Response(JSON.stringify({ error: failureMessage(result.failures, action) }), {
    status: failureStatus(result.failures),
    headers: { "Content-Type": "application/json" },
  });
}
