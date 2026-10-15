import { createFileRoute } from "@tanstack/react-router";

import {
  OPENAI_BASE_URL,
  clientStatus,
  describeOpenAIError,
  missingKeyResponse,
  openaiHeaders,
  responsesBody,
  textModel,
} from "@/lib/openai";

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
        const key = process.env["OPENAI_API_KEY"];
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

        const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
          method: "POST",
          headers: openaiHeaders(key),
          body: responsesBody(textModel(process.env), SYSTEM, text, "medium"),
          signal: request.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Refine failed [${response.status}]: ${detail}`);
          const message = describeOpenAIError(response.status, detail, "Zpřesnění přepisu");
          return new Response(JSON.stringify({ error: message }), {
            status: clientStatus(response.status, detail),
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(response.body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    },
  },
});
