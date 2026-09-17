import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/summarize")({
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

        const body = (await request.json().catch(() => null)) as { text?: string } | null;
        const text = body?.text?.trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "Chybí text k shrnutí." }), {
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
            reasoning: { effort: "low", summary: "auto" },
            include: ["reasoning.encrypted_content"],
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: "Jsi asistent, který shrnuje přepisy rozhovorů v češtině. Vrať krátké shrnutí v odrážkách (znak •) – jen to podstatné: hlavní témata, rozhodnutí, čísla, termíny a úkoly. Na konci uveď sekci 'Úkoly:' pouze pokud nějaké zazněly. Žádný úvod ani vysvětlování.",
                  },
                ],
              },
              {
                role: "user",
                content: [{ type: "input_text", text }],
              },
            ],
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Summary failed [${response.status}]: ${detail}`);
          const message =
            response.status === 402
              ? "Na pracovním prostoru chybí AI kredity."
              : response.status === 429
                ? "Příliš mnoho požadavků, zkuste to prosím za chvíli."
                : `Shrnutí se nepodařilo (${response.status}).`;
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
