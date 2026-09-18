import { createFileRoute } from "@tanstack/react-router";

// Klient posílá zvuk po segmentech (max ~4 minuty, 16 kHz mono ≈ 8 MB).
// Limit je proto nastavený s rezervou, ne jako strop délky nahrávky.
const MAX_BYTES = 30 * 1024 * 1024;

export const Route = createFileRoute("/api/transcribe")({
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

        const form = await request.formData();
        const file = form.get("file");
        const language = form.get("language");

        if (!(file instanceof File) || file.size < 2048) {
          return new Response(
            JSON.stringify({ error: "Nahrávka je prázdná nebo příliš krátká." }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        if (file.size > MAX_BYTES) {
          return new Response(
            JSON.stringify({ error: "Nahrávka je příliš velká. Rozdělte ji na kratší části." }),
            { status: 413, headers: { "Content-Type": "application/json" } },
          );
        }

        const type = (file.type || "audio/wav").split(";")[0] ?? "audio/wav";
        const extByType: Record<string, string> = {
          "audio/wav": "wav",
          "audio/x-wav": "wav",
          "audio/wave": "wav",
          "audio/webm": "webm",
          "video/webm": "webm",
          "audio/mp4": "mp4",
          "audio/m4a": "m4a",
          "audio/x-m4a": "m4a",
          "video/mp4": "mp4",
          "audio/mpeg": "mp3",
          "audio/mp3": "mp3",
          "audio/flac": "flac",
          "audio/ogg": "ogg",
        };
        const nameExt = file.name.includes(".")
          ? file.name.split(".").pop()!.toLowerCase()
          : undefined;
        const ext = extByType[type] ?? nameExt ?? "wav";
        // Gemini rejects video/* parts, even when the container is audio-only.
        const audioType = type.startsWith("video/") ? type.replace("video/", "audio/") : type;
        const payload = new Blob([await file.arrayBuffer()], { type: audioType });

        const upstream = new FormData();
        upstream.append("model", "google/gemini-3.5-transcribe");
        upstream.append("file", payload, `recording.${ext}`);
        upstream.append("stream", "true");
        if (typeof language === "string" && language && language !== "auto") {
          upstream.append("language", language);
        }

        const response = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          body: upstream,
        });

        if (!response.ok || !response.body) {
          const detail = await response.text().catch(() => "");
          console.error(`Transcription failed [${response.status}]: ${detail}`);
          const message =
            response.status === 402
              ? "Na pracovním prostoru chybí AI kredity."
              : response.status === 429
                ? "Příliš mnoho požadavků, zkuste to prosím za chvíli."
                : `Přepis se nepodařil (${response.status}).`;
          return new Response(JSON.stringify({ error: message, detail }), {
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
