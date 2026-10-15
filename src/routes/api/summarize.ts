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

const SUMMARY_INSTRUCTIONS =
  "Jsi asistent, který shrnuje přepisy rozhovorů v češtině. Vrať krátké shrnutí v odrážkách (znak •) – jen to podstatné: hlavní témata, rozhodnutí, čísla, termíny a úkoly. Na konci uveď sekci 'Úkoly:' pouze pokud nějaké zazněly. Žádný úvod ani vysvětlování.";

export const Route = createFileRoute("/api/summarize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["OPENAI_API_KEY"];
        if (!key) return missingKeyResponse();

        const body = (await request.json().catch(() => null)) as { text?: string } | null;
        const text = body?.text?.trim();
        if (!text) {
          return new Response(JSON.stringify({ error: "Chybí text k shrnutí." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
          method: "POST",
          headers: openaiHeaders(key),
          body: responsesBody(textModel(process.env), SUMMARY_INSTRUCTIONS, text, "low"),
          signal: request.signal,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Summary failed [${response.status}]: ${detail}`);
          const message = describeOpenAIError(response.status, detail, "Shrnutí");
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
