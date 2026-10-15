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
  CalendarDays,
  Clock3,
  SlidersHorizontal,
  Radio,
  X,
  ListChecks,
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
import { RecordingDetail, isRecordingBusy, statusInfo } from "@/components/recording-detail";
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
import { processLongText, transcribeChunks, TRANSLATE_CHUNK_CHARS } from "@/lib/pipeline";
import {
  initialSessionState,
  isDataStale,
  parsePersistedSession,
  reduceSession,
  sessionLabel,
  toPersistedSession,
  type RecordingEvent,
  type RecordingSessionState,
} from "@/lib/recording-session";
import { addGap, detectPlatform, type Gap } from "@/lib/recording-resilience";

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
  translationParts?: string[];
  uploadProgress?: number;
  uploadStatus?: "running" | "done" | "error";
  /** Mezery, kdy systém mikrofon uspal (sekundy od začátku nahrávky). */
  gaps?: Gap[];
};

const STORAGE_KEY = "zapisnik.recordings";
const GROUPS_KEY = "zapisnik.groups";
const ACTIVE_GROUP_KEY = "zapisnik.active-group";
const DRAFT_KEY = "zapisnik.draft";
const ONBOARDING_KEY = "chat-scribe.onboarding-complete";
const LANGS = [
  { value: "cs", label: "Čeština" },
  { value: "auto", label: "Automaticky" },
  { value: "en", label: "Angličtina" },
  { value: "sk", label: "Slovenština" },
  { value: "de", label: "Němčina" },
];

/** Živá vlna jako v Diktafonu: nové hodnoty přibývají zprava, střed značí „teď“. */
function Waveform({ level, active }: { level: number; active: boolean }) {
  const BARS = 56;
  const [bars, setBars] = useState<number[]>(() => Array.from({ length: BARS }, () => 0));
  useEffect(() => {
    if (!active) {
      setBars((prev) => prev.map(() => 0));
      return;
    }
    setBars((prev) => [...prev.slice(1), Math.min(1, level * 2.4)]);
  }, [level, active]);
  return (
    <div className="relative mt-5 h-16 w-full max-w-md sm:mt-8 sm:h-24" aria-hidden="true">
      <div className="absolute inset-0 flex items-center justify-center gap-[3px]">
        {bars.map((value, i) => (
          <span
            key={i}
            className={`h-full w-[3px] origin-center rounded-full transition-transform duration-100 ease-out motion-reduce:transition-none ${active ? "bg-record" : "bg-separator"}`}
            // Jen transform – kompozitor zvládne 60 fps bez přepočtu layoutu.
            style={{ transform: `scaleY(${Math.max(0.04, value)})` }}
          />
        ))}
      </div>
    </div>
  );
}

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
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segmentCount, setSegmentCount] = useState(0);
  const [backgroundNote, setBackgroundNote] = useState<string | null>(null);
  const [platformTip, setPlatformTip] = useState<string | null>(null);
  const gapsRef = useRef<Gap[]>([]);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const pcmSamplesRef = useRef(0);
  const flushingRef = useRef(false);
  const flushPromiseRef = useRef<Promise<void> | null>(null);
  const autoStopRequestedRef = useRef(false);
  const startingRef = useRef(false);
  const recoveringRef = useRef(false);
  const stoppingRef = useRef(false);
  /** Běží uživatelská nahrávací session? Ukončí ji jen tlačítko nebo limit. */
  const activeRef = useRef(false);
  const sampleRateRef = useRef(48000);
  const sessionIdRef = useRef<string | null>(null);
  const segmentsRef = useRef<Blob[]>([]);
  const elapsedRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const syncedRef = useRef<Record<string, string>>({});
  const elapsedBaseRef = useRef(0);
  const pendingRef = useRef<{ session: string; segments: Blob[]; seconds: number } | null>(null);
  const audioUrlsRef = useRef<Record<string, string>>({});
  const lastDataAtRef = useRef(0);

  // Stav nahrávací session drží samostatný automat (src/lib/recording-session.ts),
  // aby lifecycle events nezávisely na vykreslování.
  const sessionRef = useRef<RecordingSessionState>(initialSessionState);
  const [sessionState, setSessionState] = useState<RecordingSessionState>(initialSessionState);
  const dispatchSession = useCallback((event: RecordingEvent) => {
    const next = reduceSession(sessionRef.current, event);
    if (next === sessionRef.current) return;
    sessionRef.current = next;
    setSessionState(next);
  }, []);

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
      setShowOnboarding(localStorage.getItem(ONBOARDING_KEY) !== "1");
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
    async (rec: Recording, target: string, options: { resume?: boolean } = {}) => {
      const source = rec.transcript.trim();
      if (!source) {
        toast.error("Nejdřív je potřeba hotový přepis. Spusťte přepis a zkuste to znovu.");
        return;
      }
      if (rec.translationStatus === "running") return;
      // Pokračování opravuje jen chybějící části; jiný jazyk začíná od začátku.
      const resume =
        options.resume === true &&
        rec.translationLang === target &&
        Array.isArray(rec.translationParts) &&
        rec.translationParts.length > 0;
      update(rec.id, {
        translationStatus: "running",
        translationLang: target,
        translationError: "",
        stage: "translate",
        progress: 0,
        stageDetail: resume ? "pokračuji v chybějících částech" : "příprava",
        ...(resume ? {} : { translation: "", translationParts: [] }),
      });
      const result = await processLongText("/api/translate", source, {
        // Zdrojový jazyk server detekuje sám.
        payload: { target },
        limit: TRANSLATE_CHUNK_CHARS,
        // Bezplatná úroveň Gemini má limit požadavků za minutu.
        concurrency: 2,
        onPartsChange: (parts) => update(rec.id, { translationParts: parts }),
        preserveInputOnFailure: false,
        ...(resume ? { initialParts: rec.translationParts } : {}),
        onPartial: (partial) => update(rec.id, { translation: partial }),
        onProgress: (progress) =>
          update(rec.id, {
            progress: progress.percent,
            stageDetail: progress.total > 1 ? `${progress.done}/${progress.total}` : "překládám",
          }),
      });
      const done = result.parts.filter((part) => part.trim()).length;
      if (done === 0) {
        update(rec.id, {
          translationStatus: "error",
          translationError:
            result.error ?? "Překlad se nepodařil dokončit. Zkuste to prosím znovu.",
          translationParts: result.parts,
          stage: undefined,
          progress: 0,
          stageDetail: "",
        });
        toast.error(result.error ?? "Překlad se nepodařil dokončit.");
        return;
      }
      update(rec.id, {
        translation: result.text,
        translationParts: result.parts,
        translationStatus: result.failed > 0 ? "error" : "done",
        ...(result.failed > 0
          ? {
              translationError: `Přeloženo ${done} z ${result.total} částí. ${
                result.error ?? "Zbytek se nepodařil."
              } Tlačítkem „Dokončit chybějící části“ pokračujete bez ztráty hotového textu.`,
            }
          : { translationError: "" }),
        stage: undefined,
        progress: 100,
        stageDetail: "",
      });
      if (result.failed === 0) toast.success("Překlad je hotový.");
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
    dispatchSession({
      type: "checkpoint",
      at: Date.now(),
      segments: index + 1,
      seconds: Math.max(elapsedRef.current, wavChunksDuration(segmentsRef.current)),
    });
    try {
      const snapshot = toPersistedSession(sessionRef.current);
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify(
          snapshot ?? { session, seconds: elapsedRef.current, segments: index + 1 },
        ),
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
          gapsRef.current = [];
          setSegmentCount(0);
          elapsedBaseRef.current = 0;
          autoStopRequestedRef.current = false;
          dispatchSession({
            type: "start",
            sessionId: sessionIdRef.current,
            at: Date.now(),
          });
        }
        const perSegment = RECORDING_CHECKPOINT_SECONDS * ctx.sampleRate;
        node.onaudioprocess = (e) => {
          const data = e.inputBuffer.getChannelData(0);
          pcmRef.current.push(new Float32Array(data));
          pcmSamplesRef.current += data.length;
          // Health tracking: čas posledních skutečných dat z mikrofonu.
          const now = Date.now();
          if (now - lastDataAtRef.current > 500) {
            lastDataAtRef.current = now;
            dispatchSession({ type: "data", at: now });
          }
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
        activeRef.current = true;
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
    if (recoveringRef.current || stoppingRef.current || !activeRef.current) return;
    if (sessionRef.current.stopRequested) return;
    recoveringRef.current = true;
    dispatchSession({ type: "recovering", at: Date.now() });
    setBackgroundNote("Obnovuji nahrávání po přerušení. Uložené části zůstávají zachované.");
    const lostAt = sessionRef.current.lastChunkAt;
    try {
      await queueFlush();
      await teardownGraph();
      gapsRef.current = addGap(gapsRef.current, lostAt, Date.now(), wavChunksDuration(segmentsRef.current));
      // Čas navážeme na skutečně zaznamenaný zvuk, ne na hodiny na pozadí.
      elapsedBaseRef.current = Math.max(
        wavChunksDuration(segmentsRef.current),
        elapsedBaseRef.current,
      );
      // Stop, který přišel během obnovy, má přednost – nahrávání už nerozbíháme.
      if (sessionRef.current.stopRequested || !activeRef.current) return;
      await start(true);
      dispatchSession({ type: "recovered", at: Date.now() });
      setBackgroundNote(
        "Nahrávání pokračuje. Části uložené před přerušením zůstaly zachované.",
      );
    } catch {
      dispatchSession({ type: "recovery-failed", at: Date.now(), reason: "resume-failed" });
      setBackgroundNote(
        "Systém nahrávání pozastavil a zatím ho nelze obnovit. Uložené části jsou v bezpečí – klepněte na Začít nahrávat pro pokračování, nebo nahrávku uložte.",
      );
      activeRef.current = false;
      setIsRecording(false);
    } finally {
      recoveringRef.current = false;
    }
  }, [queueFlush, start, teardownGraph]);

  // Zastavit smí pouze uživatel (tlačítko) nebo dosažení limitu 2 hodin.
  const stop = useCallback(async () => {
    stoppingRef.current = true;
    // Stop má nejvyšší prioritu: od teď žádná obnova session nevzkřísí.
    dispatchSession({ type: "user-stop", at: Date.now() });
    activeRef.current = false;
    setIsRecording(false);
    setLevel(0);
    setBackgroundNote(null);
    // Mikrofonní stream necháváme naživu, aby oprávnění zůstalo a další nahrávání
    // nemuselo znovu žádat o přístup. Snímání jen vypneme a uvolníme až při odchodu.
    streamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });
    // Cleanup až po bezpečném uzavření poslední části.
    await flushPromiseRef.current;
    await flushBuffer();
    await teardownGraph();
    stoppingRef.current = false;

    const segments = segmentsRef.current;
    const seconds = Math.max(elapsedRef.current, wavChunksDuration(segments));
    if (segments.length === 0 || seconds < 0.3) {
      toast.error("Nahrávka byla prázdná – zkuste to prosím znovu.");
      dispatchSession({ type: "discarded", at: Date.now() });
      elapsedBaseRef.current = 0;
      elapsedRef.current = 0;
      setElapsed(0);
      return;
    }

    const session = sessionIdRef.current ?? crypto.randomUUID();
    pendingRef.current = { session, segments, seconds };
    elapsedBaseRef.current = seconds;
    setPending({ duration: seconds, segments: segments.length });
  }, [flushBuffer, teardownGraph]);

  const stopRef = useRef(stop);
  stopRef.current = stop;

  // Pravdivá rada podle platformy (wake lock, instalace na plochu).
  useEffect(() => {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    const info = detectPlatform(navigator.userAgent, standalone);
    const noWakeLock = !("wakeLock" in navigator);
    const tips = [
      info.installHint,
      noWakeLock ? "Tento prohlížeč neumí držet displej rozsvícený – během nahrávání ho nechte zapnutý." : null,
    ].filter(Boolean);
    setPlatformTip(tips.length ? tips.join(" ") : null);
  }, []);

  // Nahrávka se automaticky zastaví na dvou hodinách, aby se stihla bezpečně uložit.
  useEffect(() => {
    if (!isRecording || elapsed < MAX_RECORDING_SECONDS) return;
    toast.error("Dosáhli jste maximální délky 2 hodin. Nahrávku jsem zastavil a uložil.");
    void stop();
  }, [elapsed, isRecording, stop]);

  // Nahrávání držíme i na pozadí a při zamknutém displeji. Žádná automatická událost
  // nahrávku neukončuje – jen bezpečně ukládá části a po návratu snímání obnoví.
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
    const platformNote = () =>
      detectPlatform(
        navigator.userAgent,
        window.matchMedia?.("(display-mode: standalone)").matches ||
          (navigator as { standalone?: boolean }).standalone === true,
      ).note;

    // Media Session: nahrávání je vidět v ovládání na zamčené obrazovce.
    const media = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (media) {
      try {
        if (typeof MediaMetadata !== "undefined") {
          media.metadata = new MediaMetadata({ title: "Probíhá nahrávání", artist: "Chat Scribe" });
        }
        media.playbackState = "playing";
        // Stop z lock screenu je výslovná akce uživatele.
        media.setActionHandler("stop", () => void stopRef.current?.());
        media.setActionHandler("pause", () => void stopRef.current?.());
      } catch {
        /* nepodporovaná akce */
      }
    }

    /** Snímá zvuk skutečně dál? */
    const capturing = () =>
      ctxRef.current?.state === "running" &&
      Boolean(streamRef.current?.getAudioTracks().some((t) => t.readyState === "live" && t.enabled));

    const healthCheck = async () => {
      if (stoppingRef.current || sessionRef.current.stopRequested) return;
      // Watchdog: i když prohlížeč žádnou událost nepošle, poznáme, že data přestala chodit.
      if (isDataStale(sessionRef.current, Date.now())) {
        dispatchSession({ type: "interrupted", at: Date.now(), reason: "no-data" });
        void queueFlush();
      }
      if (document.visibilityState !== "visible" || recoveringRef.current) return;
      void requestLock();
      const ctx = ctxRef.current;
      if (ctx && ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          /* ignore */
        }
      }
      if (!capturing() || isDataStale(sessionRef.current, Date.now())) await resumeCapture();
      else {
        dispatchSession({ type: "foreground", at: Date.now() });
        setBackgroundNote(null);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        // Pozadí nahrávku nikdy neukončuje – jen bezpečně odloží nasbíraný zvuk.
        dispatchSession({ type: "background", at: Date.now() });
        setBackgroundNote(platformNote());
        void queueFlush();
        return;
      }
      void healthCheck();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void queueFlush();
      event.preventDefault();
      event.returnValue = "";
    };
    const onPageHide = () => {
      void queueFlush();
    };
    const onTrackLost = () => {
      // Systémové přerušení (hovor, Siri, jiná aplikace) – data držíme, session nekončí.
      dispatchSession({ type: "interrupted", at: Date.now(), reason: "track-lost" });
      void queueFlush();
      if (document.visibilityState === "visible") void healthCheck();
    };
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    tracks.forEach((t) => {
      t.addEventListener("ended", onTrackLost);
      t.addEventListener("mute", onTrackLost);
    });
    // Záložní hlídač pro platformy, které visibilitychange ani ended nepošlou.
    const watchdog = setInterval(() => void healthCheck(), 3000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(watchdog);
      tracks.forEach((t) => {
        t.removeEventListener("ended", onTrackLost);
        t.removeEventListener("mute", onTrackLost);
      });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      if (!released) {
        released = true;
        void lock?.release().catch(() => {});
      }
      if (media) {
        try {
          media.playbackState = "none";
          media.metadata = null;
          media.setActionHandler("stop", null);
          media.setActionHandler("pause", null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [isRecording, queueFlush, resumeCapture]);

  // Po pádu, restartu nebo zavření aplikace najdeme rozpracovanou nahrávku.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const draft = parsePersistedSession(localStorage.getItem(DRAFT_KEY));
        if (!draft) return;
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
        // Session byla přerušená, ne dokončená – uživatel rozhodne, zda uloží nebo pokračuje.
        if (draft.active || draft.awaitingRecovery) {
          setBackgroundNote(
            "Nahrávání bylo přerušeno dřív, než jste ho ukončili. Uložené části zůstaly zachované.",
          );
        }
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
      ...(gapsRef.current.length ? { gaps: gapsRef.current } : {}),
    };
    gapsRef.current = [];
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
    dispatchSession({ type: "saved", at: Date.now() });
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
    dispatchSession({ type: "discarded", at: Date.now() });
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
    const now = Date.now();
    return recordings.filter((recording) => {
      const inGroup =
        filter === "all" ||
        (filter === "none" && !recording.group) ||
        recording.group === filter;
      if (!inGroup) return false;
      const isProcessing =
        Boolean(recording.stage) ||
        recording.status === "running" ||
        recording.refineStatus === "running" ||
        recording.summaryStatus === "running" ||
        recording.translationStatus === "running" ||
        recording.uploadStatus === "running";
      if (statusFilter === "ready" && (recording.status !== "done" || isProcessing)) return false;
      if (statusFilter === "processing" && !isProcessing) return false;
      if (statusFilter === "error" && recording.status !== "error") return false;
      const age = now - recording.createdAt;
      if (dateFilter === "today" && age > 24 * 60 * 60 * 1000) return false;
      if (dateFilter === "week" && age > 7 * 24 * 60 * 60 * 1000) return false;
      if (dateFilter === "month" && age > 30 * 24 * 60 * 60 * 1000) return false;
      if (!normalizedSearch) return true;
      return [recording.title, recording.transcript, recording.summary, recording.group]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase("cs").includes(normalizedSearch));
    });
  }, [dateFilter, filter, recordings, search, statusFilter]);

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
          recording.summaryStatus === "running" ||
          recording.translationStatus === "running" ||
          recording.uploadStatus === "running",
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
          recording.summaryStatus === "running" ||
          recording.translationStatus === "running" ||
          recording.uploadStatus === "running",
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

  const dismissOnboarding = () => {
    setShowOnboarding(false);
    try {
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  const recorderState = isRecording
    ? sessionLabel(sessionState)
    : processingRecordings.length > 0
      ? "Zpracovává se"
      : sessionState.phase === "saved"
        ? "Uloženo"
        : sessionState.phase === "error"
          ? "Chyba"
          : "Připraveno";
  const recorderStateTone =
    sessionState.phase === "error" || sessionState.phase === "interrupted"
      ? "destructive"
      : isRecording || processingRecordings.length > 0
        ? "secondary"
        : "outline";

  const statusSegments = [
    { value: "all", label: "Vše" },
    { value: "ready", label: "Hotové" },
    { value: "processing", label: "Probíhá" },
    { value: "error", label: "S chybou" },
  ];

  return (
    <div className="min-h-dvh bg-background pb-[calc(6rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:pb-16">
      {/* Navigační lišta: průsvitný materiál, obsah pod ní prosvítá. */}
      <header className="material sticky top-0 z-30 pt-[env(safe-area-inset-top)] shadow-[0_0.5px_0_var(--separator)]">
        <div className="mx-auto flex h-13 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:px-6 md:grid md:grid-cols-[1fr_auto_1fr]">
          <Link to="/" className="press flex min-w-0 items-center gap-2 justify-self-start rounded-lg">
            <span className="grid size-7 shrink-0 place-items-center rounded-[0.5rem] bg-record text-white">
              <AudioLines className="size-4" aria-hidden="true" />
            </span>
            <span className="headline truncate text-[0.9375rem] text-foreground">Chat Scribe</span>
          </Link>

          <nav className="segmented hidden w-64 md:grid" aria-label="Hlavní navigace">
            <Link to="/" aria-pressed={mode === "recorder"} className="press grid place-items-center text-foreground">
              Nahrávání
            </Link>
            <Link to="/transcripts" aria-pressed={mode === "library"} className="press grid place-items-center text-foreground">
              Knihovna{processingCount > 0 ? <span className="sr-only">, {processingCount} se zpracovává</span> : null}
            </Link>
          </nav>

          <div className="flex items-center justify-self-end">
            {user ? (
              <div className="flex items-center gap-1">
                <span className="footnote hidden max-w-40 truncate lg:inline">{user.email}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="press min-h-11 min-w-11 rounded-full text-primary hover:bg-fill hover:text-primary"
                  aria-label="Odhlásit se"
                  onClick={() => void getSupabase().then((sb) => sb.auth.signOut())}
                >
                  <LogOut aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <Link
                to="/auth"
                className="press inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[0.9375rem] font-medium text-primary hover:bg-fill"
              >
                <LogIn className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Přihlásit se</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pt-4 sm:px-6 sm:pt-8">
        {mode === "recorder" ? (
          <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            {/* Nahrávání ve stylu Diktafonu */}
            <section id="record" className="scroll-mt-24 animate-fade-in">
              <h1 className="large-title text-foreground">Nová nahrávka</h1>
              <p className="footnote mt-1">Nahrajte rozhovor, přepis a shrnutí připravíme automaticky.</p>

              <div className="grouped mt-5 flex flex-col items-center px-5 pb-6 pt-6 sm:px-8 sm:pb-10 sm:pt-7">
                <span
                  aria-live="polite"
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8125rem] font-semibold ${
                    recorderStateTone === "destructive"
                      ? "bg-destructive/12 text-destructive"
                      : isRecording
                        ? "bg-record/12 text-record"
                        : processingRecordings.length > 0
                          ? "bg-primary/12 text-primary"
                          : "bg-fill text-muted-foreground"
                  }`}
                >
                  <span
                    className={`size-1.5 rounded-full ${isRecording ? "animate-pulse bg-record" : processingRecordings.length > 0 ? "bg-primary" : "bg-muted-foreground"}`}
                    aria-hidden="true"
                  />
                  {recorderState}
                </span>

                <p
                  className="mt-4 font-display text-[4.25rem] font-light leading-none tracking-[-0.03em] text-foreground tabular-nums sm:text-[5rem]"
                  aria-live="off"
                >
                  {formatDuration(elapsed)}
                </p>
                <p className="footnote mt-2 min-h-5 text-center" aria-live="polite">
                  {isRecording
                    ? segmentCount > 0
                      ? `Bezpečně uloženo ${segmentCount} ${segmentCount === 1 ? "část" : segmentCount < 5 ? "části" : "částí"}`
                      : "Nahrávka se průběžně ukládá"
                    : "Připraveno k nahrávání"}
                </p>

                <Waveform level={level} active={isRecording} />

                {/* Tlačítko jako v Diktafonu: kruh se plynule změní ve čtverec. */}
                <button
                  type="button"
                  onClick={() => void (isRecording ? stop() : start())}
                  className="press group relative mt-6 grid size-[5.5rem] sm:mt-8 place-items-center rounded-full border-[3.5px] border-foreground/20 focus-visible:outline-offset-4 active:scale-95"
                  aria-label={isRecording ? "Zastavit nahrávání" : "Spustit nahrávání"}
                  aria-pressed={isRecording}
                >
                  {isRecording ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -inset-2 rounded-full bg-record/15 transition-transform duration-150 ease-out motion-reduce:hidden"
                      style={{ transform: `scale(${1 + Math.min(level, 0.5) * 0.35})` }}
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={`relative bg-record transition-all duration-300 ease-[var(--ease-ios)] group-hover:brightness-110 ${
                      isRecording ? "size-8 rounded-[0.5rem]" : "size-[4.25rem] rounded-full"
                    }`}
                  />
                </button>
                <p className="footnote mt-3">{isRecording ? "Klepnutím nahrávání ukončíte" : "Klepnutím začnete nahrávat"}</p>

                {platformTip && !isRecording ? (
                  <p className="footnote mt-6 max-w-sm text-center">{platformTip}</p>
                ) : null}
                {backgroundNote ? (
                  <p
                    className="mt-4 max-w-sm rounded-xl bg-warning/12 px-3 py-2 text-center text-[0.8125rem] leading-5 text-foreground"
                    aria-live="polite"
                  >
                    {backgroundNote}
                  </p>
                ) : null}
              </div>

              {showOnboarding ? (
                <div className="grouped mt-6 animate-sheet-in" role="region" aria-labelledby="onboarding-title">
                  <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-4">
                    <h2 id="onboarding-title" className="headline text-foreground">Jak to funguje</h2>
                    <button
                      type="button"
                      className="press -mr-2 -mt-2 grid size-11 place-items-center rounded-full text-muted-foreground hover:bg-fill"
                      aria-label="Skrýt průvodce a příště nezobrazovat"
                      onClick={dismissOnboarding}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                  {[
                    { icon: Mic, tint: "bg-record", title: "Spusťte nahrávání", text: "Klepněte na červené tlačítko." },
                    { icon: Radio, tint: "bg-warning", title: "Klidně zamkněte telefon", text: "Přechod na pozadí nahrávku neukončí." },
                    { icon: Library, tint: "bg-primary", title: "Výsledek je v Knihovně", text: "Přepis, shrnutí, překlad i export." },
                  ].map(({ icon: Icon, tint, title, text }) => (
                    <div key={title} className="grouped-row flex items-center gap-3 px-4 py-3 [--row-inset:3.75rem]">
                      <span className={`grid size-8 shrink-0 place-items-center rounded-[0.5rem] text-white ${tint}`}>
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[0.9375rem] font-medium text-foreground">{title}</span>
                        <span className="footnote block">{text}</span>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {processingRecordings.length > 0 ? (
                <Link
                  to="/transcripts"
                  className="grouped tap-row mt-6 flex items-center gap-3 px-4 py-3.5 animate-sheet-in"
                  aria-label="Zpracování nahrávky – otevřít knihovnu"
                >
                  <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.9375rem] font-medium text-foreground">Zpracování nahrávky</span>
                    <span className="footnote block truncate">
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
                                    ? "Tvořím shrnutí…"
                                    : stage === "translate"
                                      ? "Překládám…"
                                      : first?.status === "running"
                                        ? "Přepisuji zvuk…"
                                        : first?.refineStatus === "running"
                                          ? "Upravuji češtinu…"
                                          : "Tvořím shrnutí…";
                        const detail = first?.stageDetail;
                        return detail ? `${label} část ${detail}` : label;
                      })()}
                    </span>
                    <Progress value={processingRecordings[0]?.progress ?? 10} className="mt-2 h-1" aria-label="Průběh zpracování" />
                  </span>
                  {processingCount > 1 ? (
                    <span className="rounded-full bg-fill px-2 py-0.5 text-xs font-semibold text-muted-foreground">{processingCount}</span>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                </Link>
              ) : null}
            </section>

            {/* Nastavení před nahráváním jako seskupený seznam */}
            <aside id="settings" className="scroll-mt-24 space-y-6 lg:pt-[3.75rem]" aria-label="Nastavení nahrávání">
              <div>
                <h2 className="section-label mb-1.5">Před nahráváním</h2>
                <div className="grouped">
                  <label className="grouped-row flex min-h-11 items-center gap-3 pl-4 pr-1 [--row-inset:3.75rem]" htmlFor="language">
                    <span className="grid size-7 shrink-0 place-items-center rounded-[0.4375rem] bg-primary text-white">
                      <Languages className="size-4" aria-hidden="true" />
                    </span>
                    <span className="flex-1 text-[1.0625rem] text-foreground">Jazyk</span>
                    <Select value={language} onValueChange={setLanguage} disabled={isRecording}>
                      <SelectTrigger
                        id="language"
                        className="h-11 w-auto gap-1 border-0 bg-transparent pr-3 text-[1.0625rem] text-muted-foreground shadow-none focus-visible:ring-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>{LANGS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <label className="grouped-row flex min-h-11 items-center gap-3 pl-4 pr-1 [--row-inset:3.75rem]" htmlFor="recording-folder">
                    <span className="grid size-7 shrink-0 place-items-center rounded-[0.4375rem] bg-warning text-white">
                      <Folder className="size-4" aria-hidden="true" />
                    </span>
                    <span className="flex-1 text-[1.0625rem] text-foreground">Složka</span>
                    <Select
                      value={recordingGroup}
                      onValueChange={(value) => {
                        setRecordingGroup(value);
                        localStorage.setItem(ACTIVE_GROUP_KEY, value);
                      }}
                      disabled={isRecording}
                    >
                      <SelectTrigger
                        id="recording-folder"
                        className="h-11 w-auto max-w-44 gap-1 border-0 bg-transparent pr-3 text-[1.0625rem] text-muted-foreground shadow-none focus-visible:ring-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Bez složky</SelectItem>
                        {groups.map((group) => <SelectItem key={group} value={group}>{group}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <p className="footnote mt-1.5 px-4">Nová nahrávka se uloží rovnou do vybrané složky.</p>
              </div>

              <div>
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
                <div className="grouped">
                  <button
                    type="button"
                    className="tap-row flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left disabled:opacity-40"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isRecording}
                  >
                    <span className="grid size-7 shrink-0 place-items-center rounded-[0.4375rem] bg-success text-white">
                      <Upload className="size-4" aria-hidden="true" />
                    </span>
                    <span className="flex-1 text-[1.0625rem] text-primary">Importovat zvuk…</span>
                  </button>
                </div>
                <p className="footnote mt-1.5 px-4">MP3, WAV, M4A a další · až 2 hodiny (max. 300 MB)</p>
              </div>

              <p className="footnote flex items-start gap-2 px-4">
                {syncing ? (
                  <CloudUpload className="mt-0.5 size-4 shrink-0 animate-pulse" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
                )}
                <span>
                  {user
                    ? syncing
                      ? "Synchronizuji vaše záznamy…"
                      : "Záznamy jsou dostupné na všech vašich zařízeních."
                    : "Bez přihlášení zůstanou záznamy jen v tomto zařízení."}
                </span>
              </p>
            </aside>
          </div>
        ) : (
          <section id="transcripts" className="scroll-mt-24 animate-fade-in">
            <div className={selected ? "hidden lg:block" : ""}>
              <div className="flex items-end justify-between gap-4">
                <h1 className="large-title text-foreground">Knihovna</h1>
                <span className="footnote pb-1.5">
                  {recordings.length} {recordings.length === 1 ? "nahrávka" : recordings.length >= 2 && recordings.length <= 4 ? "nahrávky" : "nahrávek"}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <label className="search-field relative flex h-10 items-center">
                  <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="h-full w-full bg-transparent pl-8 pr-3 text-[1.0625rem] text-foreground outline-none placeholder:text-muted-foreground"
                    placeholder="Hledat"
                    aria-label="Hledat v nahrávkách a přepisech"
                    type="search"
                  />
                </label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger className="h-10 w-auto gap-1.5 rounded-[0.625rem] border-0 bg-fill px-3 shadow-none sm:min-w-40" aria-label="Filtrovat podle data">
                    <CalendarDays aria-hidden="true" />
                    <span className="hidden sm:inline"><SelectValue /></span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Kdykoli</SelectItem>
                    <SelectItem value="today">Dnes</SelectItem>
                    <SelectItem value="week">Posledních 7 dní</SelectItem>
                    <SelectItem value="month">Posledních 30 dní</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="segmented mt-3" role="group" aria-label="Filtrovat podle stavu">
                {statusSegments.map((segment) => (
                  <button
                    key={segment.value}
                    type="button"
                    aria-pressed={statusFilter === segment.value}
                    className="px-2 text-foreground"
                    onClick={() => setStatusFilter(segment.value)}
                  >
                    {segment.label}
                  </button>
                ))}
              </div>

              {/* Složky jako kapsle */}
              <div className="-mx-4 mt-3 flex items-center gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Filtrovat podle složky">
                {[{ value: "all", label: "Všechny" }, ...groups.map((g) => ({ value: g, label: g })), { value: "none", label: "Bez složky" }].map(
                  ({ value, label }) => {
                    const active = filter === value;
                    const isGroup = value !== "all" && value !== "none";
                    return (
                      <span key={value} className="flex shrink-0 items-center">
                        <button
                          type="button"
                          aria-pressed={active}
                          className={`press inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[0.9375rem] font-medium ${
                            active ? "bg-foreground text-background" : "bg-grouped text-foreground"
                          }`}
                          onClick={() => {
                            setFilter(value);
                            if (isGroup) {
                              setRecordingGroup(value);
                              localStorage.setItem(ACTIVE_GROUP_KEY, value);
                            }
                          }}
                        >
                          {isGroup ? <Folder className="size-3.5" aria-hidden="true" /> : null}
                          {label}
                          {isGroup ? <span className="text-xs opacity-60">{groupCounts[value] ?? 0}</span> : null}
                        </button>
                        {active && isGroup ? (
                          <button
                            type="button"
                            className="press ml-0.5 grid size-8 place-items-center rounded-full text-destructive hover:bg-destructive/10"
                            aria-label={`Smazat složku ${value}`}
                            onClick={() => removeGroup(value)}
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    );
                  },
                )}
                <span className="flex h-8 shrink-0 items-center rounded-full bg-grouped pl-3 pr-1">
                  <input
                    value={newGroup}
                    onChange={(e) => setNewGroup(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addGroup();
                    }}
                    placeholder="Nová složka"
                    aria-label="Název nové složky"
                    className="w-28 bg-transparent text-[0.9375rem] text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    className="press grid size-7 place-items-center rounded-full text-primary hover:bg-fill disabled:opacity-40"
                    aria-label="Přidat složku"
                    disabled={!newGroup.trim()}
                    onClick={addGroup}
                  >
                    <FolderPlus className="size-4" aria-hidden="true" />
                  </button>
                </span>
              </div>
            </div>

            {visible.length === 0 && recordings.length > 0 ? (
              <div className="mt-16 flex flex-col items-center text-center">
                <Search className="size-10 text-muted-foreground/50" aria-hidden="true" />
                <p className="headline mt-3 text-xl text-foreground">Žádné výsledky</p>
                <p className="footnote mt-1">Zkuste jiný výraz, stav nebo složku.</p>
              </div>
            ) : null}

            {recordings.length === 0 ? (
              <div className="mt-20 flex flex-col items-center text-center animate-fade-in">
                <span className="grid size-16 place-items-center rounded-full bg-record/12 text-record">
                  <AudioLines className="size-8" aria-hidden="true" />
                </span>
                <p className="mt-4 font-display text-[1.375rem] font-bold tracking-[-0.02em] text-foreground">Zatím žádné nahrávky</p>
                <p className="footnote mt-1 max-w-xs">Po první nahrávce tu najdete zvuk, přepis, shrnutí i překlad.</p>
                <Link
                  to="/"
                  className="press mt-6 inline-flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-[1.0625rem] font-semibold text-primary-foreground"
                >
                  <Mic className="size-5" aria-hidden="true" /> Nová nahrávka
                </Link>
              </div>
            ) : null}

            <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(19rem,0.8fr)_minmax(0,1.2fr)]">
              {visible.length > 0 ? (
                <ul className={`grouped ${selected ? "hidden lg:block" : ""}`} aria-label="Seznam nahrávek">
                  {visible.map((rec) => {
                    const isProcessing = isRecordingBusy(rec);
                    const recStatus = statusInfo(rec);
                    const failed = recStatus.tone === "destructive";
                    const isSelected = selectedId === rec.id;
                    return (
                      <li
                        key={rec.id}
                        className={`grouped-row [--row-inset:4rem] ${isSelected ? "bg-primary/10" : ""}`}
                      >
                        {editingId === rec.id ? (
                          <div className="flex items-center gap-2 px-4 py-2.5">
                            <Input
                              autoFocus
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveRename(rec.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              aria-label="Název nahrávky"
                              className="h-10 min-w-0 flex-1 rounded-[0.625rem] border-0 bg-fill"
                            />
                            <Button size="sm" className="press h-10 rounded-full px-4" onClick={() => saveRename(rec.id)}>
                              Hotovo
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center">
                            <button
                              type="button"
                              className="tap-row flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left"
                              onClick={() => openRecording(rec.id)}
                              aria-label={`Otevřít ${rec.title || "nahrávku"}`}
                            >
                              <span
                                className={`grid size-9 shrink-0 place-items-center rounded-full ${
                                  failed ? "bg-destructive/12 text-destructive" : isProcessing ? "bg-primary/12 text-primary" : "bg-record/12 text-record"
                                }`}
                              >
                                {isProcessing ? (
                                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                                ) : failed ? (
                                  <AlertCircle className="size-4" aria-hidden="true" />
                                ) : (
                                  <AudioLines className="size-4" aria-hidden="true" />
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="headline block truncate text-[1.0625rem] text-foreground">
                                  {rec.title || new Date(rec.createdAt).toLocaleString("cs-CZ", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
                                </span>
                                <span className="footnote flex flex-wrap items-center gap-x-1.5">
                                  <span>{new Date(rec.createdAt).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" })}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="tabular-nums">{formatDuration(rec.duration)}</span>
                                  {rec.group ? (
                                    <>
                                      <span aria-hidden="true">·</span>
                                      <span className="truncate">{rec.group}</span>
                                    </>
                                  ) : null}
                                </span>
                                {isProcessing || failed ? (
                                  <span className={`mt-0.5 block text-[0.8125rem] font-medium ${failed ? "text-destructive" : "text-primary"}`}>
                                    {isProcessing ? `${recStatus.label}…` : recStatus.label}
                                  </span>
                                ) : null}
                                {isProcessing ? (
                                  <Progress
                                    value={
                                      rec.uploadStatus === "running" && !rec.stage
                                        ? (rec.uploadProgress ?? 0)
                                        : (rec.progress ?? (rec.status === "running" ? 35 : rec.refineStatus === "running" ? 65 : 85))
                                    }
                                    className="mt-1.5 h-1"
                                    aria-label="Průběh zpracování"
                                  />
                                ) : null}
                              </span>
                              <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="press mr-1 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-fill"
                              aria-label={`Přejmenovat ${rec.title || "nahrávku"}`}
                              onClick={() => startRename(rec)}
                            >
                              <Pencil className="size-4" aria-hidden="true" />
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              <div id="recording-detail" className="scroll-mt-20 lg:sticky lg:top-20">
                {selected ? (
                  <RecordingDetail
                    key={selected.id}
                    recording={selected}
                    audioUrl={audioUrls[selected.id]}
                    onClose={() => setSelectedId(null)}
                    onCopy={(text) => void copy(text)}
                    onDelete={() => {
                      remove(selected.id);
                      setSelectedId(null);
                    }}
                    onExportAudio={() => void exportAudio(selected)}
                    onExportTranscript={() => exportText(selected, "transcript")}
                    onExportSummary={() => exportText(selected, "summary")}
                    onExportTranslation={() => exportText(selected, "translation")}
                    onRefreshSummary={() => void summarize(selected.transcript, selected.id)}
                    onTogglePlayer={() => void togglePlayer(selected)}
                    onUpdateTranscript={(text) => update(selected.id, { transcript: text, status: "done" })}
                    onRetry={() => void retry(selected)}
                    onTranslate={(targetLang, options) => void translate(selected, targetLang, options)}
                  />
                ) : visible.length > 0 ? (
                  <div className="hidden min-h-[28rem] flex-col items-center justify-center rounded-[0.875rem] border border-dashed border-separator text-center lg:flex">
                    <FileText className="size-10 text-muted-foreground/40" aria-hidden="true" />
                    <p className="headline mt-3 text-foreground">Vyberte nahrávku</p>
                    <p className="footnote mt-1 max-w-xs">Zobrazí se shrnutí, celý přepis, překlad a exporty.</p>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        )}
      </main>

      {/* Tab bar ve stylu iOS */}
      <nav
        className="material fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 pb-[env(safe-area-inset-bottom)] shadow-[0_-0.5px_0_var(--separator)] md:hidden"
        aria-label="Mobilní navigace"
      >
        {[
          { to: "/" as const, hash: undefined, label: "Nahrát", icon: Mic, active: mode === "recorder" },
          { to: "/transcripts" as const, hash: undefined, label: "Knihovna", icon: Library, active: mode === "library" },
          { to: "/" as const, hash: "settings", label: "Nastavení", icon: Settings2, active: false },
        ].map(({ to, hash, label, icon: Icon, active }) => (
          <Link
            key={label}
            to={to}
            {...(hash ? { hash, hashScrollIntoView: { behavior: "smooth" as const, block: "start" as const } } : {})}
            aria-current={active ? "page" : undefined}
            className={`press relative flex h-[3.25rem] flex-col items-center justify-center gap-0.5 text-[0.6875rem] font-medium ${
              active ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <Icon className="size-6" strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
            {label}
            {label === "Knihovna" && processingCount > 0 ? (
              <span className="absolute right-[calc(50%-1.25rem)] top-1.5 grid min-w-4 place-items-center rounded-full bg-record px-1 text-[0.625rem] font-bold leading-4 text-white">
                {processingCount}
                <span className="sr-only"> se zpracovává</span>
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      {showBack ? (
        <Button
          size="icon"
          aria-label="Zpět nahoru"
          className="material-thick press fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 size-11 rounded-full text-primary shadow-lg hover:bg-fill md:bottom-6 md:right-6"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowUp className="size-5" aria-hidden="true" />
        </Button>
      ) : null}

      <AlertDialog open={pending !== null}>
        <AlertDialogContent className="max-w-[20rem] gap-0 rounded-[0.875rem] p-0 text-center">
          <AlertDialogHeader className="px-5 pb-4 pt-5 text-center sm:text-center">
            <AlertDialogTitle className="headline text-[1.0625rem]">Uložit nahrávku?</AlertDialogTitle>
            <AlertDialogDescription className="text-[0.8125rem] leading-5 text-foreground/80">
              Nahrávka je dlouhá {formatDuration(pending?.duration ?? 0)} a uloží se{" "}
              {recordingGroup !== "none" ? `do složky „${recordingGroup}“` : "mezi nahrávky bez složky"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-0 sm:flex-col sm:space-x-0">
            <button type="button" className="tap-row h-11 border-t border-separator text-[1.0625rem] font-semibold text-primary" onClick={savePending}>
              Uložit
            </button>
            <button type="button" className="tap-row h-11 border-t border-separator text-[1.0625rem] text-primary" onClick={continuePending}>
              Pokračovat v nahrávání
            </button>
            <button type="button" className="tap-row h-11 border-t border-separator text-[1.0625rem] text-destructive" onClick={discardPending}>
              Zahodit
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
