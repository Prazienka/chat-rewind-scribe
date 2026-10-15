import { createFileRoute } from "@tanstack/react-router";

import {
  geminiKey,
  missingKeyResponse,
  toBase64,
  transcribeBody,
  transcribeModels,
} from "@/lib/gemini";
import { geminiStreamResponse } from "@/lib/gemini-fallback";

// Klient posílá zvuk po segmentech (max ~4 minuty, 16 kHz mono ≈ 8 MB).
// Gemini bere nejvýš 20 MB na požadavek a base64 zvuk zvětší asi o třetinu.
const MAX_BYTES = 14 * 1024 * 1024;

const LANGUAGE_NAMES: Record<string, string> = {
  cs: "čeština",
  en: "angličtina",
  sk: "slovenština",
  de: "němčina",
};

const MIME_BY_EXT: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mp3",
  m4a: "audio/m4a",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
};

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function transcribePrompt(language: string | null): string {
  const name = language ? LANGUAGE_NAMES[language] : undefined;
  return [
    "Přepiš řeč z přiložené nahrávky doslovně do textu.",
    name ? `Jazyk rozhovoru: ${name}.` : "Jazyk rozpoznej sám a přepisuj v jazyce, kterým se mluví.",
    "Zachovej všechna řečená slova v pořadí, jak zazněla; nic neshrnuj, nepřekládej a nevymýšlej.",
    "Doplň základní interpunkci. Vrať pouze samotný přepis bez úvodu, komentářů a časových značek.",
    "Pokud v nahrávce nikdo nemluví, vrať prázdnou odpověď.",
  ].join("\n");
}

export const Route = createFileRoute("/api/transcribe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = geminiKey(process.env);
        if (!key) return missingKeyResponse();

        const form = await request.formData();
        const file = form.get("file");
        const language = form.get("language");

        if (!(file instanceof File) || file.size < 2048) {
          return json(400, "Nahrávka je prázdná nebo příliš krátká.");
        }
        if (file.size > MAX_BYTES) {
          return json(413, "Nahrávka je příliš velká. Rozdělte ji na kratší části.");
        }

        const type = (file.type || "audio/wav").split(";")[0] ?? "audio/wav";
        const nameExt = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
        // Gemini odmítá video/* i u čistě zvukového kontejneru.
        const mimeType = type.startsWith("audio/")
          ? type
          : (MIME_BY_EXT[nameExt] ?? type.replace("video/", "audio/"));

        const body = transcribeBody(
          toBase64(await file.arrayBuffer()),
          mimeType,
          transcribePrompt(typeof language === "string" && language !== "auto" ? language : null),
        );
        return geminiStreamResponse(
          transcribeModels(process.env),
          key,
          body,
          "Přepis",
          "transcript",
          request,
        );
      },
    },
  },
});
