import { createFileRoute } from "@tanstack/react-router";

import {
  clientStatus,
  fetchGemini,
  describeGeminiError,
  eventStreamResponse,
  geminiHeaders,
  geminiKey,
  missingKeyResponse,
  streamUrl,
  textBody,
  textModel,
  toClientStream,
} from "@/lib/gemini";

const SYSTEM = `Jsi korektor českých přepisů mluveného slova. Dostaneš hrubý strojový přepis rozhovoru a vrátíš jeho opravenou verzi.

Pravidla:
- Zachovej VŠECHNA sdělení a význam, nic nevynechávej ani nepřidávej, nic nesumarizuj.
- Oprav chybně rozpoznaná slova podle kontextu, doplň chybějící diakritiku a správné české skloňování a časování.
- Oprav jména osob, firem, měst a odborné termíny podle kontextu; známá česká jména piš správně (např. "Jiří Novák", "Škoda Auto", "Brno").
- Čísla, ceny, procenta, časy a datumy zapiš číslicemi a v české notaci (1 250 Kč, 15 %, 14:30, 3. června 2026). Telefonní čísla a částky ověř podle kontextu věty.
- Doplň interpunkci, velká písmena a rozděl text do vět a odstavců podle témat.
- Odstraň zbytečné výplňky ("ehm", "jakoby" navíc, opakovaná slova), ale zachovej mluvený styl a tón.
- Pokud v přepisu mluví více lidí a lze je odlišit, označ je jako "Mluvčí 1:", "Mluvčí 2:" na začátku řádku.
- Nejasné pasáže označ jako [nezřetelné].
- Odpověz POUZE opraveným textem, bez úvodu a komentáře.`;

export const Route = createFileRoute("/api/refine")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = geminiKey(process.env);
        if (!key) return missingKeyResponse();

        const body = (await request.json().catch(() => null)) as {
          text?: string;
          language?: string;
        } | null;
        const text = body?.text?.trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "Chybí text k opravě." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const response = await fetchGemini(streamUrl(textModel(process.env)), {
          method: "POST",
          headers: geminiHeaders(key),
          body: textBody(SYSTEM, text),
          signal: request.signal,
        }, "Zpřesnění přepisu");

        if (response.headers.get("X-Gemini-Network-Error") || response.status === 499) return response;
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Refine failed [${response.status}]: ${detail.slice(0, 500)}`);
          const message = describeGeminiError(response.status, detail, "Zpřesnění přepisu");
          return new Response(JSON.stringify({ error: message }), {
            status: clientStatus(response.status, detail),
            headers: { "Content-Type": "application/json" },
          });
        }

        return eventStreamResponse(toClientStream(response.body, "text"));
      },
    },
  },
});
