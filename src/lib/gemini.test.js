import { describe, expect, it } from "vitest";

import { chunkText, clientStatus, describeGeminiError, toClientStream, transcribeBody } from "./gemini.ts";

const sse = (...pieces) =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });

const geminiEvent = (text, extra = {}) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text, ...extra }] } }] })}\n\n`;

async function readEvents(stream) {
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("Gemini → formát klienta", () => {
  it("převede streamovaný text na události response.output_text.*", async () => {
    const events = await readEvents(toClientStream(sse(geminiEvent("Ahoj "), geminiEvent("světe")), "text"));
    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "Ahoj " },
      { type: "response.output_text.delta", delta: "světe" },
      { type: "response.completed", text: "Ahoj světe" },
    ]);
  });

  it("u přepisu posílá transcript.text.* a celý text na konci", async () => {
    const events = await readEvents(toClientStream(sse(geminiEvent("Dobrý den.")), "transcript"));
    expect(events.at(-1)).toEqual({ type: "transcript.text.done", text: "Dobrý den." });
  });

  it("zvládne událost rozdělenou mezi dva kusy streamu", async () => {
    const event = geminiEvent("rozdělený text");
    const cut = Math.floor(event.length / 2);
    const events = await readEvents(toClientStream(sse(event.slice(0, cut), event.slice(cut)), "text"));
    expect(events[0]).toEqual({ type: "response.output_text.delta", delta: "rozdělený text" });
  });

  it("vynechá myšlenkové části modelu a nesmyslné řádky", async () => {
    const events = await readEvents(
      toClientStream(sse(geminiEvent("úvaha", { thought: true }), "data: neni-json\n\n", geminiEvent("výsledek")), "text"),
    );
    expect(events.map((e) => e.delta ?? e.text)).toEqual(["výsledek", "výsledek"]);
  });

  it("chunkText bez kandidátů vrátí prázdný text", () => {
    expect(chunkText({})).toBe("");
    expect(chunkText({ candidates: [{ finishReason: "SAFETY" }] })).toBe("");
  });

  it("zvuk posílá přímo v požadavku i s typem", () => {
    const body = JSON.parse(transcribeBody("QUJD", "audio/wav", "Přepiš"));
    expect(body.contents[0].parts[1]).toEqual({ inline_data: { mime_type: "audio/wav", data: "QUJD" } });
  });
});

describe("chyby Gemini", () => {
  it("rozliší denní limit od krátkodobého přetížení", () => {
    const daily = "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier";
    expect(clientStatus(429, daily)).toBe(402);
    expect(describeGeminiError(429, daily, "Shrnutí")).toContain("Denní bezplatný limit");
    expect(clientStatus(429, "RESOURCE_EXHAUSTED")).toBe(429);
    expect(describeGeminiError(429, "RESOURCE_EXHAUSTED", "Shrnutí")).toContain("vytížené");
  });

  it("neplatný klíč hlásí jako 401", () => {
    const detail = "API key not valid. Please pass a valid API key.";
    expect(clientStatus(400, detail)).toBe(401);
    expect(describeGeminiError(400, detail, "Přepis")).toContain("Klíč Gemini je neplatný");
  });
});
