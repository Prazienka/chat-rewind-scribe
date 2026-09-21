import { afterEach, describe, expect, it, vi } from "vitest";

import { processLongText, splitText, TRANSLATE_CHUNK_CHARS } from "./pipeline";

function sseResponse(text) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const piece of text.split(" ")) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `${piece} ` })}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function errorResponse(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AI překlad", () => {
  it("přeloží krátký text jedním voláním", async () => {
    const fetchMock = vi.fn(async () => sseResponse("Hello world"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await processLongText("/api/translate", "Ahoj světe", {
      payload: { target: "en" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Hello world");
    expect(result.failed).toBe(0);
    expect(result.total).toBe(1);
  });

  it("dlouhý text rozdělí a spojí v původním pořadí", async () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `Odstavec ${i}. Delší obsah větou.`);
    const input = blocks.join("\n\n");
    let call = 0;
    vi.stubGlobal("fetch", async () => sseResponse(`part${call++}`));
    const parts = splitText(input, TRANSLATE_CHUNK_CHARS);
    const result = await processLongText("/api/translate", input, {
      limit: TRANSLATE_CHUNK_CHARS,
    });
    expect(parts.length).toBeGreaterThan(1);
    expect(result.total).toBe(parts.length);
    expect(result.parts).toEqual(parts.map((_, i) => `part${i}`));
    expect(result.text).toBe(parts.map((_, i) => `part${i}`).join("\n\n"));
  });

  it("po dočasné chybě 429 zkusí část znovu", async () => {
    let call = 0;
    vi.stubGlobal("fetch", async () => {
      call++;
      return call === 1 ? errorResponse(429, "Rate limit") : sseResponse("Hello");
    });
    const result = await processLongText("/api/translate", "Ahoj", {});
    expect(call).toBe(2);
    expect(result.text).toBe("Hello");
    expect(result.failed).toBe(0);
  }, 20_000);

  it("chybu poskytovatele ohlásí konkrétní hláškou a nezkouší ji znovu", async () => {
    const fetchMock = vi.fn(async () => errorResponse(402, "V pracovním prostoru chybí AI kredity."));
    vi.stubGlobal("fetch", fetchMock);
    const result = await processLongText("/api/translate", "Ahoj", {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
    expect(result.error).toBe("V pracovním prostoru chybí AI kredity.");
  });

  it("zachová hotové části a dokončí jen chybějící", async () => {
    const blocks = Array.from({ length: 40 }, (_, i) => `Odstavec ${i}. Delší obsah větou.`);
    const input = blocks.join("\n\n");
    const total = splitText(input, TRANSLATE_CHUNK_CHARS).length;
    const initialParts = Array.from({ length: total }, (_, i) => (i === 0 ? "hotovo0" : ""));
    const fetchMock = vi.fn(async () => sseResponse("novy"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await processLongText("/api/translate", input, {
      limit: TRANSLATE_CHUNK_CHARS,
      initialParts,
    });
    expect(fetchMock).toHaveBeenCalledTimes(total - 1);
    expect(result.parts[0]).toBe("hotovo0");
    expect(result.failed).toBe(0);
  });

  it("prázdný text nikam neodesílá", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await processLongText("/api/translate", "", {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.failed).toBe(0);
  });
});
