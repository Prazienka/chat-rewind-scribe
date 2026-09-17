import { createFileRoute, Link } from "@tanstack/react-router";
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
  Pencil,
  Check,
  FolderPlus,
  FolderOpen,
  ArrowUp,
  Music,
  FileText,
  WandSparkles,
  Play,
  X,
  Eye,
  EyeOff,
  LogIn,
  LogOut,
  CloudUpload,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  fetchCloudRecordings,
  upsertCloudRecording,
  deleteCloudRecording,
  uploadCloudAudio,
  downloadCloudAudio,
  fetchCloudGroups,
  addCloudGroup,
  deleteCloudGroup,
} from "@/lib/cloud";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { encodeWav, formatDuration } from "@/lib/wav";
import { saveAudio, loadAudio, deleteAudio } from "@/lib/audio-store";

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
  rawTranscript?: string;
  refineStatus?: "running" | "done" | "error";
  summary?: string;
  summaryStatus?: "running" | "done" | "error";
  summaryError?: string;
  group?: string;
  hasAudio?: boolean;
  audioName?: string;
  audioPath?: string;
};

const STORAGE_KEY = "zapisnik.recordings";
const GROUPS_KEY = "zapisnik.groups";
const LANGS = [
  { value: "cs", label: "Čeština" },
  { value: "auto", label: "Automaticky" },
  { value: "en", label: "Angličtina" },
  { value: "sk", label: "Slovenština" },
  { value: "de", label: "Němčina" },
];

function Index() {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [language, setLanguage] = useState("cs");
  const [level, setLevel] = useState(0);
  const [groups, setGroups] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [showBack, setShowBack] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [openTranscript, setOpenTranscript] = useState<Record<string, boolean>>({});
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<{ duration: number } | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncedRef = useRef<Record<string, string>>({});
  const elapsedBaseRef = useRef(0);
  const pendingRef = useRef<{ chunks: Float32Array[]; sampleRate: number } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setRecordings(JSON.parse(raw));
      const rawGroups = localStorage.getItem(GROUPS_KEY);
      if (rawGroups) setGroups(JSON.parse(rawGroups));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser({ id: data.user.id, email: data.user.email ?? "" });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        setUser(null);
        syncedRef.current = {};
        return;
      }
      if (session?.user) setUser({ id: session.user.id, email: session.user.email ?? "" });
    });
    return () => sub.subscription.unsubscribe();
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

  // Po přihlášení stáhnout cloudová data a nahrát to, co je jen v zařízení.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setSyncing(true);
    void (async () => {
      try {
        const [cloud, cloudGroups] = await Promise.all([
          fetchCloudRecordings(),
          fetchCloudGroups(),
        ]);
        if (cancelled) return;
        for (const rec of cloud) syncedRef.current[rec.id] = JSON.stringify(rec);
        setRecordings((prev) => {
          const map = new Map<string, Recording>();
          for (const rec of cloud) map.set(rec.id, rec as Recording);
          for (const rec of prev) if (!map.has(rec.id)) map.set(rec.id, rec);
          const merged = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
          } catch {
            /* ignore */
          }
          return merged;
        });
        setGroups((prev) => {
          const merged = [...new Set([...cloudGroups, ...prev])];
          try {
            localStorage.setItem(GROUPS_KEY, JSON.stringify(merged));
          } catch {
            /* ignore */
          }
          for (const name of merged) {
            if (!cloudGroups.includes(name)) void addCloudGroup(user.id, name).catch(() => {});
          }
          return merged;
        });
      } catch {
        toast.error("Nepodařilo se načíst nahrávky z cloudu.");
      } finally {
        if (!cancelled) setSyncing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Průběžně posílat změny do cloudu.
  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      for (const rec of recordings) {
        if (rec.status === "running" || rec.summaryStatus === "running") continue;
        const snapshot = JSON.stringify({
          id: rec.id,
          createdAt: rec.createdAt,
          duration: rec.duration,
          transcript: rec.transcript,
          status: rec.status,
          title: rec.title ?? "",
          rawTranscript: rec.rawTranscript ?? "",
          summary: rec.summary ?? "",
          group: rec.group ?? "",
          audioName: rec.audioName ?? "",
          audioPath: rec.audioPath ?? "",
        });
        if (syncedRef.current[rec.id] === snapshot) continue;
        syncedRef.current[rec.id] = snapshot;
        void upsertCloudRecording(user.id, rec).catch(() => {
          delete syncedRef.current[rec.id];
        });
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [recordings, user]);

  const storeAudio = useCallback(
    async (id: string, blob: Blob, filename: string) => {
      await saveAudio(id, blob, filename);
      if (!user) return;
      try {
        const path = await uploadCloudAudio(user.id, id, blob, filename);
        update(id, { audioPath: path });
      } catch {
        /* zvuk zůstane aspoň v zařízení */
      }
    },
    [update, user],
  );

  const getAudio = useCallback(async (rec: Recording) => {
    const local = await loadAudio(rec.id);
    if (local) return local;
    if (rec.audioPath) {
      const blob = await downloadCloudAudio(rec.audioPath);
      if (blob) return { blob, filename: rec.audioName || "nahravka.wav" };
    }
    return null;
  }, []);


  useEffect(() => {
    if (!isRecording) return;
    const started = Date.now();
    const base = elapsedBaseRef.current;
    const timer = setInterval(() => setElapsed(base + (Date.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [isRecording]);


  useEffect(() => {
    const onScroll = () => setShowBack(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const refine = useCallback(
    async (text: string, id: string): Promise<string> => {
      update(id, { rawTranscript: text, refineStatus: "running" });
      try {
        const res = await fetch("/api/refine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, language }),
        });
        if (!res.ok || !res.body) {
          update(id, { refineStatus: "error" });
          return text;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let refined = "";
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
              const event = JSON.parse(payload) as { type?: string; delta?: string };
              if (event.type === "response.output_text.delta" && event.delta) {
                refined += event.delta;
                update(id, { transcript: refined });
              }
            } catch {
              /* ignore malformed event */
            }
          }
        }
        if (refined.trim().length < Math.min(20, text.length / 4)) {
          update(id, { transcript: text, refineStatus: "error" });
          return text;
        }
        update(id, { transcript: refined.trim(), refineStatus: "done" });
        return refined.trim();
      } catch (err) {
        console.error(err);
        update(id, { transcript: text, refineStatus: "error" });
        return text;
      }
    },
    [language, update],
  );

  const summarize = useCallback(
    async (text: string, id: string) => {
      update(id, { summaryStatus: "running", summary: "", summaryError: "" });
      try {
        const res = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok || !res.body) {
          let message = "Shrnutí se nepodařilo.";
          try {
            const data = (await res.json()) as { error?: string };
            if (data?.error) message = data.error;
          } catch {
            /* ignore */
          }
          update(id, { summaryStatus: "error", summaryError: message });
          return;
        }

        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let summary = "";
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
              const event = JSON.parse(payload) as { type?: string; delta?: string };
              if (event.type === "response.output_text.delta" && event.delta) {
                summary += event.delta;
                update(id, { summary });
              }
            } catch {
              /* ignore malformed event */
            }
          }
        }
        if (summary.trim().length === 0) {
          update(id, { summaryStatus: "error", summaryError: "Shrnutí se nepodařilo vytvořit." });
        } else {
          update(id, { summary, summaryStatus: "done" });
        }
      } catch (err) {
        console.error(err);
        update(id, { summaryStatus: "error", summaryError: "Spojení se přerušilo." });
      }
    },
    [update],
  );

  const transcribe = useCallback(
    async (blob: Blob, id: string, filename = "recording.wav") => {
      const body = new FormData();
      body.append("file", blob, filename);
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
          const refined = await refine(text, id);
          void summarize(refined, id);
        }
      } catch (err) {
        console.error(err);
        update(id, { status: "error", error: "Spojení se přerušilo." });
        toast.error("Spojení se přerušilo.");
      }
    },
    [language, refine, summarize, update],
  );

  const start = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Tento prohlížeč nahrávání nepodporuje. Zkuste Chrome nebo Safari.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
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
    } catch (err) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const name = (err as { name?: string })?.name ?? "";
      const inFrame = typeof window !== "undefined" && window.self !== window.top;
      if (name === "NotAllowedError" || name === "SecurityError") {
        toast.error(
          inFrame
            ? "Prohlížeč tu mikrofon nepovolil. Otevřete aplikaci v samostatné záložce a povolte mikrofon."
            : "Mikrofon je zakázaný. Povolte ho v nastavení prohlížeče u této stránky a zkuste to znovu.",
          { duration: 8000 },
        );
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        toast.error("Nenašel jsem žádný mikrofon. Připojte ho a zkuste to znovu.");
      } else if (name === "NotReadableError") {
        toast.error("Mikrofon právě používá jiná aplikace. Zavřete ji a zkuste to znovu.");
      } else {
        toast.error("Nepodařilo se získat přístup k mikrofonu.");
      }
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
    const filename = `nahravka-${new Date().toISOString().slice(0, 16).replace(":", "-")}.wav`;
    const entry: Recording = {
      id,
      createdAt: Date.now(),
      duration: elapsed,
      transcript: "",
      status: "running",
      hasAudio: true,
      audioName: filename,
    };
    persist([entry, ...recordings]);
    void storeAudio(id, blob, filename);
    void transcribe(blob, id);
  }, [elapsed, persist, recordings, storeAudio, transcribe]);

  const importFile = useCallback(
    async (file: File) => {
      if (file.size > 14 * 1024 * 1024) {
        toast.error("Soubor je příliš velký (max 14 MB).");
        return;
      }
      let duration = 0;
      try {
        duration = await new Promise<number>((resolve) => {
          const audio = document.createElement("audio");
          audio.preload = "metadata";
          audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
          audio.onerror = () => resolve(0);
          audio.src = URL.createObjectURL(file);
        });
      } catch {
        /* ignore */
      }

      const id = crypto.randomUUID();
      const entry: Recording = {
        id,
        createdAt: Date.now(),
        duration,
        transcript: "",
        status: "running",
        title: file.name,
        hasAudio: true,
        audioName: file.name,
      };
      setRecordings((prev) => {
        const next = [entry, ...prev];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      void storeAudio(id, file, file.name);
      void transcribe(file, id, file.name);
    },
    [storeAudio, transcribe],
  );

  const remove = (id: string) => {
    const rec = recordings.find((r) => r.id === id);
    void deleteAudio(id);
    if (user) void deleteCloudRecording(id, rec?.audioPath || undefined).catch(() => {});
    delete syncedRef.current[id];
    persist(recordings.filter((r) => r.id !== id));
  };


  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Zkopírováno.");
  };

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const baseName = (rec: Recording) =>
    (rec.title?.replace(/\.[a-z0-9]+$/i, "") || new Date(rec.createdAt).toISOString().slice(0, 16))
      .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
      .trim() || "nahravka";

  const exportAudio = async (rec: Recording) => {
    const stored = await getAudio(rec);
    if (!stored) {
      toast.error("Zvukový záznam se nepodařilo najít.");
      return;
    }
    saveBlob(stored.blob, stored.filename || `${baseName(rec)}.wav`);
  };

  const togglePlayer = async (rec: Recording) => {
    const existing = audioUrls[rec.id];
    if (existing) {
      URL.revokeObjectURL(existing);
      setAudioUrls((prev) => {
        const next = { ...prev };
        delete next[rec.id];
        return next;
      });
      return;
    }
    const stored = await getAudio(rec);
    if (!stored) {
      toast.error("Zvukový záznam se nepodařilo najít.");
      return;
    }
    const url = URL.createObjectURL(stored.blob);
    setAudioUrls((prev) => ({ ...prev, [rec.id]: url }));
  };




  const exportText = (rec: Recording, kind: "transcript" | "summary") => {
    const text = kind === "transcript" ? rec.transcript : (rec.summary ?? "");
    if (!text.trim()) {
      toast.error(kind === "transcript" ? "Přepis není hotový." : "Shrnutí není hotové.");
      return;
    }
    const header = `${rec.title || "Nahrávka"} · ${new Date(rec.createdAt).toLocaleString("cs-CZ")}\n\n`;
    saveBlob(new Blob([header + text], { type: "text/plain;charset=utf-8" }), `${baseName(rec)}-${kind === "transcript" ? "prepis" : "shrnuti"}.txt`);
  };


  const persistGroups = (next: string[]) => {
    setGroups(next);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const addGroup = () => {
    const name = newGroup.trim();
    if (!name) return;
    if (groups.includes(name)) {
      toast.error("Skupina s tímto názvem už existuje.");
      return;
    }
    persistGroups([...groups, name]);
    if (user) void addCloudGroup(user.id, name).catch(() => {});
    setNewGroup("");
    setFilter(name);
    toast.success(`Skupina „${name}“ vytvořena.`);
  };

  const removeGroup = (name: string) => {
    persistGroups(groups.filter((g) => g !== name));
    if (user) void deleteCloudGroup(name).catch(() => {});
    persist(recordings.map((r) => (r.group === name ? { ...r, group: "" } : r)));
    setFilter("all");
  };


  const startRename = (rec: Recording) => {
    setEditingId(rec.id);
    setEditingTitle(rec.title ?? new Date(rec.createdAt).toLocaleString("cs-CZ"));
  };

  const saveRename = (id: string) => {
    const name = editingTitle.trim();
    update(id, { title: name });
    setEditingId(null);
  };

  const visible =
    filter === "all"
      ? recordings
      : filter === "none"
        ? recordings.filter((r) => !r.group)
        : recordings.filter((r) => r.group === filter);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-2xl px-5 py-10">
        <header className="mb-8">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
              Zápisník
            </p>
            {user ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {syncing && <CloudUpload className="h-3.5 w-3.5 animate-pulse" />}
                <span className="max-w-[10rem] truncate">{user.email}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void supabase.auth.signOut()}
                >
                  <LogOut className="mr-1 h-3.5 w-3.5" />
                  Odhlásit
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" asChild>
                <Link to="/auth">
                  <LogIn className="mr-1 h-3.5 w-3.5" />
                  Přihlásit se
                </Link>
              </Button>
            )}
          </div>
          <h1 className="mt-2 font-display text-3xl leading-tight text-foreground sm:text-4xl">
            Nahrajte rozhovor, přepis dodá AI
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Stiskněte nahrávání, mluvte a po zastavení se text objeví sám.{" "}
            {user
              ? "Vaše nahrávky se ukládají do cloudu a máte je na všech zařízeních."
              : "Přihlaste se a nahrávky budete mít na všech svých zařízeních."}
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

            <div className="w-full border-t border-border/60 pt-4 text-center">
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/webm,video/mp4"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRecording}
              >
                <Upload className="mr-2 h-4 w-4" />
                Nahrát zvukový soubor
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                MP3, WAV, M4A a další, do 14 MB.
              </p>
            </div>
          </div>
        </Card>


        <section className="mt-10 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Vaše nahrávky
          </h2>

          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <FolderOpen className="h-4 w-4 text-muted-foreground" />
              <Button
                variant={filter === "all" ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter("all")}
              >
                Vše
              </Button>
              {groups.map((g) => (
                <span key={g} className="flex items-center">
                  <Button
                    variant={filter === g ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter(g)}
                  >
                    {g}
                    <span className="ml-1 text-xs opacity-70">
                      {recordings.filter((r) => r.group === g).length}
                    </span>
                  </Button>
                  {filter === g && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Smazat skupinu ${g}`}
                      onClick={() => removeGroup(g)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </span>
              ))}
              <Button
                variant={filter === "none" ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter("none")}
              >
                Bez skupiny
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <input
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                }}
                placeholder="Název nové skupiny"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground"
              />
              <Button variant="outline" size="sm" onClick={addGroup}>
                <FolderPlus className="mr-2 h-4 w-4" />
                Přidat
              </Button>
            </div>
          </Card>

          {visible.length === 0 && recordings.length > 0 && (
            <Card className="border-dashed bg-card/50 p-8 text-center">
              <p className="text-sm text-muted-foreground">V této skupině není žádná nahrávka.</p>
            </Card>
          )}

          {recordings.length === 0 && (
            <Card className="flex flex-col items-center gap-2 border-dashed bg-card/50 p-10 text-center">
              <FileAudio className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Zatím tu nic není.</p>
            </Card>
          )}

          {visible.map((rec) => (
            <Card key={rec.id} className="space-y-3 p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editingId === rec.id ? (
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(rec.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                      />
                      <Button size="sm" onClick={() => saveRename(rec.id)}>
                        <Check className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRename(rec)}
                      className="flex w-full items-center gap-2 text-left"
                    >
                      <span className="truncate text-sm font-medium text-foreground">
                        {rec.title || new Date(rec.createdAt).toLocaleString("cs-CZ")}
                      </span>
                      <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    </button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {rec.title ? `${new Date(rec.createdAt).toLocaleString("cs-CZ")} · ` : ""}
                    Délka {formatDuration(rec.duration)}
                  </p>
                  <select
                    value={rec.group ?? ""}
                    onChange={(e) => update(rec.id, { group: e.target.value })}
                    className="mt-2 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                  >
                    <option value="">Bez skupiny</option>
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1">
                  {rec.status === "done" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Kopírovat přepis"
                      onClick={() => copy(rec.transcript)}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Smazat nahrávku"
                    onClick={() => remove(rec.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Download className="h-3.5 w-3.5" />
                  Export
                </span>
                {rec.hasAudio && (
                  <Button variant="outline" size="sm" onClick={() => void exportAudio(rec)}>
                    <Music className="mr-1.5 h-3.5 w-3.5" />
                    Zvuk
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rec.status !== "done"}
                  onClick={() => exportText(rec, "transcript")}
                >
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                  Celý přepis
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rec.summaryStatus !== "done"}
                  onClick={() => exportText(rec, "summary")}
                >
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                  AI shrnutí
                </Button>
              </div>

              {rec.hasAudio && (
                <div className="rounded-lg border border-border/60 p-3">
                  <Button variant="outline" size="sm" onClick={() => void togglePlayer(rec)}>
                    {audioUrls[rec.id] ? (
                      <>
                        <X className="mr-1.5 h-3.5 w-3.5" />
                        Zavřít přehrávač
                      </>
                    ) : (
                      <>
                        <Play className="mr-1.5 h-3.5 w-3.5" />
                        Přehrát záznam
                      </>
                    )}
                  </Button>
                  {audioUrls[rec.id] && (
                    <audio className="mt-3 w-full" controls src={audioUrls[rec.id]} />
                  )}
                </div>
              )}




              {rec.status === "error" ? (
                <p className="text-sm text-destructive">{rec.error}</p>
              ) : (
                <>
                  <div className="rounded-lg border border-border/70 bg-muted/40 p-4">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <Sparkles className="h-3.5 w-3.5" />
                        AI shrnutí
                      </p>
                      <div className="flex items-center gap-1">
                        {rec.summaryStatus === "done" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Kopírovat shrnutí"
                            onClick={() => copy(rec.summary ?? "")}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        {rec.status === "done" && rec.summaryStatus !== "running" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Vytvořit shrnutí znovu"
                            onClick={() => void summarize(rec.transcript, rec.id)}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {rec.summaryStatus === "error" ? (
                      <p className="text-sm text-destructive">{rec.summaryError}</p>
                    ) : rec.summary ? (
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                        {rec.summary}
                      </p>
                    ) : (
                      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                        {rec.summaryStatus === "running" || rec.status === "running" ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            připravuji shrnutí…
                          </>
                        ) : (
                          "Shrnutí ještě není k dispozici."
                        )}
                      </p>
                    )}
                  </div>

                  <div className="rounded-lg border border-border/70 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setOpenTranscript((prev) => ({ ...prev, [rec.id]: !prev[rec.id] }))
                        }
                      >
                        {openTranscript[rec.id] ? (
                          <>
                            <EyeOff className="mr-1.5 h-3.5 w-3.5" />
                            Skrýt celý přepis
                          </>
                        ) : (
                          <>
                            <Eye className="mr-1.5 h-3.5 w-3.5" />
                            Zobrazit celý přepis
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rec.status !== "done"}
                        onClick={() => exportText(rec, "transcript")}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        Exportovat přepis
                      </Button>
                    </div>

                    {rec.refineStatus === "running" && (
                      <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <WandSparkles className="h-3.5 w-3.5" />
                        dolaďuji češtinu, jména a čísla…
                      </p>
                    )}

                    {openTranscript[rec.id] && (
                      <>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                          {rec.transcript}
                          {rec.status === "running" && (
                            <span className="ml-1 inline-flex items-center gap-2 text-muted-foreground">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              přepisuji…
                            </span>
                          )}
                        </p>
                        {rec.rawTranscript && rec.rawTranscript !== rec.transcript && (
                          <details className="mt-3">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              Původní strojový přepis
                            </summary>
                            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                              {rec.rawTranscript}
                            </p>
                          </details>
                        )}
                      </>
                    )}
                  </div>

                </>
              )}
            </Card>
          ))}
        </section>
      </div>

      {showBack && (
        <Button
          size="icon"
          aria-label="Zpět nahoru"
          className="fixed bottom-6 right-6 h-11 w-11 rounded-full shadow-lg"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowUp className="h-5 w-5" />
        </Button>
      )}
    </main>
  );
}
