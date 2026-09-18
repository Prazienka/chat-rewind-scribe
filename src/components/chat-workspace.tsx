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
  Languages,
  RotateCcw,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import {
  getSupabase,
  prefetchCloud,
  fetchCloudRecordings,
  upsertCloudRecording,
  deleteCloudRecording,
  uploadCloudAudioChunks,
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
import {
  saveAudio,
  saveSegmentedAudio,
  loadAudio,
  deleteAudio,
  saveSegment,
  loadSegments,
  deleteSegments,
} from "@/lib/audio-store";
import {
  MAX_IMPORT_BYTES,
  MAX_RECORDING_SECONDS,
  RECORDING_CHECKPOINT_SECONDS,
  TARGET_RATE,
  coalesceWavChunks,
  fileToWavChunks,
  mergeWavBlobs,
  wavChunksDuration,
} from "@/lib/audio-chunks";
import { processLongText, transcribeChunks } from "@/lib/pipeline";

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
  stage?: "prepare" | "upload" | "transcribe" | "refine" | "summary" | "translate" | undefined;
  progress?: number;
  stageDetail?: string;
  chunkCount?: number;
  failedChunks?: number;
  translation?: string;
  translationLang?: string;
  translationStatus?: "running" | "done" | "error";
  translationError?: string;
  uploadProgress?: number;
  uploadStatus?: "running" | "done" | "error";
};

const STORAGE_KEY = "zapisnik.recordings";
const GROUPS_KEY = "zapisnik.groups";
const ACTIVE_GROUP_KEY = "zapisnik.active-group";
const DRAFT_KEY = "zapisnik.draft";
const LANGS = [
  { value: "cs", label: "Čeština" },
  { value: "auto", label: "Automaticky" },
  { value: "en", label: "Angličtina" },
  { value: "sk", label: "Slovenština" },
  { value: "de", label: "Němčina" },
];

const recoverInterruptedProcessing = (recording: Recording): Recording => {
  if (
    recording.status !== "running" &&
    !recording.stage &&
    recording.refineStatus !== "running" &&
    recording.summaryStatus !== "running" &&
    recording.translationStatus !== "running"
  ) {
    return recording;
  }
  return {
    ...recording,
    status: "error",
    stage: undefined,
    ...(recording.refineStatus === "running" ? { refineStatus: "error" as const } : {}),
    ...(recording.summaryStatus === "running" ? { summaryStatus: "error" as const } : {}),
    ...(recording.translationStatus === "running"
      ? { translationStatus: "error" as const }
      : {}),
    error: "Zpracování bylo přerušeno. Můžete bezpečně pokračovat tlačítkem Zkusit přepis znovu.",
  };
};

type WakeLockSentinel = { release: () => Promise<void> };

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
  const [recordingGroup, setRecordingGroup] = useState("none");
  const [showBack, setShowBack] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<
    { duration: number; segments: number; recovered?: boolean } | null
  >(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [backgroundNote, setBackgroundNote] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const pcmSamplesRef = useRef(0);
  const flushingRef = useRef(false);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const autoStopRequestedRef = useRef(false);
  const sampleRateRef = useRef(48000);
  const sessionIdRef = useRef<string | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncedRef = useRef<Record<string, string>>({});
  const elapsedBaseRef = useRef(0);
  const pendingRef = useRef<{ session: string; segments: Blob[]; seconds: number } | null>(null);
  const audioUrlsRef = useRef<Record<string, string>>({});

  // Mikrofon uvolníme teprve při odchodu ze stránky, ne po dokončení nahrávky.
  useEffect(
    () => () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    },
    [],
  );


  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as Recording[];
        setRecordings(stored.map(recoverInterruptedProcessing));
      }
      const rawGroups = localStorage.getItem(GROUPS_KEY);
      if (rawGroups) setGroups(JSON.parse(rawGroups));
      const activeGroup = localStorage.getItem(ACTIVE_GROUP_KEY);
      if (activeGroup) setRecordingGroup(activeGroup);
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
          for (const rec of cloud) map.set(rec.id, recoverInterruptedProcessing(rec as Recording));
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
        if (rec.stage || rec.translationStatus === "running") continue;
        const snapshot = JSON.stringify({
          id: rec.id,
          createdAt: rec.createdAt,
          duration: rec.duration,
          transcript: rec.transcript,
          status: rec.status,
          title: rec.title ?? "",
          rawTranscript: rec.rawTranscript ?? "",
          summary: rec.summary ?? "",
          translation: rec.translation ?? "",
          translationLang: rec.translationLang ?? "",
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
    const timer = setInterval(() => {
      const value = base + (Date.now() - started) / 1000;
      elapsedRef.current = value;
      setElapsed(value);
    }, 250);
    return () => clearInterval(timer);
  }, [isRecording]);


  useEffect(() => {
    const onScroll = () => setShowBack(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Dlouhý přepis posíláme na korekturu po částech a spojíme zpět v původním pořadí.
  const refine = useCallback(
    async (text: string, id: string): Promise<string> => {
      update(id, {
        rawTranscript: text,
        refineStatus: "running",
        stage: "refine",
        progress: 0,
        stageDetail: "",
      });
      const { text: refined, failed } = await processLongText("/api/refine", text, {
        payload: { language },
        preserveInputOnFailure: true,
        onPartial: (partial) => update(id, { transcript: partial }),
        onProgress: (progress) =>
          update(id, {
            progress: progress.percent,
            stageDetail: progress.total > 1 ? `${progress.done}/${progress.total}` : "",
          }),
      });
      if (!refined.trim()) {
        update(id, { transcript: text, refineStatus: "error" });
        return text;
      }
      update(id, { transcript: refined, refineStatus: failed > 0 ? "error" : "done" });
      return refined;
    },
    [language, update],
  );

  const summarize = useCallback(
    async (text: string, id: string) => {
      if (!text.trim()) return;
      update(id, {
        summaryStatus: "running",
        summary: "",
        summaryError: "",
        stage: "summary",
        progress: 0,
        stageDetail: "",
      });
      const { text: summary, failed } = await processLongText("/api/summarize", text, {
        limit: 12000,
        onPartial: (partial) => update(id, { summary: partial }),
        onProgress: (progress) =>
          update(id, {
            progress: progress.percent,
            stageDetail: progress.total > 1 ? `${progress.done}/${progress.total}` : "",
          }),
      });
      if (!summary.trim() || failed > 0) {
        update(id, {
          summaryStatus: "error",
          summaryError: "Shrnutí se nepodařilo dokončit. Zkuste ho vytvořit znovu.",
          stage: undefined,
        });
        return;
      }
      update(id, { summary, summaryStatus: "done", stage: undefined, progress: 100 });
    },
    [update],
  );

  const translate = useCallback(
    async (rec: Recording, target: string) => {
      if (!rec.transcript.trim()) {
        toast.error("Nejdřív je potřeba hotový přepis.");
        return;
      }
      update(rec.id, {
        translationStatus: "running",
        translation: "",
        translationLang: target,
        translationError: "",
        stage: "translate",
        progress: 0,
        stageDetail: "",
      });
      const { text, failed } = await processLongText("/api/translate", rec.transcript, {
        payload: { target },
        onPartial: (partial) => update(rec.id, { translation: partial }),
        onProgress: (progress) =>
          update(rec.id, {
            progress: progress.percent,
            stageDetail: progress.total > 1 ? `${progress.done}/${progress.total}` : "",
          }),
      });
      if (!text.trim()) {
        update(rec.id, {
          translationStatus: "error",
          translationError: "Překlad se nepodařil. Zkuste to prosím znovu.",
          stage: undefined,
        });
        return;
      }
      update(rec.id, {
        translation: text,
        translationStatus: failed > 0 ? "error" : "done",
        ...(failed > 0
          ? { translationError: `${failed} část(i) se nepodařilo přeložit – zkuste to znovu.` }
          : {}),
        stage: undefined,
        progress: 100,
      });
    },
    [update],
  );

  // Hlavní zpracování: segmenty → přepis → česká korektura → shrnutí.
  const runPipeline = useCallback(
    async (id: string, chunks: Blob[], lang: string) => {
      if (chunks.length === 0) {
        update(id, { status: "error", error: "Nahrávka neobsahuje žádný zvuk." });
        return;
      }
      update(id, {
        status: "running",
        error: "",
        stage: "transcribe",
        progress: 0,
        chunkCount: chunks.length,
        failedChunks: 0,
        stageDetail: chunks.length > 1 ? `0/${chunks.length}` : "",
      });
      const result = await transcribeChunks(chunks, lang, {
        onPartial: (text) => update(id, { transcript: text }),
        onProgress: (progress) =>
          update(id, {
            progress: progress.percent,
            stageDetail: progress.total > 1 ? `${progress.done}/${progress.total}` : "",
          }),
      });
      if (!result.text.trim()) {
        update(id, {
          status: "error",
          stage: undefined,
          error: "V nahrávce nebyla rozpoznána žádná řeč nebo se přepis nepodařil.",
        });
        return;
      }
      update(id, {
        transcript: result.text,
        status: "done",
        failedChunks: result.failed.length,
      });
      if (result.failed.length > 0) {
        toast.error(
          `${result.failed.length} část se nepodařilo přepsat. V detailu můžete zpracování zkusit znovu.`,
          { duration: 10000 },
        );
      }
      const refined = await refine(result.text, id);
      await summarize(refined, id);
    },
    [refine, summarize, update],
  );

  // Opakování celého zpracování ze uloženého zvuku (po chybě nebo chybějící části).
  const retry = useCallback(
    async (rec: Recording) => {
      update(rec.id, { status: "running", error: "", stage: "prepare", progress: 0 });
      const stored = await getAudio(rec);
      if (!stored) {
        update(rec.id, {
          status: "error",
          stage: undefined,
          error: "Zvukový záznam už není k dispozici, přepis nelze zopakovat.",
        });
        return;
      }
      try {
        const chunks = await fileToWavChunks(stored.blob);
        await runPipeline(rec.id, chunks, language);
      } catch {
        update(rec.id, {
          status: "error",
          stage: undefined,
          error: "Zvuk se nepodařilo připravit k přepisu.",
        });
      }
    },
    [getAudio, language, runPipeline, update],
  );

  /** Uloží nasbíraný zvuk jako další bezpečný segment a uvolní paměť. */
  const flushBuffer = useCallback(async () => {
    const buffer = pcmRef.current;
    pcmRef.current = [];
    pcmSamplesRef.current = 0;
    if (buffer.length === 0) return;
    const blob = encodeWav(buffer, sampleRateRef.current, TARGET_RATE);
    const index = segmentsRef.current.length;
    segmentsRef.current.push(blob);
    setSegmentCount(segmentsRef.current.length);
    const session = sessionIdRef.current;
    if (!session) return;
    await saveSegment(session, index, blob);
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ session, seconds: elapsedRef.current, segments: index + 1 }),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const queueFlush = useCallback(() => {
    if (flushingRef.current || pcmRef.current.length === 0) return flushPromiseRef.current;
    flushingRef.current = true;
    const task = flushBuffer()
      .catch(() => {
        setBackgroundNote(
          "Část nahrávky se nepodařilo bezpečně uložit. Nezavírejte aplikaci a nahrávku co nejdříve ukončete.",
        );
      })
      .finally(() => {
        flushingRef.current = false;
        flushPromiseRef.current = null;
      });
    flushPromiseRef.current = task;
    return task;
  }, [flushBuffer]);

  /** Živý mikrofonní stream, pokud ho prohlížeč stále drží. */
  const liveStream = useCallback(() => {
    const existing = streamRef.current;
    if (existing?.getAudioTracks().some((t) => t.readyState === "live")) return existing;
    return null;
  }, []);

  /** Rozebere jen zvukový graf. Mikrofon ani nasbírané části se nikdy neruší. */
  const teardownGraph = useCallback(async () => {
    const node = nodeRef.current;
    if (node) {
      node.onaudioprocess = null;
      node.disconnect();
    }
    nodeRef.current = null;
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      try {
        await ctx.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const start = useCallback(
    async (resume = false) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        toast.error("Tento prohlížeč nahrávání nepodporuje. Zkuste Chrome nebo Safari.");
        return;
      }
      if (startingRef.current) return;
      startingRef.current = true;
      try {
        // Jednou povolený mikrofon si držíme, aby prohlížeč oprávnění znovu nevyžadoval.
        let stream = liveStream();
        if (!stream) {
          // Mrtvé tracky uklidíme, ať nedrží zařízení; oprávnění tím nezaniká.
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        }
        streamRef.current = stream;
        stream.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
        await teardownGraph();
        const ctx = new AudioContext();
        ctxRef.current = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        sampleRateRef.current = ctx.sampleRate;
        const source = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        nodeRef.current = node;
        pcmRef.current = [];
        pcmSamplesRef.current = 0;
        if (!resume) {
          sessionIdRef.current = crypto.randomUUID();
          segmentsRef.current = [];
          setSegmentCount(0);
          elapsedBaseRef.current = 0;
          autoStopRequestedRef.current = false;
        }
        const perSegment = RECORDING_CHECKPOINT_SECONDS * ctx.sampleRate;
        node.onaudioprocess = (e) => {
          const data = e.inputBuffer.getChannelData(0);
          pcmRef.current.push(new Float32Array(data));
          pcmSamplesRef.current += data.length;
          const capturedSeconds =
            wavChunksDuration(segmentsRef.current) +
            pcmSamplesRef.current / ctx.sampleRate;
          if (capturedSeconds >= MAX_RECORDING_SECONDS && !autoStopRequestedRef.current) {
            autoStopRequestedRef.current = true;
            setElapsed(MAX_RECORDING_SECONDS);
          }
          if (pcmSamplesRef.current >= perSegment && !flushingRef.current) {
            void queueFlush();
          }
          let peak = 0;
          for (let i = 0; i < data.length; i += 64) peak = Math.max(peak, Math.abs(data[i] ?? 0));
          setLevel(peak);
        };
        source.connect(node);
        // Tichý výstup: procesor musí být připojený k výstupu, ale mikrofon se nikdy nepřehraje.
        const silent = ctx.createGain();
        silent.gain.value = 0;
        node.connect(silent);
        silent.connect(ctx.destination);
        elapsedRef.current = elapsedBaseRef.current;
        setElapsed(elapsedBaseRef.current);
        setIsRecording(true);
      } catch (err) {
        if (!liveStream()) {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
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
        throw err;
      } finally {
        startingRef.current = false;
      }
    },
    [liveStream, queueFlush, teardownGraph],
  );

  /**
   * Obnoví snímání po tom, co ho systém na pozadí pozastavil. Session, uložené části
   * ani čas se nikdy nezahazují – jen se znovu rozběhne zvukový graf.
   */
  const resumeCapture = useCallback(async () => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    setBackgroundNote("Obnovuji nahrávání po návratu z pozadí…");
    try {
      await queueFlush();
      await teardownGraph();
      // Čas navážeme na skutečně zaznamenaný zvuk, ne na hodiny na pozadí.
      elapsedBaseRef.current = Math.max(
        wavChunksDuration(segmentsRef.current),
        elapsedBaseRef.current,
      );
      await start(true);
      setBackgroundNote(
        "Nahrávání pokračuje. Části uložené před přerušením zůstaly zachované.",
      );
    } catch {
      setBackgroundNote(
        "Systém nahrávání pozastavil a zatím ho nelze obnovit. Uložené části jsou v bezpečí – klepněte na Začít nahrávat pro pokračování, nebo nahrávku uložte.",
      );
      setIsRecording(false);
    } finally {
      recoveringRef.current = false;
    }
  }, [queueFlush, start, teardownGraph]);

  const stop = useCallback(async () => {
    setIsRecording(false);
    setLevel(0);
    const ctx = ctxRef.current;
    // Mikrofonní stream necháváme naživu, aby oprávnění zůstalo a další nahrávání
    // nemuselo znovu žádat o přístup. Snímání jen vypneme a uvolníme až při odchodu.
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    await flushPromiseRef.current;
    await flushBuffer();
    await ctx?.close();
    ctxRef.current = null;

    const segments = segmentsRef.current;
    const seconds = Math.max(elapsedRef.current, wavChunksDuration(segments));
    if (segments.length === 0 || seconds < 0.3) {
      toast.error("Nahrávka byla prázdná – zkuste to prosím znovu.");
      elapsedBaseRef.current = 0;
      elapsedRef.current = 0;
      setElapsed(0);
      return;
    }

    const session = sessionIdRef.current ?? crypto.randomUUID();
    pendingRef.current = { session, segments, seconds };
    elapsedBaseRef.current = seconds;
    setPending({ duration: seconds, segments: segments.length });
  }, [flushBuffer]);

  // Nahrávka se automaticky zastaví na dvou hodinách, aby se stihla bezpečně uložit.
  useEffect(() => {
    if (!isRecording || elapsed < MAX_RECORDING_SECONDS) return;
    toast.error("Dosáhli jste maximální délky 2 hodin. Nahrávku jsem zastavil a uložil.");
    void stop();
  }, [elapsed, isRecording, stop]);

  // Na mobilu se snažíme udržet nahrávání i při přepnutí aplikace do pozadí.
  // Prohlížeč to negarantuje, proto při návratu vždy obnovíme zvukový kontext.
  useEffect(() => {
    if (!isRecording) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    const requestLock = async () => {
      try {
        const api = (navigator as unknown as {
          wakeLock?: { request: (type: string) => Promise<WakeLockSentinel> };
        }).wakeLock;
        if (!api) return;
        lock = await api.request("screen");
      } catch {
        /* zařízení wake lock nepovoluje */
      }
    };
    void requestLock();

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        setBackgroundNote(
          "Nahrávání pokračuje na pozadí, pokud to zařízení a prohlížeč dovolí. Po návratu se stav obnoví a uložené části se neztratí.",
        );
        void queueFlush();
        return;
      }
      void ctxRef.current?.resume();
      void requestLock();
      if (ctxRef.current?.state !== "running") {
        setBackgroundNote(
          "Prohlížeč nahrávání na pozadí pozastavil. Už uložené části zůstaly zachovány – pokračujte nahráváním, nebo nahrávku uložte.",
        );
      }
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void queueFlush();
      event.preventDefault();
      event.returnValue = "";
    };
    const onPageHide = () => {
      void queueFlush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      if (!released) {
        released = true;
        void lock?.release().catch(() => {});
      }
    };
  }, [isRecording, queueFlush]);

  // Po pádu, restartu nebo zavření aplikace najdeme rozpracovanou nahrávku.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        const draft = JSON.parse(raw) as { session?: string; seconds?: number };
        if (!draft.session) return;
        const segments = await loadSegments(draft.session);
        if (cancelled) return;
        if (segments.length === 0) {
          localStorage.removeItem(DRAFT_KEY);
          return;
        }
        const seconds = draft.seconds || wavChunksDuration(segments);
        pendingRef.current = { session: draft.session, segments, seconds };
        segmentsRef.current = segments;
        sessionIdRef.current = draft.session;
        setSegmentCount(segments.length);
        elapsedBaseRef.current = seconds;
        elapsedRef.current = seconds;
        setElapsed(seconds);
        setPending({ duration: seconds, segments: segments.length, recovered: true });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePending = useCallback(() => {
    const held = pendingRef.current;
    if (!held) return;
    pendingRef.current = null;
    setPending(null);
    const storedSegments = [...held.segments];
    const chunks = coalesceWavChunks(storedSegments);
    const merged = mergeWavBlobs(chunks);
    const group = recordingGroup !== "none" ? recordingGroup : "";
    const id = crypto.randomUUID();
    const filename = `nahravka-${new Date().toISOString().slice(0, 16).replace(":", "-")}.wav`;
    const entry: Recording = {
      id,
      createdAt: Date.now(),
      duration: held.seconds,
      transcript: "",
      status: "running",
      stage: "transcribe",
      progress: 0,
      chunkCount: chunks.length,
      hasAudio: true,
      audioName: filename,
      group,
    };
    persist([entry, ...recordings]);
    void saveSegmentedAudio(id, held.session, filename).catch(() => {
      void saveAudio(id, merged, filename);
    });
    if (user) {
      update(id, { uploadStatus: "running", uploadProgress: 0 });
      void uploadCloudAudioChunks(user.id, id, chunks, (done, total) => {
        update(id, { uploadProgress: Math.round((done / total) * 100) });
      })
        .then((audioPath) => update(id, { audioPath, uploadStatus: "done", uploadProgress: 100 }))
        .catch(() => {
          update(id, { uploadStatus: "error" });
          toast.error("Zvuk zůstal bezpečně v tomto zařízení, ale cloudové uložení se přerušilo.");
        });
    }
    void runPipeline(id, chunks, language);
    segmentsRef.current = [];
    sessionIdRef.current = null;
    setSegmentCount(0);
    elapsedBaseRef.current = 0;
    elapsedRef.current = 0;
    setElapsed(0);
    setBackgroundNote(null);
    autoStopRequestedRef.current = false;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    toast.success(group ? `Uloženo do složky „${group}“.` : "Uloženo mezi nahrávky bez složky.");
  }, [language, persist, recordingGroup, recordings, runPipeline, update, user]);

  const continuePending = useCallback(() => {
    const held = pendingRef.current;
    if (held) {
      segmentsRef.current = held.segments;
      sessionIdRef.current = held.session;
      setSegmentCount(held.segments.length);
      elapsedBaseRef.current = held.seconds;
    }
    setPending(null);
    void start(true);
  }, [start]);

  const discardPending = useCallback(() => {
    const held = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    segmentsRef.current = [];
    sessionIdRef.current = null;
    setSegmentCount(0);
    elapsedBaseRef.current = 0;
    elapsedRef.current = 0;
    setElapsed(0);
    setBackgroundNote(null);
    if (held) void deleteSegments(held.session);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    toast("Nahrávka zahozena.");
  }, []);

  const importFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_IMPORT_BYTES) {
        toast.error("Soubor je příliš velký (max 300 MB).");
        return;
      }
      let duration = 0;
      try {
        duration = await new Promise<number>((resolve) => {
          const audio = document.createElement("audio");
          audio.preload = "metadata";
          audio.onloadedmetadata = () =>
            resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
          audio.onerror = () => resolve(0);
          audio.src = URL.createObjectURL(file);
        });
      } catch {
        /* ignore */
      }

      if (duration > MAX_RECORDING_SECONDS) {
        toast.error("Zvuk je delší než 2 hodiny. Rozdělte ho prosím na kratší části.");
        return;
      }

      const id = crypto.randomUUID();
      const entry: Recording = {
        id,
        createdAt: Date.now(),
        duration,
        transcript: "",
        status: "running",
        stage: "prepare",
        progress: 0,
        title: file.name,
        hasAudio: true,
        audioName: file.name,
        group: recordingGroup !== "none" ? recordingGroup : "",
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
      // Dlouhý soubor rozdělíme na segmenty, aby se přepis nezasekl na velikosti.
      let chunks: Blob[] = [];
      try {
        chunks = await fileToWavChunks(file);
      } catch {
        chunks = [file];
      }
      if (!duration) {
        update(id, { duration: wavChunksDuration(chunks) });
      }
      void saveAudio(id, file, file.name);
      if (user) {
        update(id, { uploadStatus: "running", uploadProgress: 0 });
        void uploadCloudAudioChunks(user.id, id, chunks, (done, total) => {
          update(id, { uploadProgress: Math.round((done / total) * 100) });
        })
          .then((audioPath) =>
            update(id, { audioPath, uploadStatus: "done", uploadProgress: 100 }),
          )
          .catch(() => {
            update(id, { uploadStatus: "error" });
            toast.error("Zvuk zůstal v tomto zařízení, ale cloudové uložení se přerušilo.");
          });
      }
      void runPipeline(id, chunks, language);
    },
    [language, recordingGroup, runPipeline, update, user],
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




  const exportText = (rec: Recording, kind: "transcript" | "summary" | "translation") => {
    const text =
      kind === "transcript"
        ? rec.transcript
        : kind === "summary"
          ? (rec.summary ?? "")
          : (rec.translation ?? "");
    if (!text.trim()) {
      toast.error(
        kind === "transcript"
          ? "Přepis není hotový."
          : kind === "summary"
            ? "Shrnutí není hotové."
            : "Překlad není hotový.",
      );
      return;
    }
    const suffix =
      kind === "transcript" ? "prepis" : kind === "summary" ? "shrnuti" : "preklad";
    const header = `${rec.title || "Nahrávka"} · ${new Date(rec.createdAt).toLocaleString("cs-CZ")}\n\n`;
    saveBlob(new Blob([header + text], { type: "text/plain;charset=utf-8" }), `${baseName(rec)}-${suffix}.txt`);
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
    setRecordingGroup(name);
    localStorage.setItem(ACTIVE_GROUP_KEY, name);
    toast.success(`Skupina „${name}“ vytvořena.`);
  };

  const removeGroup = (name: string) => {
    persistGroups(groups.filter((g) => g !== name));
    if (user) void deleteCloudGroup(name).catch(() => {});
    persist(recordings.map((r) => (r.group === name ? { ...r, group: "" } : r)));
    setFilter("all");
    if (recordingGroup === name) {
      setRecordingGroup("none");
      localStorage.setItem(ACTIVE_GROUP_KEY, "none");
    }
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
          Boolean(recording.stage) ||
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
          Boolean(recording.stage) ||
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
                  <Select
                    value={recordingGroup}
                    onValueChange={(value) => {
                      setRecordingGroup(value);
                      localStorage.setItem(ACTIVE_GROUP_KEY, value);
                    }}
                    disabled={isRecording}
                  >
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
              <p className="mt-2 text-center text-xs text-muted-foreground">MP3, WAV, M4A a další · až 2 hodiny (max. 300 MB)</p>
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
                        {(() => {
                          const first = processingRecordings[0];
                          const stage = first?.stage;
                          const label =
                            stage === "prepare"
                              ? "Připravuji zvuk…"
                                : stage === "upload"
                                  ? "Ukládám zvuk do cloudu…"
                                : stage === "transcribe"
                                ? "Přepisuji zvuk…"
                                : stage === "refine"
                                  ? "Upravuji češtinu…"
                                  : stage === "summary"
                                    ? "Tvořím AI shrnutí…"
                                    : stage === "translate"
                                      ? "Překládám…"
                                      : first?.status === "running"
                                        ? "Přepisuji zvuk…"
                                        : first?.refineStatus === "running"
                                          ? "Upravuji češtinu…"
                                          : "Tvořím AI shrnutí…";
                          const detail = first?.stageDetail;
                          return detail ? `${label} část ${detail}` : label;
                        })()}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary">{processingCount}</Badge>
                </div>
                <Progress value={processingRecordings[0]?.progress ?? 10} className="mt-4 h-1.5" aria-label="Průběh zpracování" />
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
            <div className="min-w-0"><p className="text-sm font-medium text-primary">Knihovna</p><h1 className="truncate font-display text-2xl font-semibold text-foreground">Nahrávky a přepisy</h1></div>
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
                    onClick={() => {
                      setFilter(g);
                      setRecordingGroup(g);
                      localStorage.setItem(ACTIVE_GROUP_KEY, g);
                    }}
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
            <div className="mt-5 flex flex-col items-center rounded-lg border border-dashed border-border bg-card p-10 text-center"><FileAudio className="size-8 text-primary" aria-hidden="true" /><p className="mt-3 font-medium text-foreground">Vaše první nahrávka začne tady</p><p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">Nahrajte rozhovor a po zastavení se zde objeví přepis.</p><Button className="mt-5 min-h-11" asChild><Link to="/"><Mic aria-hidden="true" /> Začít nahrávat</Link></Button></div>
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
                  onExportTranslation={() => exportText(selected, "translation")}
                  onRefreshSummary={() => void summarize(selected.transcript, selected.id)}
                  onTogglePlayer={() => void togglePlayer(selected)}
                  onUpdateTranscript={(text) => update(selected.id, { transcript: text, status: "done" })}
                  onRetry={() => void retry(selected)}
                  onTranslate={(targetLang) => void translate(selected, targetLang)}
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
              {recordingGroup !== "none"
                ? `do složky „${recordingGroup}“`
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
