import { describe, expect, it, vi } from "vitest";

import {
  failureStatus,
  providersFromEnv,
  translateWithFallback,
} from "./translate-providers.ts";

const stream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const failure = (status, body = "") => new Response(body, { status });

const options = (fetchImpl) => ({
  signal: new AbortController().signal,
  fetchImpl,
  backoff: () => 0,
});

const BOTH = providersFromEnv({ OPENAI_API_KEY: "sk-test", LOVABLE_API_KEY: "lv-test" });

describe("překlad – záložní poskytovatel", () => {
  it("bez klíče OpenAI použije jen vestavěnou AI", () => {
    const providers = providersFromEnv({ LOVABLE_API_KEY: "lv-test" });
    expect(providers.map((p) => p.name)).toEqual(["lovable"]);
  });

  it("OpenAI má přednost, preferred=lovable pořadí otočí", () => {
    expect(BOTH.map((p) => p.name)).toEqual(["openai", "lovable"]);
    const reversed = providersFromEnv({ OPENAI_API_KEY: "a", LOVABLE_API_KEY: "b" }, "lovable");
    expect(reversed.map((p) => p.name)).toEqual(["lovable", "openai"]);
  });

  it("když OpenAI nemá kredit, odpoví vestavěná AI", async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes("openai.com")
        ? failure(429, '{"error":{"code":"insufficient_quota"}}')
        : stream(),
    );
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("lovable");
    // Vyčerpaná kvóta se neopakuje: 1× OpenAI, 1× záloha.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dočasnou chybu zkusí u stejného poskytovatele znovu", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => (++calls === 1 ? failure(503) : stream()));
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("openai");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("výpadek sítě u prvního poskytovatele přepne na druhého", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("openai.com")) throw new TypeError("fetch failed");
      return stream();
    });
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("lovable");
  });

  it("když selžou oba, vrátí konkrétní důvody a správný stav", async () => {
    const fetchImpl = vi.fn(async (url) =>
      String(url).includes("openai.com") ? failure(401) : failure(402),
    );
    const result = await translateWithFallback(BOTH, "přelož", "Ahoj", options(fetchImpl));
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.message)).toEqual([
      "OpenAI: neplatný nebo chybějící klíč.",
      "Vestavěná AI: došel kredit.",
    ]);
    expect(failureStatus(result.failures)).toBe(402);
  });

  it("přetížení u obou se hlásí jako dočasná chyba (klient zkusí znovu)", () => {
    expect(
      failureStatus([
        { provider: "openai", status: 429, message: "" },
        { provider: "lovable", status: 401, message: "" },
      ]),
    ).toBe(503);
  });
});
