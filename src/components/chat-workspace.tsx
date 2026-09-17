import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Mic,
  Square,
  Loader2,
  FileAudio,
  Upload,
  Pencil,
  Check,
  FolderPlus,
  ArrowUp,
  LogIn,
  LogOut,
  CloudUpload,
  Search,
  ChevronRight,
  Settings2,
  Library,
  Circle,
  Folder,
  AudioLines,
  CheckCircle2,
  AlertCircle,
  FileText,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  getSupabase,
  prefetchCloud,
  fetchCloudRecordings,
  upsertCloudRecording,
  deleteCloudRecording,
  uploadCloudAudio,
  downloadCloudAudio,
  fetchCloudGroups,
  addCloudGroup,
  deleteCloudGroup,
} from "@/lib/cloud-lazy";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RecordingDetail } from "@/components/recording-detail";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { encodeWav, formatDuration } from "@/lib/wav";
import { saveAudio, loadAudio, deleteAudio } from "@/lib/audio-store";

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

type ChatWorkspaceProps = {
  mode: "recorder" | "library";
};

export function ChatWorkspace({ mode }: ChatWorkspaceProps) {
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
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<{ duration: number } | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncedRef = useRef<Record<string, string>>({});
  const elapsedBaseRef = useRef(0);
  const pendingRef = useRef<{ chunks: Float32Array[]; sampleRate: number } | null>(null);
  const audioUrlsRef = useRef<Record<string, string>>({});

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
    audioUrlsRef.current = audioUrls;
  }, [audioUrls]);

  useEffect(
    () => () => Object.values(audioUrlsRef.current).forEach((url) => URL.revokeObjectURL(url)),
    [],
  );

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;
    prefetchCloud();
    void (async () => {
      const supabase = await getSupabase();
      if (cancelled) return;
      // Session je uložená v prohlížeči, takže uživatel zůstane přihlášený.
      // Pokud si přihlášení zapamatovat nechtěl, po zavření aplikace ho odhlásíme.
      let forget = false;
      try {
        forget =
          localStorage.getItem("zapisnik.remember") === "0" &&
          !sessionStorage.getItem("zapisnik.session-alive");
        sessionStorage.setItem("zapisnik.session-alive", "1");
      } catch {
        /* ignore */
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;
      // Po návratu z Google se aplikace načte v nové záložce, kde sessionStorage chybí.
      // Čerstvou session proto nikdy neodhlašujeme.
      const fresh =
        !!session &&
        typeof session.expires_at === "number" &&
        session.expires_at * 1000 - Date.now() > 45 * 60 * 1000;
      if (forget && session && !fresh) {
        await supabase.auth.signOut();
        return;
      }
      const sessionUser = session?.user;
      if (sessionUser && !cancelled) {
        setUser({ id: sessionUser.id, email: sessionUser.email ?? "" });
      }


      const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
          setUser(null);
          syncedRef.current = {};
          return;
        }
        if (session?.user) setUser({ id: session.user.id, email: session.user.email ?? "" });
      });
      unsub = () => sub.subscription.unsubscribe();
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
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
      return prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
    });
  }, []);

  // AI posílá text po malých částech. Zápis do úložiště proto slučujeme,
  // aby dlouhý přepis neblokoval ovládání aplikace při každém slově.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recordings));
      } catch {
        /* ignore */
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [recordings]);

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

  const start = useCallback(async (resume = false) => {
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
      pcmRef.current = resume ? (pendingRef.current?.chunks ?? []) : [];
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        pcmRef.current.push(new Float32Array(data));
        let peak = 0;
        for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i] ?? 0));
        setLevel(peak);
      };
      source.connect(node);
      node.connect(ctx.destination);
      if (!resume) elapsedBaseRef.current = 0;
      setElapsed(elapsedBaseRef.current);
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

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    if (total / sampleRate < 0.3) {
      toast.error("Nahrávka byla prázdná – zkuste to prosím znovu.");
      elapsedBaseRef.current = 0;
      setElapsed(0);
      return;
    }

    pendingRef.current = { chunks, sampleRate };
    elapsedBaseRef.current = elapsed;
    setPending({ duration: elapsed });
  }, [elapsed]);

  const savePending = useCallback(() => {
    const held = pendingRef.current;
    if (!held) return;
    pendingRef.current = null;
    setPending(null);
    const blob = encodeWav(held.chunks, held.sampleRate);
    const group = filter !== "all" && filter !== "none" ? filter : "";
    const id = crypto.randomUUID();
    const filename = `nahravka-${new Date().toISOString().slice(0, 16).replace(":", "-")}.wav`;
    const entry: Recording = {
      id,
      createdAt: Date.now(),
      duration: elapsedBaseRef.current,
      transcript: "",
      status: "running",
      hasAudio: true,
      audioName: filename,
      group,
    };
    persist([entry, ...recordings]);
    void storeAudio(id, blob, filename);
    void transcribe(blob, id);
    elapsedBaseRef.current = 0;
    setElapsed(0);
    toast.success(group ? `Uloženo do složky „${group}“.` : "Uloženo mezi nahrávky bez složky.");
  }, [filter, persist, recordings, storeAudio, transcribe]);

  const continuePending = useCallback(() => {
    setPending(null);
    void start(true);
  }, [start]);

  const discardPending = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
    elapsedBaseRef.current = 0;
    setElapsed(0);
    toast("Nahrávka zahozena.");
  }, []);


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
    const audioUrl = audioUrls[id];
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrls((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
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

  const visible = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase("cs");
    return recordings.filter((recording) => {
      const inGroup =
        filter === "all" ||
        (filter === "none" && !recording.group) ||
        recording.group === filter;
      if (!inGroup) return false;
      if (!normalizedSearch) return true;
      return [recording.title, recording.transcript, recording.summary, recording.group]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase("cs").includes(normalizedSearch));
    });
  }, [filter, recordings, search]);

  const selected = useMemo(
    () => recordings.find((recording) => recording.id === selectedId) ?? null,
    [recordings, selectedId],
  );

  const processingCount = useMemo(
    () =>
      recordings.filter(
        (recording) =>
          recording.status === "running" ||
          recording.refineStatus === "running" ||
          recording.summaryStatus === "running",
      ).length,
    [recordings],
  );

  const processingRecordings = useMemo(
    () =>
      recordings.filter(
        (recording) =>
          recording.status === "running" ||
          recording.refineStatus === "running" ||
          recording.summaryStatus === "running",
      ),
    [recordings],
  );

  const groupCounts = useMemo(
    () =>
      recordings.reduce<Record<string, number>>((counts, recording) => {
        if (recording.group) counts[recording.group] = (counts[recording.group] ?? 0) + 1;
        return counts;
      }, {}),
    [recordings],
  );

  const openRecording = (id: string) => {
    setSelectedId(id);
    window.requestAnimationFrame(() => {
      document.getElementById("recording-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="min-h-dvh bg-background pb-24 sm:pb-10">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto grid min-h-16 w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex min-w-0 items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><AudioLines className="size-5" aria-hidden="true" /></span>
            <span className="min-w-0">
              <span className="block truncate font-display text-base font-semibold text-foreground">Chat Scribe</span>
              <span className="block truncate text-xs text-muted-foreground">Rozhovory → přepisy → shrnutí</span>
            </span>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            <nav className="hidden items-center gap-1 md:flex" aria-label="Hlavní navigace">
              <Button variant={mode === "recorder" ? "secondary" : "ghost"} asChild><Link to="/"><Mic aria-hidden="true" /> Nahrávat</Link></Button>
              <Button variant={mode === "library" ? "secondary" : "ghost"} asChild><Link to="/transcripts"><Library aria-hidden="true" /> Přepisy</Link></Button>
              <Button variant="ghost" asChild><Link to="/" hash="settings"><Settings2 aria-hidden="true" /> Nastavení</Link></Button>
            </nav>
            {user ? (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="hidden max-w-32 truncate lg:inline">{user.email}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="min-h-11 min-w-11"
                  aria-label="Odhlásit se"
                  onClick={() =>
                    void getSupabase().then((sb) => sb.auth.signOut())
                  }
                >
                  <LogOut aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Button variant="outline" className="min-h-11" asChild>
                <Link to="/auth">
                  <LogIn aria-hidden="true" /><span className="hidden sm:inline">Přihlásit se</span>
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {mode === "recorder" ? (
        <section id="record" className="scroll-mt-24 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="grid lg:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
            <div className="flex flex-col items-center justify-center p-6 text-center sm:p-10">
              <p className="mb-2 text-sm font-medium text-primary">Nová nahrávka</p>
              <h1 className="font-display text-2xl font-semibold text-foreground sm:text-3xl">Zachyťte rozhovor. O zbytek se postará AI.</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">Po zastavení nahrávku uložíte a přepis, jazyková korektura i shrnutí se připraví automaticky.</p>

              <div className="relative mt-7 flex h-32 w-32 items-center justify-center">
              {isRecording && (
                <span
                    className="absolute inset-0 rounded-full bg-destructive/10 transition-transform duration-100 motion-reduce:transform-none"
                  style={{ transform: `scale(${1 + Math.min(level, 0.6)})` }}
                />
              )}
              <Button
                onClick={() => void (isRecording ? stop() : start())}
                size="icon"
                  className="relative h-24 w-24 rounded-full shadow-lg"
                variant={isRecording ? "destructive" : "default"}
                aria-label={isRecording ? "Zastavit nahrávání" : "Začít nahrávat"}
              >
                  {isRecording ? <Square className="size-8" aria-hidden="true" /> : <Mic className="size-8" aria-hidden="true" />}
              </Button>
            </div>
              <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-foreground" aria-live="off">
              {formatDuration(elapsed)}
              </p>
              <div className="mt-2 flex items-center gap-2 text-sm" aria-live="polite">
                <Circle className={`size-2.5 ${isRecording ? "fill-destructive text-destructive" : "fill-muted-foreground text-muted-foreground"}`} aria-hidden="true" />
                <span className={isRecording ? "font-medium text-destructive" : "text-muted-foreground"}>{isRecording ? "Nahrávání probíhá — klepnutím zastavíte" : "Připraveno k nahrávání"}</span>
              </div>
              {isRecording ? <Progress value={Math.min(100, level * 180)} className="mt-5 max-w-sm" aria-label="Hlasitost mikrofonu" /> : null}
            </div>

            <aside id="settings" className="scroll-mt-24 border-t border-border bg-muted/30 p-5 lg:border-l lg:border-t-0 sm:p-6">
              <div className="flex items-center gap-2"><Settings2 className="size-4 text-primary" aria-hidden="true" /><h2 className="font-display text-base font-semibold text-foreground">Nastavení nahrávky</h2></div>
              <div className="mt-5 space-y-5">
                <div className="space-y-2">
                  <label htmlFor="language" className="text-sm font-medium text-foreground">Jazyk rozhovoru</label>
                  <Select value={language} onValueChange={setLanguage} disabled={isRecording}>
                    <SelectTrigger id="language" className="h-11 bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent>{LANGS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label htmlFor="recording-folder" className="text-sm font-medium text-foreground">Uložit do složky</label>
                  <Select value={filter === "all" ? "none" : filter} onValueChange={(value) => setFilter(value)} disabled={isRecording}>
                    <SelectTrigger id="recording-folder" className="h-11 bg-background"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">Bez složky</SelectItem>{groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}</SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-muted-foreground">Nová nahrávka se uloží rovnou do vybrané složky.</p>
                </div>
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/webm,video/mp4"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
              <Button
                variant="outline"
                className="mt-6 min-h-11 w-full bg-background"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRecording}
              >
                <Upload aria-hidden="true" /> Importovat zvuk
              </Button>
              <p className="mt-2 text-center text-xs text-muted-foreground">MP3, WAV, M4A a další · max. 14 MB</p>
              <div className="mt-5 flex items-start gap-2 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">
                {syncing ? <CloudUpload className="mt-0.5 size-4 shrink-0 animate-pulse" aria-hidden="true" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />}
                <span>{user ? (syncing ? "Synchronizuji vaše záznamy…" : "Záznamy jsou dostupné na vašich zařízeních.") : "Bez přihlášení zůstanou záznamy pouze v tomto zařízení."}</span>
              </div>
            </aside>
          </div>
        </section>

        ) : null}

        {mode === "recorder" ? (
          <section className="mx-auto mt-6 max-w-3xl" aria-label="Aktuální zpracování">
            {processingRecordings.length > 0 ? (
              <div className="rounded-lg border border-border bg-card p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
                    <div>
                      <h2 className="font-display text-sm font-semibold text-foreground">Zpracování nahrávky</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {processingRecordings[0]?.status === "running" ? "Přepisuji zvuk…" : processingRecordings[0]?.refineStatus === "running" ? "Upravuji češtinu…" : "Tvořím AI shrnutí…"}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary">{processingCount}</Badge>
                </div>
                <Progress value={processingRecordings[0]?.status === "running" ? 35 : processingRecordings[0]?.refineStatus === "running" ? 65 : 85} className="mt-4 h-1.5" aria-label="Průběh zpracování" />
              </div>
            ) : null}
            <div className="mt-5 flex justify-center">
              <Button variant="ghost" className="min-h-11 text-muted-foreground" asChild>
                <Link to="/transcripts"><Library aria-hidden="true" /> Zobrazit přepisy <ChevronRight aria-hidden="true" /></Link>
              </Button>
            </div>
          </section>
        ) : (
        <section id="transcripts" className="scroll-mt-24">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
            <div className="min-w-0"><p className="text-sm font-medium text-primary">Knihovna</p><h2 className="truncate font-display text-2xl font-semibold text-foreground">Nahrávky a přepisy</h2></div>
            <Badge variant="secondary">{recordings.length} {recordings.length === 1 ? "záznam" : "záznamů"}</Badge>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="relative block min-w-0">
              <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="h-11 bg-card pl-9" placeholder="Hledat v názvech, přepisech a shrnutích…" aria-label="Hledat v nahrávkách a přepisech" />
            </label>
            <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1" role="group" aria-label="Filtrovat podle složky">
              <Button
                variant={filter === "all" ? "default" : "outline"}
                className="min-h-11 shrink-0"
                onClick={() => setFilter("all")}
              >
                Vše
              </Button>
              {groups.map((g) => (
                <span key={g} className="flex shrink-0 items-center">
                  <Button
                    variant={filter === g ? "default" : "outline"}
                    className="min-h-11"
                    onClick={() => setFilter(g)}
                  >
                    <Folder aria-hidden="true" />{g}
                    <span className="ml-1 text-xs opacity-70">
                      {groupCounts[g] ?? 0}
                    </span>
                  </Button>
                  {filter === g && (
                    <Button
                      variant="ghost"
                      size="icon" className="min-h-11 min-w-11"
                      aria-label={`Smazat skupinu ${g}`}
                      onClick={() => removeGroup(g)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </span>
              ))}
              <Button variant={filter === "none" ? "default" : "outline"} className="min-h-11 shrink-0" onClick={() => setFilter("none")}>Bez složky</Button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addGroup();
                }}
                placeholder="Název nové složky"
                aria-label="Název nové složky"
                className="h-11 bg-card"
              />
              <Button variant="outline" className="min-h-11" onClick={addGroup}>
                <FolderPlus aria-hidden="true" /> Přidat složku
              </Button>
          </div>

          {visible.length === 0 && recordings.length > 0 && (
            <div className="mt-5 rounded-lg border border-dashed border-border bg-card p-10 text-center"><Search className="mx-auto size-6 text-muted-foreground" aria-hidden="true" /><p className="mt-3 font-medium text-foreground">Nic jsme nenašli</p><p className="mt-1 text-sm text-muted-foreground">Zkuste jiný výraz nebo jinou složku.</p></div>
          )}

          {recordings.length === 0 && (
            <div className="mt-5 flex flex-col items-center rounded-lg border border-dashed border-border bg-card p-10 text-center"><FileAudio className="size-8 text-primary" aria-hidden="true" /><p className="mt-3 font-medium text-foreground">Vaše první nahrávka začne tady</p><p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">Klepněte nahoře na mikrofon, nahrajte rozhovor a po zastavení se zde objeví přepis.</p><Button className="mt-5 min-h-11" asChild><a href="#record"><Mic aria-hidden="true" /> Začít nahrávat</a></Button></div>
          )}

          <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.25fr)]">
            <div className="space-y-2" aria-label="Seznam nahrávek">
            {visible.map((rec) => {
              const isProcessing = rec.status === "running" || rec.refineStatus === "running" || rec.summaryStatus === "running";
              return (
              <article key={rec.id} className={`rounded-lg border bg-card p-4 shadow-sm transition-colors ${selectedId === rec.id ? "border-primary" : "border-border hover:border-primary/50"}`}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
                  <div className="min-w-0">
                  {editingId === rec.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(rec.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        aria-label="Název nahrávky"
                        className="h-11 min-w-0 flex-1"
                      />
                      <Button size="icon" className="min-h-11 min-w-11" aria-label="Uložit nový název" onClick={() => saveRename(rec.id)}>
                        <Check aria-hidden="true" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      onClick={() => startRename(rec)}
                      className="h-auto max-w-full justify-start gap-2 p-0 text-left hover:bg-transparent"
                    >
                      <span className="truncate text-sm font-medium text-foreground">
                        {rec.title || new Date(rec.createdAt).toLocaleString("cs-CZ")}
                      </span>
                      <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Button>
                  )}
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {new Date(rec.createdAt).toLocaleDateString("cs-CZ", { day: "numeric", month: "short", year: "numeric" })} · {formatDuration(rec.duration)}{rec.group ? ` · ${rec.group}` : ""}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    {isProcessing ? <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" /> : rec.status === "error" ? <AlertCircle className="size-4 text-destructive" aria-hidden="true" /> : <CheckCircle2 className="size-4 text-primary" aria-hidden="true" />}
                    <span className={`text-xs font-medium ${rec.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{rec.status === "error" ? "Přepis selhal" : rec.status === "running" ? "Přepisuji zvuk…" : rec.refineStatus === "running" ? "Upravuji češtinu…" : rec.summaryStatus === "running" ? "Tvořím shrnutí…" : "Přepis je připravený"}</span>
                  </div>
                  {isProcessing ? <Progress value={rec.status === "running" ? 35 : rec.refineStatus === "running" ? 65 : 85} className="mt-2 h-1.5" aria-label="Průběh zpracování" /> : null}
                </div>
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label={`Otevřít ${rec.title || "nahrávku"}`} onClick={() => openRecording(rec.id)}><ChevronRight aria-hidden="true" /></Button>
              </div>
              </article>
            )})}
            </div>

            <div id="recording-detail" className="scroll-mt-24 lg:sticky lg:top-24">
              {selected ? (
                <RecordingDetail
                  key={selected.id}
                  recording={selected}
                  audioUrl={audioUrls[selected.id]}
                  onClose={() => setSelectedId(null)}
                  onCopy={(text) => void copy(text)}
                  onDelete={() => { remove(selected.id); setSelectedId(null); }}
                  onExportAudio={() => void exportAudio(selected)}
                  onExportTranscript={() => exportText(selected, "transcript")}
                  onExportSummary={() => exportText(selected, "summary")}
                  onRefreshSummary={() => void summarize(selected.transcript, selected.id)}
                  onTogglePlayer={() => void togglePlayer(selected)}
                  onUpdateTranscript={(text) => update(selected.id, { transcript: text, status: "done" })}
                />
              ) : visible.length > 0 ? (
                <div className="hidden min-h-80 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card p-8 text-center lg:flex"><FileText className="size-8 text-primary" aria-hidden="true" /><p className="mt-3 font-medium text-foreground">Otevřete některý přepis</p><p className="mt-1 max-w-xs text-sm leading-6 text-muted-foreground">Vyberte nahrávku vlevo a zobrazí se shrnutí, celý text i všechny exporty.</p></div>
              ) : null}
            </div>
          </div>
        </section>
        )}
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border bg-background/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:hidden" aria-label="Mobilní navigace">
        <Button variant={mode === "recorder" ? "secondary" : "ghost"} className="h-12 flex-col gap-1 text-xs" asChild><Link to="/"><Mic aria-hidden="true" />Nahrávat</Link></Button>
        <Button variant={mode === "library" ? "secondary" : "ghost"} className="h-12 flex-col gap-1 text-xs" asChild><Link to="/transcripts"><Library aria-hidden="true" />Přepisy{processingCount > 0 ? <span className="sr-only">, {processingCount} se zpracovává</span> : null}</Link></Button>
        <Button variant="ghost" className="h-12 flex-col gap-1 text-xs" asChild><Link to="/" hash="settings"><Settings2 aria-hidden="true" />Nastavení</Link></Button>
      </nav>

      {showBack && (
        <Button
          size="icon"
          aria-label="Zpět nahoru"
          className="fixed bottom-24 right-4 h-11 w-11 rounded-full shadow-lg sm:bottom-6 sm:right-6"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowUp className="h-5 w-5" />
        </Button>
      )}

      <AlertDialog open={pending !== null}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uložit nahrávku?</AlertDialogTitle>
            <AlertDialogDescription>
              Nahrávka je dlouhá {formatDuration(pending?.duration ?? 0)}. Uložit ji{" "}
              {filter !== "all" && filter !== "none"
                ? `do složky „${filter}“`
                : "mezi nahrávky bez složky"}
              , nebo pokračovat v nahrávání?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-between">
            <Button variant="ghost" onClick={discardPending}>
              Zahodit
            </Button>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={continuePending}>
                Pokračovat v nahrávání
              </Button>
              <Button onClick={savePending}>Uložit</Button>
            </div>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>

  );
}
