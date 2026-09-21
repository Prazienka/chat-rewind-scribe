import { createFileRoute } from "@tanstack/react-router";

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

export const Route = createFileRoute("/api/translate")({
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
          target?: string;
        } | null;
        const text = body?.text?.trim();
        const MAX_CHARS = 12_000;
        const target = LANG_NAMES[body?.target ?? "en"] ?? "angličtiny";
        if (!text) {
          return new Response(
            JSON.stringify({ error: "Přepis je prázdný, není co přeložit." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (text.length > MAX_CHARS) {
          return new Response(
            JSON.stringify({
              error: "Část textu je příliš dlouhá; rozdělte přepis na menší části.",
            }),
            { status: 413, headers: { "Content-Type": "application/json" } },
          );
        }

        const system = `Jsi profesionální překladatel. Přelož dodaný úryvek přepisu rozhovoru do ${target}.

Pravidla:
- Přelož VŠE, nic nevynechávej, nesumarizuj ani nepřidávej komentáře.
- Zachovej odstavce, řádkování a případné označení mluvčích.
- Zachovej čísla, ceny, časy a jména; převeď je do notace cílového jazyka.
- Jde o úryvek delšího textu, takže nepřidávej úvod ani závěr.
- Odpověz POUZE přeloženým textem.`;

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
            reasoning: { effort: "low", summary: "auto" },
            include: ["reasoning.encrypted_content"],
            input: [
              { role: "system", content: [{ type: "input_text", text: system }] },
              { role: "user", content: [{ type: "input_text", text }] },
            ],
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Translate failed [${response.status}]: ${detail}`);
          const message =
            response.status === 402
              ? "V pracovním prostoru chybí AI kredity pro překlad."
              : response.status === 429
                ? "Příliš mnoho požadavků, zkuste to prosím za chvíli."
                : response.status === 401 || response.status === 403
                  ? "Přístup k AI službě pro překlad byl odmítnut."
                  : response.status >= 500
                    ? "AI služba pro překlad je momentálně nedostupná."
                    : `Překlad se nepodařil (${response.status}).`;
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
