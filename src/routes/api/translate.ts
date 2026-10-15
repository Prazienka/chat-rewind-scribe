import { createFileRoute } from "@tanstack/react-router";

import { eventStreamResponse, toClientStream } from "@/lib/gemini";
import {
  failureMessage,
  failureStatus,
  providersFromEnv,
  translateWithFallback,
} from "@/lib/translate-providers";

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

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const Route = createFileRoute("/api/translate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
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

        const providers = providersFromEnv(process.env);
        if (providers.length === 0) {
          return json(401, "Překlad není nastavený: na serveru chybí klíč Gemini (GEMINI_API_KEY).");
        }

        let result: Awaited<ReturnType<typeof translateWithFallback>>;
        try {
          result = await translateWithFallback(providers, instructions, text, {
            signal: request.signal,
          });
        } catch {
          // Klient požadavek zrušil.
          return new Response(null, { status: 499 });
        }
        if (result.ok) {
          return eventStreamResponse(toClientStream(result.response.body!, "text"), {
            "X-Translate-Model": result.model,
          });
        }

        // Selhaly všechny modely – vrátíme konkrétní důvod.
        return json(failureStatus(result.failures), failureMessage(result.failures));
      },
    },
  },
});
