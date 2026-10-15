/**
 * Překlad přes Gemini s automatickým přepnutím na záložní model, když hlavní
 * selže nebo je přetížený. Bez závislosti na routeru, aby šlo logiku testovat.
 */

import {
  describeGeminiError,
  fallbackTextModel,
  geminiHeaders,
  geminiKey,
  streamUrl,
  textBody,
  textModel,
} from "./gemini";

export type ProviderName = "primary" | "fallback";

export type Provider = {
  name: ProviderName;
  key: string;
  model: string;
};

export type ProviderFailure = { provider: ProviderName; status: number; message: string };

export type FallbackResult =
  | { ok: true; provider: ProviderName; model: string; response: Response }
  | { ok: false; failures: ProviderFailure[] };

type Options = {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Jak dlouho čekáme na začátek odpovědi jednoho modelu. */
  connectTimeoutMs?: number;
  attemptsPerProvider?: number;
  /** Pauza mezi pokusy u stejného modelu (ms podle čísla pokusu). */
  backoff?: (attempt: number) => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hlavní a záložní model Gemini. Bez klíče není s čím překládat. */
export function providersFromEnv(env: Record<string, string | undefined>): Provider[] {
  const key = geminiKey(env);
  if (!key) return [];
  const primary = textModel(env);
  const fallback = fallbackTextModel(env);
  const providers: Provider[] = [{ name: "primary", key, model: primary }];
  if (fallback && fallback !== primary) providers.push({ name: "fallback", key, model: fallback });
  return providers;
}

export function describeFailure(_provider: ProviderName, status: number, detail: string): string {
  if (status === 0) return "Gemini neodpovídá (vypršel čas).";
  return describeGeminiError(status, detail, "Překlad");
}

/** Jedna srozumitelná hláška ze všech selhání (stejné důvody se neopakují). */
export function failureMessage(failures: ProviderFailure[]): string {
  const reasons = [...new Set(failures.map((f) => f.message))];
  return `Překlad se nepodařil. ${reasons.join(" ")}`;
}

/** Denní limit bezplatné úrovně se opakováním nespraví. */
const DAILY_LIMIT = /per day|PerDay/i;
const INVALID_KEY = /API key not valid|API_KEY_INVALID/i;

async function callProvider(
  provider: Provider,
  instructions: string,
  text: string,
  options: Required<Pick<Options, "connectTimeoutMs" | "attemptsPerProvider" | "backoff">> & {
    signal: AbortSignal;
    fetchImpl: typeof fetch;
  },
): Promise<Response | ProviderFailure> {
  const { signal, fetchImpl } = options;
  let last: ProviderFailure = {
    provider: provider.name,
    status: 0,
    message: describeFailure(provider.name, 0, ""),
  };
  for (let attempt = 1; attempt <= options.attemptsPerProvider; attempt++) {
    // Klient už odešel – nemá smysl volat další model.
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, options.connectTimeoutMs);
    try {
      const response = await fetchImpl(streamUrl(provider.model), {
        method: "POST",
        headers: geminiHeaders(provider.key),
        body: textBody(instructions, text),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok && response.body) return response;
      const detail = await response.text().catch(() => "");
      console.error(`[translate] ${provider.model} ${response.status}: ${detail.slice(0, 300)}`);
      const daily = response.status === 429 && DAILY_LIMIT.test(detail);
      const invalidKey = INVALID_KEY.test(detail);
      last = {
        provider: provider.name,
        // Vyčerpaný denní limit hlásíme jako 402, neplatný klíč jako 401 – obojí je trvalé.
        status: daily ? 402 : invalidKey ? 401 : response.status,
        message: describeFailure(provider.name, response.status, detail),
      };
      // Klíč, přístup, model ani denní limit se opakováním nespraví – zkusíme záložní model.
      if ([400, 401, 403, 404].includes(response.status) || daily) return last;
    } catch (error) {
      clearTimeout(timer);
      if (signal.aborted) throw error;
      console.error(`[translate] ${provider.model} network/timeout`, error);
      last = { provider: provider.name, status: 0, message: describeFailure(provider.name, 0, "") };
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (attempt < options.attemptsPerProvider) await sleep(options.backoff(attempt));
  }
  return last;
}

/**
 * Zkouší modely postupně. Vrátí první úspěšnou streamovanou odpověď,
 * nebo seznam důvodů, proč selhaly všechny. Zrušení klientem se propaguje jako výjimka.
 */
export async function translateWithFallback(
  providers: Provider[],
  instructions: string,
  text: string,
  options: Options,
): Promise<FallbackResult> {
  const settings = {
    signal: options.signal,
    fetchImpl: options.fetchImpl ?? fetch,
    connectTimeoutMs: options.connectTimeoutMs ?? 45_000,
    attemptsPerProvider: options.attemptsPerProvider ?? 2,
    backoff: options.backoff ?? ((attempt: number) => attempt * 2000 + Math.random() * 500),
  };
  const failures: ProviderFailure[] = [];
  for (const provider of providers) {
    const result = await callProvider(provider, instructions, text, settings);
    if (result instanceof Response) {
      return { ok: true, provider: provider.name, model: provider.model, response: result };
    }
    failures.push(result);
  }
  return { ok: false, failures };
}

/** HTTP stav pro klienta, když selžou všechny modely. */
export function failureStatus(failures: ProviderFailure[]): number {
  const transient = failures.some((f) => f.status === 0 || f.status === 429 || f.status >= 500);
  if (transient) return 503;
  if (failures.some((f) => f.status === 402)) return 402;
  if (failures.some((f) => f.status === 401 || f.status === 403)) return 401;
  return 502;
}
