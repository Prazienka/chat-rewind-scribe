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

const OPENAI_MODEL = "gpt-5-mini";
const MAX_CHARS = 12_000;

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const Route = createFileRoute("/api/translate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["OPENAI_API_KEY"];
        if (!key) {
          return json(
            401,
            "Překlad není nastaven: chybí klíč OpenAI (OPENAI_API_KEY) v nastavení projektu.",
          );
        }

        const body = (await request.json().catch(() => null)) as {
          text?: string;
          target?: string;
          source?: string;
        } | null;
        const text = body?.text?.trim();
        if (!text) return json(400, "Přepis je prázdný, není co přeložit.");
        if (text.length > MAX_CHARS) {
          return json(413, "Část textu je příliš dlouhá; rozdělte přepis na menší části.");
        }
        const target = LANG_NAMES[body?.target ?? "en"] ?? "angličtiny";
        const sourceName = body?.source ? LANG_NAMES[body.source] : undefined;
        const from = sourceName ? ` z ${sourceName}` : "";

        const instructions = `Jsi profesionální překladatel. Přelož dodaný úryvek přepisu rozhovoru${from} do ${target}.

Pravidla:
- Přelož VŠE věrně a přirozeně; nic nevynechávej, nesumarizuj, nevymýšlej a nepřidávej komentáře.
- Zachovej význam, terminologii, odstavce, řádkování a označení mluvčích.
- Jména, čísla, ceny, časové údaje a odborné termíny zachovej přesně.
- Jde o úryvek delšího textu, takže nepřidávej úvod ani závěr.
- Pokud je text už v cílovém jazyce, vrať ho beze změny.
- Odpověz POUZE přeloženým textem.`;

        let response: Response;
        try {
          response = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL,
              stream: true,
              store: false,
              reasoning: { effort: "low" },
              instructions,
              input: text,
            }),
            signal: request.signal,
          });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") return new Response(null, { status: 499 });
          console.error("Translate network error", error);
          return json(502, "Nepodařilo se spojit se službou OpenAI. Zkuste to prosím znovu.");
        }

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`OpenAI translate failed [${response.status}]: ${detail.slice(0, 500)}`);
          const quota = /insufficient_quota|billing/i.test(detail);
          const message =
            response.status === 401
              ? "Klíč OpenAI je neplatný. Zkontrolujte OPENAI_API_KEY v nastavení projektu."
              : response.status === 403
                ? "OpenAI odmítlo přístup k modelu pro tento klíč."
                : response.status === 429 && quota
                  ? "Na účtu OpenAI došel kredit nebo limit. Doplňte ho v OpenAI a zkuste to znovu."
                  : response.status === 429
                    ? "Příliš mnoho požadavků na OpenAI, zkuste to prosím za chvíli."
                    : response.status >= 500
                      ? "Služba OpenAI je momentálně nedostupná."
                      : `Překlad se nepodařil (${response.status}).`;
          // Vyčerpaná kvóta se opakováním nespraví → hlásíme jako trvalou chybu (402).
          return json(quota ? 402 : response.status, message);
        }

        return new Response(response.body, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" },
        });
      },
    },
  },
});
