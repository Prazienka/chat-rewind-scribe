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

        const response = await fetchGemini(streamUrl(textModel(process.env)), {
          method: "POST",
          headers: geminiHeaders(key),
          body: textBody(SUMMARY_INSTRUCTIONS, text),
          signal: request.signal,
        }, "Shrnutí");

        if (response.headers.get("X-Gemini-Network-Error") || response.status === 499) return response;
        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Summary failed [${response.status}]: ${detail.slice(0, 500)}`);
          const message = describeGeminiError(response.status, detail, "Shrnutí");
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
