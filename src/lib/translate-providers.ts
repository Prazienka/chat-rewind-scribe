/**
 * Volání AI poskytovatelů pro překlad s automatickým přepnutím na další,
 * když první selže. Bez závislosti na routeru, aby šlo logiku testovat.
 */

export type ProviderName = "openai" | "lovable";

export type Provider = {
  name: ProviderName;
  url: string;
  key: string;
  model: string;
};

export type ProviderFailure = { provider: ProviderName; status: number; message: string };

export type FallbackResult =
  | { ok: true; provider: ProviderName; response: Response }
  | { ok: false; failures: ProviderFailure[] };

type Options = {
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Jak dlouho čekáme na začátek odpovědi jednoho poskytovatele. */
  connectTimeoutMs?: number;
  attemptsPerProvider?: number;
  /** Pauza mezi pokusy u stejného poskytovatele (ms podle čísla pokusu). */
  backoff?: (attempt: number) => number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poskytovatelé podle dostupných klíčů. OpenAI má přednost, vestavěná AI je záloha. */
export function providersFromEnv(
  env: Record<string, string | undefined>,
  preferred?: string,
): Provider[] {
  const providers: Provider[] = [];
  const openaiKey = env["OPENAI_API_KEY"];
  const lovableKey = env["LOVABLE_API_KEY"];
  if (openaiKey) {
    providers.push({
      name: "openai",
      url: "https://api.openai.com/v1/responses",
      key: openaiKey,
      model: "gpt-5-mini",
    });
  }
  if (lovableKey) {
    providers.push({
      name: "lovable",
      url: "https://ai.gateway.lovable.dev/v1/responses",
      key: lovableKey,
      model: "openai/gpt-6-astra",
    });
  }
  if (preferred === "lovable") providers.reverse();
  return providers;
}

export function describeFailure(provider: ProviderName, status: number, detail: string): string {
  const who = provider === "openai" ? "OpenAI" : "Vestavěná AI";
  if (status === 0) return `${who}: neodpovídá (vypršel čas).`;
  if (status === 401) return `${who}: neplatný nebo chybějící klíč.`;
  if (status === 402 || /insufficient_quota|billing|credit/i.test(detail)) {
    return `${who}: došel kredit.`;
  }
  if (status === 403) return `${who}: přístup odmítnut.`;
  if (status === 429) return `${who}: příliš mnoho požadavků.`;
  if (status >= 500) return `${who}: služba je dočasně nedostupná.`;
  return `${who}: chyba ${status}.`;
}

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
    // Klient už odešel – nemá smysl platit za další volání.
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, options.connectTimeoutMs);
    try {
      const response = await fetchImpl(provider.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.key}`,
          ...(provider.name === "lovable" ? { "X-Lovable-AIG-SDK": "fetch" } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          stream: true,
          store: false,
          reasoning: { effort: "low" },
          instructions,
          input: text,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok && response.body) return response;
      const detail = await response.text().catch(() => "");
      console.error(`[translate] ${provider.name} ${response.status}: ${detail.slice(0, 300)}`);
      last = {
        provider: provider.name,
        status: response.status,
        message: describeFailure(provider.name, response.status, detail),
      };
      // Klíč, kredit ani přístup se opakováním nespraví – rovnou zkusíme dalšího poskytovatele.
      const quota = /insufficient_quota|billing/i.test(detail);
      if ([400, 401, 402, 403, 404].includes(response.status) || quota) return last;
    } catch (error) {
      clearTimeout(timer);
      if (signal.aborted) throw error;
      console.error(`[translate] ${provider.name} network/timeout`, error);
      last = { provider: provider.name, status: 0, message: describeFailure(provider.name, 0, "") };
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (attempt < options.attemptsPerProvider) await sleep(options.backoff(attempt));
  }
  return last;
}

/**
 * Zkouší poskytovatele postupně. Vrátí první úspěšnou streamovanou odpověď,
 * nebo seznam důvodů, proč selhali všichni. Zrušení klientem se propaguje jako výjimka.
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
    backoff: options.backoff ?? ((attempt: number) => attempt * 1000 + Math.random() * 500),
  };
  const failures: ProviderFailure[] = [];
  for (const provider of providers) {
    const result = await callProvider(provider, instructions, text, settings);
    if (result instanceof Response) return { ok: true, provider: provider.name, response: result };
    failures.push(result);
  }
  return { ok: false, failures };
}

/** HTTP stav pro klienta, když selžou všichni poskytovatelé. */
export function failureStatus(failures: ProviderFailure[]): number {
  const transient = failures.some((f) => f.status === 0 || f.status === 429 || f.status >= 500);
  if (transient) return 503;
  return failures.some((f) => f.status === 402) ? 402 : 502;
}
