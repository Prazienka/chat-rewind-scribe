import { createFileRoute } from "@tanstack/react-router";

/** Názvy jazyků v 2. pádě ("z češtiny", "do angličtiny"). */
const LANG_NAMES: Record<string, string> = {
  cs: "češtiny",
  en: "angličtiny",
  de: "němčiny",
  sk: "slovenštiny",
  pl: "polštiny",
  uk: "ukrajinštiny",
  es: "španělštiny",
  fr: "francouzštiny",
  it: "italštiny",
};

const MAX_CHARS = 12_000;
/** Jak dlouho čekáme na začátek odpovědi jednoho poskytovatele. */
const CONNECT_TIMEOUT_MS = 45_000;
const ATTEMPTS_PER_PROVIDER = 2;

type Provider = {
  name: "openai" | "lovable";
  url: string;
  key: string;
  model: string;
};

type Failure = { provider: Provider["name"]; status: number; message: string };

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describe(provider: Provider["name"], status: number, detail: string): string {
  const who = provider === "openai" ? "OpenAI" : "Vestavěná AI";
  if (status === 0) return `${who}: neodpovídá (vypršel čas).`;
  if (status === 401) return `${who}: neplatný nebo chybějící klíč.`;
  if (status === 402 || /insufficient_quota|billing|credit/i.test(detail))
    return `${who}: došel kredit.`;
  if (status === 403) return `${who}: přístup odmítnut.`;
  if (status === 429) return `${who}: příliš mnoho požadavků.`;
  if (status >= 500) return `${who}: služba je dočasně nedostupná.`;
  return `${who}: chyba ${status}.`;
}

async function callProvider(
  provider: Provider,
  instructions: string,
  text: string,
  signal: AbortSignal,
): Promise<Response | Failure> {
  let last: Failure = { provider: provider.name, status: 0, message: describe(provider.name, 0, "") };
  for (let attempt = 1; attempt <= ATTEMPTS_PER_PROVIDER; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort);
    const timer = setTimeout(abort, CONNECT_TIMEOUT_MS);
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` },
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
      last = { provider: provider.name, status: response.status, message: describe(provider.name, response.status, detail) };
      // Klíč, kredit ani přístup se opakováním nespraví – rovnou zkusíme dalšího poskytovatele.
      const quota = /insufficient_quota|billing/i.test(detail);
      if ([400, 401, 402, 403, 404].includes(response.status) || quota) return last;
    } catch (error) {
      clearTimeout(timer);
      if (signal.aborted) throw error;
      console.error(`[translate] ${provider.name} network/timeout`, error);
      last = { provider: provider.name, status: 0, message: describe(provider.name, 0, "") };
    } finally {
      signal.removeEventListener("abort", abort);
    }
    if (attempt < ATTEMPTS_PER_PROVIDER) await sleep(attempt * 1000 + Math.random() * 500);
  }
  return last;
}

export const Route = createFileRoute("/api/translate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          text?: string;
          target?: string;
          source?: string;
          preferred?: string;
        } | null;
        const text = body?.text?.trim();
        if (!text) return json(400, "Přepis je prázdný, není co přeložit.");
        if (text.length > MAX_CHARS) {
          return json(413, "Část textu je příliš dlouhá; rozdělte přepis na menší části.");
        }
        const target = LANG_NAMES[body?.target ?? "en"] ?? "angličtiny";
        const sourceName = body?.source ? LANG_NAMES[body.source] : undefined;
        const from = sourceName
          ? ` z ${sourceName}`
          : " (zdrojový jazyk sám rozpoznej)";

        const instructions = `Jsi profesionální překladatel. Přelož dodaný úryvek přepisu rozhovoru${from} do ${target}.

Pravidla:
- Přelož VŠE věrně a přirozeně; nic nevynechávej, nesumarizuj, nevymýšlej a nepřidávej komentáře.
- Zachovej význam, terminologii, odstavce, řádkování a označení mluvčích.
- Jména, čísla, ceny, časové údaje a odborné termíny zachovej přesně.
- Jde o úryvek delšího textu, takže nepřidávej úvod ani závěr.
- Pokud je text už v cílovém jazyce, vrať ho beze změny.
- Odpověz POUZE přeloženým textem.`;

        const providers: Provider[] = [];
        const openaiKey = process.env["OPENAI_API_KEY"];
        const lovableKey = process.env["LOVABLE_API_KEY"];
        if (openaiKey)
          providers.push({ name: "openai", url: "https://api.openai.com/v1/responses", key: openaiKey, model: "gpt-5-mini" });
        if (lovableKey)
          providers.push({ name: "lovable", url: "https://ai.gateway.lovable.dev/v1/responses", key: lovableKey, model: "openai/gpt-6-astra" });
        if (body?.preferred === "lovable") providers.reverse();
        if (providers.length === 0) {
          return json(401, "Překlad není nastavený: chybí klíč k AI službě.");
        }

        const failures: Failure[] = [];
        for (const provider of providers) {
          let result: Response | Failure;
          try {
            result = await callProvider(provider, instructions, text, request.signal);
          } catch {
            return new Response(null, { status: 499 });
          }
          if (result instanceof Response) {
            return new Response(result.body, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "X-Translate-Provider": provider.name,
              },
            });
          }
          failures.push(result);
        }

        // Selhali všichni poskytovatelé – vrátíme konkrétní důvody.
        const message = `Překlad se nepodařil. ${failures.map((f) => f.message).join(" ")}`;
        const transient = failures.some((f) => f.status === 0 || f.status === 429 || f.status >= 500);
        const status = transient ? 503 : failures.some((f) => f.status === 402) ? 402 : 502;
        return json(status, message);
      },
    },
  },
});
