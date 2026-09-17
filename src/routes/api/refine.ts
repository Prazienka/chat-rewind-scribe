import { createFileRoute } from "@tanstack/react-router";

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
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) {
          return new Response(JSON.stringify({ error: "Chybí konfigurace AI klíče." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

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

        const response = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": key,
            "X-Lovable-AIG-SDK": "fetch",
          },
          body: JSON.stringify({
            model: "openai/gpt-6-astra",
            stream: true,
            reasoning: { effort: "medium", summary: "auto" },
            include: ["reasoning.encrypted_content"],
            input: [
              { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
              { role: "user", content: [{ type: "input_text", text }] },
            ],
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Refine failed [${response.status}]: ${detail}`);
          const message =
            response.status === 402
              ? "Na pracovním prostoru chybí AI kredity."
              : response.status === 429
                ? "Příliš mnoho požadavků, zkuste to prosím za chvíli."
                : `Zpřesnění přepisu se nepodařilo (${response.status}).`;
          return new Response(JSON.stringify({ error: message }), {
            status: response.status,
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
