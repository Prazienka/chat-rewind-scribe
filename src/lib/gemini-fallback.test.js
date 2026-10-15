import { describe, expect, it, vi } from "vitest";

import { DEFAULT_MODELS, textModels } from "./gemini.ts";
import {
  failureMessage,
  failureStatus,
  geminiStreamResponse,
  streamWithFallback,
} from "./gemini-fallback.ts";

const stream = (text = "Hi") =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const failure = (status, body = "") => new Response(body, { status });
const MODELS = ["gemini-a", "gemini-b", "gemini-c"];
const modelOf = (url) => String(url).match(/models\/([^:]+):/)?.[1];
const options = (fetchImpl) => ({ signal: new AbortController().signal, fetchImpl, backoff: () => 0 });

describe("modely Gemini v pořadí", () => {
  it("bez nastavení používá výchozí pořadí, jinak seznam z proměnné", () => {
    expect(textModels({})).toEqual(DEFAULT_MODELS);
    expect(textModels({ GEMINI_TEXT_MODELS: " gemini-x , gemini-y " })).toEqual(["gemini-x", "gemini-y"]);
  });

  it("posílá klíč v hlavičce, ne v adrese", async () => {
    const fetchImpl = vi.fn(async () => stream());
    await streamWithFallback(MODELS, "tajny-klic", "{}", "Překlad", options(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("models/gemini-a:streamGenerateContent?alt=sse");
    expect(String(url)).not.toContain("tajny-klic");
    expect(init.headers["x-goog-api-key"]).toBe("tajny-klic");
  });
});

describe("přepínání modelů", () => {
  it("přetížený model (503) hned přeskočí na další", async () => {
    const fetchImpl = vi.fn(async (url) => (modelOf(url) === "gemini-a" ? failure(503) : stream()));
    const result = await streamWithFallback(MODELS, "k", "{}", "Shrnutí", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gemini-b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("chybějící model (404) i limit (429) přeskočí", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const model = modelOf(url);
      if (model === "gemini-a") return failure(404);
      if (model === "gemini-b") return failure(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}');
      return stream();
    });
    const result = await streamWithFallback(MODELS, "k", "{}", "Přepis", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.model).toBe("gemini-c");
  });

  it("výpadek sítě zkusí jednou znovu, pak další model", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (modelOf(url) === "gemini-a") throw new TypeError("fetch failed");
      return stream();
    });
    const result = await streamWithFallback(MODELS, "k", "{}", "Překlad", options(fetchImpl));
    expect(result.model).toBe("gemini-b");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("neplatný klíč další modely nezkouší", async () => {
    const fetchImpl = vi.fn(async () =>
      failure(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}'),
    );
    const result = await streamWithFallback(MODELS, "k", "{}", "Překlad", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(failureStatus(result.failures)).toBe(401);
    expect(failureMessage(result.failures, "Překlad")).toContain("Klíč Gemini je neplatný");
  });

  it("když jsou všechny přetížené, hlásí dočasnou chybu bez opakování stejného důvodu", async () => {
    const fetchImpl = vi.fn(async () => failure(503));
    const result = await streamWithFallback(MODELS, "k", "{}", "Shrnutí", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(failureStatus(result.failures)).toBe(503);
    expect(failureMessage(result.failures, "Shrnutí")).toBe(
      "Shrnutí: nepodařilo se. Služba Gemini je momentálně nedostupná.",
    );
  });

  it("vyčerpaný denní limit u všech modelů hlásí jako 402", async () => {
    const daily = "Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier";
    const fetchImpl = vi.fn(async () => failure(429, daily));
    const result = await streamWithFallback(MODELS, "k", "{}", "Překlad", options(fetchImpl));
    expect(failureStatus(result.failures)).toBe(402);
  });

  it("zrušený požadavek už další model nevolá", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => stream());
    await expect(
      streamWithFallback(MODELS, "k", "{}", "Překlad", { signal: controller.signal, fetchImpl }),
    ).rejects.toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("odpověď endpointu", () => {
  it("vrací stream ve formátu klienta a název modelu", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => (modelOf(url) === "gemini-a" ? failure(503) : stream("Ahoj")));
    try {
      const response = await geminiStreamResponse(MODELS, "k", "{}", "Shrnutí", "text", new Request("http://x"));
      expect(response.headers.get("X-Gemini-Model")).toBe("gemini-b");
      const body = await response.text();
      expect(body).toContain('"type":"response.output_text.delta","delta":"Ahoj"');
      expect(body).toContain('"type":"response.completed"');
    } finally {
      globalThis.fetch = original;
    }
  });
});
