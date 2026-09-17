import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  Square,
  Loader2,
  Copy,
  Download,
  Trash2,
  FileAudio,
  Upload,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { encodeWav, formatDuration } from "@/lib/wav";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Zápisník – nahrávání rozhovorů a AI přepisy" },
      {
        name: "description",
        content:
          "Nahrajte rozhovor přímo v prohlížeči a nechte si ho automaticky přepsat do textu pomocí AI.",
      },
      { property: "og:title", content: "Zápisník – nahrávání rozhovorů a AI přepisy" },
      {
        property: "og:description",
        content: "Nahrajte rozhovor a získejte přesný textový přepis za pár sekund.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

type Recording = {
  id: string;
  createdAt: number;
  duration: number;
  transcript: string;
  status: "running" | "done" | "error";
  error?: string;
  title?: string;
  summary?: string;
  summaryStatus?: "running" | "done" | "error";
  summaryError?: string;
};

const STORAGE_KEY = "zapisnik.recordings";
const LANGS = [
  { value: "auto", label: "Automaticky" },
  { value: "cs", label: "Čeština" },
  { value: "en", label: "Angličtina" },
  { value: "sk", label: "Slovenština" },
  { value: "de", label: "Němčina" },
];

function Index() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [language, setLanguage] = useState("auto");
  const [level, setLevel] = useState(0);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setRecordings(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const persist = useCallback((next: Recording[]) => {
    setRecordings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const update = useCallback((id: string, patch: Partial<Recording>) => {
    setRecordings((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [isRecording]);

  const transcribe = useCallback(
    async (blob: Blob, id: string) => {
      const body = new FormData();
      body.append("file", blob, "recording.wav");
      body.append("language", language);

      try {
        const res = await fetch("/api/transcribe", { method: "POST", body });
        if (!res.ok || !res.body) {
          let message = "Přepis se nepodařil.";
          try {
            const data = (await res.json()) as { error?: string };
            if (data?.error) message = data.error;
          } catch {
            /* ignore */
          }
          update(id, { status: "error", error: message });
          toast.error(message);
          return;
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let text = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const event = JSON.parse(payload) as {
                type: string;
                delta?: string;
                text?: string;
              };
              if (event.type === "transcript.text.delta" && event.delta) {
                text += event.delta;
                update(id, { transcript: text });
              } else if (event.type === "transcript.text.done") {
                text = event.text ?? text;
                update(id, { transcript: text, status: "done" });
              }
            } catch {
              /* ignore malformed event */
            }
          }
        }
        if (text.trim().length === 0) {
          update(id, { status: "error", error: "V nahrávce nebyla rozpoznána žádná řeč." });
        } else {
          update(id, { transcript: text, status: "done" });
        }
      } catch (err) {
        console.error(err);
        update(id, { status: "error", error: "Spojení se přerušilo." });
        toast.error("Spojení se přerušilo.");
      }
    },
    [language, update],
  );

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(4096, 1, 1);
      nodeRef.current = node;
      pcmRef.current = [];
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        pcmRef.current.push(new Float32Array(data));
        let peak = 0;
        for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i] ?? 0));
        setLevel(peak);
      };
      source.connect(node);
      node.connect(ctx.destination);
      setElapsed(0);
      setIsRecording(true);
    } catch {
      toast.error("Nepodařilo se získat přístup k mikrofonu.");
    }
  }, []);

  const stop = useCallback(async () => {
    setIsRecording(false);
    setLevel(0);
    const ctx = ctxRef.current;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    const sampleRate = ctx?.sampleRate ?? 48000;
    const chunks = pcmRef.current;
    pcmRef.current = [];
    await ctx?.close();
    ctxRef.current = null;

    const blob = encodeWav(chunks, sampleRate);
    if (blob.size < 2048) {
      toast.error("Nahrávka byla prázdná – zkuste to prosím znovu.");
      return;
    }

    const id = crypto.randomUUID();
    const entry: Recording = {
      id,
      createdAt: Date.now(),
      duration: elapsed,
      transcript: "",
      status: "running",
    };
    persist([entry, ...recordings]);
    void transcribe(blob, id);
  }, [elapsed, persist, recordings, transcribe]);

  const remove = (id: string) => persist(recordings.filter((r) => r.id !== id));

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Přepis zkopírován.");
  };

  const download = (rec: Recording) => {
    const url = URL.createObjectURL(new Blob([rec.transcript], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `prepis-${new Date(rec.createdAt).toISOString().slice(0, 16)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl px-5 py-10">
        <header className="mb-8">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Zápisník
          </p>
          <h1 className="mt-2 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            Nahrajte rozhovor, přepis dodá AI
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Stiskněte nahrávání, mluvte a po zastavení se text objeví sám. Vše zůstává jen ve vašem
            zařízení.
          </p>
        </header>

        <Card className="border-border/70 bg-card p-6 shadow-sm">
          <div className="flex flex-col items-center gap-5">
            <div className="relative flex h-28 w-28 items-center justify-center">
              {isRecording && (
                <span
                  className="absolute inset-0 rounded-full bg-primary/15 transition-transform duration-100"
                  style={{ transform: `scale(${1 + Math.min(level, 0.6)})` }}
                />
              )}
              <Button
                onClick={isRecording ? stop : start}
                size="icon"
                className="relative h-20 w-20 rounded-full"
                variant={isRecording ? "destructive" : "default"}
                aria-label={isRecording ? "Zastavit nahrávání" : "Začít nahrávat"}
              >
                {isRecording ? <Square className="h-7 w-7" /> : <Mic className="h-7 w-7" />}
              </Button>
            </div>

            <p className="font-display text-2xl tabular-nums text-foreground">
              {formatDuration(elapsed)}
            </p>

            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              Jazyk
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isRecording}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
              >
                {LANGS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Card>

        <section className="mt-10 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Vaše nahrávky
          </h2>

          {recordings.length === 0 && (
            <Card className="flex flex-col items-center gap-2 border-dashed bg-card/50 p-10 text-center">
              <FileAudio className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Zatím tu nic není.</p>
            </Card>
          )}

          {recordings.map((rec) => (
            <Card key={rec.id} className="space-y-3 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {new Date(rec.createdAt).toLocaleString("cs-CZ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Délka {formatDuration(rec.duration)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {rec.status === "done" && (
                    <>
                      <Button variant="ghost" size="icon" onClick={() => copy(rec.transcript)}>
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => download(rec)}>
                        <Download className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  <Button variant="ghost" size="icon" onClick={() => remove(rec.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {rec.status === "error" ? (
                <p className="text-sm text-destructive">{rec.error}</p>
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {rec.transcript}
                  {rec.status === "running" && (
                    <span className="ml-1 inline-flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      přepisuji…
                    </span>
                  )}
                </p>
              )}
            </Card>
          ))}
        </section>
      </div>
    </main>
  );
}
