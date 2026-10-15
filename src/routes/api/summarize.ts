import { createFileRoute } from "@tanstack/react-router";

import { geminiKey, missingKeyResponse, textBody, textModels } from "@/lib/gemini";
import { geminiStreamResponse } from "@/lib/gemini-fallback";

const SUMMARY_INSTRUCTIONS =
  "Jsi asistent, který shrnuje přepisy rozhovorů v češtině. Vrať krátké shrnutí v odrážkách (znak •) – jen to podstatné: hlavní témata, rozhodnutí, čísla, termíny a úkoly. Na konci uveď sekci 'Úkoly:' pouze pokud nějaké zazněly. Žádný úvod ani vysvětlování.";

export const Route = createFileRoute("/api/summarize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = geminiKey(process.env);
        if (!key) return missingKeyResponse();

        const body = (await request.json().catch(() => null)) as { text?: string } | null;
        const text = body?.text?.trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "Chybí text k shrnutí." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        return geminiStreamResponse(
          textModels(process.env),
          key,
          textBody(SUMMARY_INSTRUCTIONS, text),
          "Shrnutí",
          "text",
          request,
        );
      },
    },
  },
});
