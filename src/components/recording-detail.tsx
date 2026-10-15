import { memo, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  Download,
  FileText,
  Loader2,
  Music,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
  Languages,
  RotateCcw,
  ChevronLeft,
  CalendarDays,
  Clock3,
  PauseCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { formatDuration } from "@/lib/wav";
import { totalGapSeconds, type Gap } from "@/lib/recording-resilience";

export type RecordingView = {
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
  /** Mezery, kdy systém během nahrávání uspal mikrofon. */
  gaps?: Gap[];
};

type Props = {
  recording: RecordingView;
  audioUrl?: string | undefined;
  onClose: () => void;
  onCopy: (text: string) => void;
  onDelete: () => void;
  onExportAudio: () => void;
  onExportTranscript: () => void;
  onExportSummary: () => void;
  onExportTranslation: () => void;
  onRefreshSummary: () => void;
  onTogglePlayer: () => void;
  onUpdateTranscript: (text: string) => void;
  onRetry: () => void;
  onTranslate: (target: string, options?: { resume?: boolean }) => void;
};

const TRANSLATION_LANGS = [
  { value: "en", label: "Angličtina" },
  { value: "cs", label: "Čeština" },
  { value: "de", label: "Němčina" },
  { value: "sk", label: "Slovenština" },
  { value: "pl", label: "Polština" },
  { value: "uk", label: "Ukrajinština" },
  { value: "es", label: "Španělština" },
  { value: "fr", label: "Francouzština" },
  { value: "it", label: "Italština" },
];

const STAGE_LABELS: Record<string, string> = {
  prepare: "Připravuji zvuk k přepisu",
  upload: "Ukládám zvuk do cloudu",
  transcribe: "Přepisuji zvuk",
  refine: "Upravuji češtinu",
  summary: "Tvořím shrnutí",
  translate: "Překládám",
};

export function isRecordingBusy(recording: RecordingView): boolean {
  return (
    Boolean(recording.stage) ||
    recording.status === "running" ||
    recording.refineStatus === "running" ||
    recording.summaryStatus === "running" ||
    recording.translationStatus === "running" ||
    recording.uploadStatus === "running"
  );
}

export function statusInfo(recording: RecordingView) {
  if (recording.status === "error") return { label: "Přepis selhal", tone: "destructive" as const };
  if (recording.uploadStatus === "error") return { label: "Cloudové uložení selhalo", tone: "destructive" as const };
  if (recording.translationStatus === "error") return { label: "Překlad selhal", tone: "destructive" as const };
  if (recording.stage) return { label: STAGE_LABELS[recording.stage] ?? "Zpracovávám", tone: "secondary" as const };
  if (recording.uploadStatus === "running") return { label: "Ukládám zvuk", tone: "secondary" as const };
  if (recording.status === "running") return { label: "Přepisuji zvuk", tone: "secondary" as const };
  if (recording.refineStatus === "running") return { label: "Upravuji češtinu", tone: "secondary" as const };
  if (recording.summaryStatus === "running") return { label: "Tvořím shrnutí", tone: "secondary" as const };
  if (recording.translationStatus === "running") return { label: "Překládám", tone: "secondary" as const };
  return { label: "Hotovo", tone: "outline" as const };
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const clean = query.trim();
    if (!clean) return [text];
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.split(new RegExp(`(${escaped})`, "gi"));
  }, [query, text]);

  return (
    <p className="whitespace-pre-wrap text-[1.0625rem] leading-[1.6] text-foreground">
      {parts.map((part, index) =>
        query.trim() && part.toLocaleLowerCase("cs").includes(query.trim().toLocaleLowerCase("cs")) ? (
          <mark key={`${part}-${index}`} className="rounded-[0.25rem] bg-warning/35 px-0.5 text-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

/** Ikonové tlačítko lišty akcí (44 px cíl, odezva při stisku). */
function ToolbarButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="press grid size-11 place-items-center rounded-full text-primary hover:bg-fill disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

export const RecordingDetail = memo(function RecordingDetail({
  recording,
  audioUrl,
  onClose,
  onCopy,
  onDelete,
  onExportAudio,
  onExportTranscript,
  onExportSummary,
  onExportTranslation,
  onRefreshSummary,
  onTogglePlayer,
  onUpdateTranscript,
  onRetry,
  onTranslate,
}: Props) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(recording.transcript);
  const [target, setTarget] = useState(recording.translationLang || "en");
  const status = statusInfo(recording);
  const busy = isRecordingBusy(recording);
  const gapCount = recording.gaps?.length ?? 0;
  const gapSeconds = totalGapSeconds(recording.gaps);

  const saveEdit = () => {
    onUpdateTranscript(draft.trim());
    setEditing(false);
  };

  const tone =
    status.tone === "destructive"
      ? "bg-destructive/12 text-destructive"
      : busy
        ? "bg-primary/12 text-primary"
        : "bg-success/15 text-success";

  return (
    <article className="min-w-0 animate-sheet-in">
      {/* Zpět jako v iOS (jen na mobilu, na počítači je seznam vedle) */}
      <button
        type="button"
        onClick={onClose}
        className="press -ml-2 mb-1 inline-flex h-11 items-center gap-0.5 rounded-full pl-1 pr-3 text-[1.0625rem] text-primary lg:hidden"
      >
        <ChevronLeft className="size-6" aria-hidden="true" /> Knihovna
      </button>

      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[1.75rem] font-bold leading-tight tracking-[-0.02em] text-foreground">
            {recording.title ||
              new Date(recording.createdAt).toLocaleString("cs-CZ", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
          </h2>
          <p className="footnote mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{new Date(recording.createdAt).toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" })}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{formatDuration(recording.duration)}</span>
            {recording.group ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{recording.group}</span>
              </>
            ) : null}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.8125rem] font-semibold ${tone}`}>
              {busy ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
              {status.label}
            </span>
            {gapCount > 0 ? (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2.5 py-0.5 text-[0.8125rem] font-semibold text-warning"
                title={recording.gaps?.map((gap) => `v ${formatDuration(gap.at)}: ${gap.seconds} s`).join(", ")}
              >
                <PauseCircle className="size-3.5" aria-hidden="true" />
                Přerušeno {gapCount === 1 ? "1×" : `${gapCount}×`}, celkem {formatDuration(gapSeconds)}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zavřít detail"
          className="press hidden size-8 shrink-0 place-items-center rounded-full bg-fill text-muted-foreground lg:grid"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </header>

      {busy ? (
        <div className="grouped mt-4 px-4 py-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[0.9375rem]">
            <span className="flex min-w-0 items-center gap-2 text-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
              <span className="truncate">
                {STAGE_LABELS[recording.stage ?? ""] ?? "Zpracovávám"}
                {recording.stageDetail ? <span className="text-muted-foreground"> · část {recording.stageDetail}</span> : null}
              </span>
            </span>
            <span className="footnote tabular-nums">{recording.progress ?? 0} %</span>
          </div>
          <Progress value={recording.progress ?? 0} className="mt-2 h-1" aria-label="Průběh zpracování" />
        </div>
      ) : null}

      {recording.uploadStatus === "running" ? (
        <div className="grouped mt-4 px-4 py-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-[0.9375rem]">
            <span className="text-foreground">Ukládám zvuk do cloudu</span>
            <span className="footnote tabular-nums">{recording.uploadProgress ?? 0} %</span>
          </div>
          <Progress value={recording.uploadProgress ?? 0} className="mt-2 h-1" aria-label="Průběh ukládání zvuku" />
        </div>
      ) : recording.uploadStatus === "error" ? (
        <p className="footnote mt-3 px-1" role="alert">
          Zvuk je uložený v tomto zařízení, cloudové uložení se ale nedokončilo.
        </p>
      ) : null}

      {!busy && recording.failedChunks ? (
        <div className="grouped mt-4 p-4" role="alert">
          <p className="headline text-destructive">Některé části se nepodařilo přepsat</p>
          <p className="mt-1 text-[0.9375rem] text-foreground">
            Chybí {recording.failedChunks} z {recording.chunkCount ?? "?"} částí. Zbytek přepisu je zachovaný ve správném pořadí.
          </p>
          <button type="button" className="press mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-fill px-4 font-semibold text-primary" onClick={onRetry}>
            <RotateCcw className="size-4" aria-hidden="true" /> Zpracovat znovu
          </button>
        </div>
      ) : null}

      {recording.status === "error" ? (
        <div className="grouped mt-4 p-4" role="alert">
          <p className="headline text-destructive">Přepis se nepodařilo dokončit</p>
          <p className="mt-1 text-[0.9375rem] text-foreground">{recording.error || "Zkuste nahrávku nahrát znovu."}</p>
          {recording.hasAudio ? (
            <button
              type="button"
              className="press mt-3 inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 font-semibold text-primary-foreground disabled:opacity-40"
              disabled={busy}
              onClick={onRetry}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Zkusit přepis znovu
            </button>
          ) : null}
        </div>
      ) : (
        <Tabs defaultValue="summary" className="mt-5 gap-0">
          <TabsList className="segmented grid h-auto w-full grid-flow-col auto-cols-fr bg-[var(--fill)] p-[2px]">
            <TabsTrigger value="summary" className="gap-1.5 border-0 text-foreground data-[state=active]:bg-card dark:data-[state=active]:bg-[#636366]">
              <Sparkles className="size-3.5" aria-hidden="true" /> Shrnutí
            </TabsTrigger>
            <TabsTrigger value="transcript" className="gap-1.5 border-0 text-foreground data-[state=active]:bg-card dark:data-[state=active]:bg-[#636366]">
              <FileText className="size-3.5" aria-hidden="true" /> Přepis
            </TabsTrigger>
            <TabsTrigger value="translation" className="gap-1.5 border-0 text-foreground data-[state=active]:bg-card dark:data-[state=active]:bg-[#636366]">
              <Languages className="size-3.5" aria-hidden="true" /> Překlad
            </TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="mt-4 animate-fade-in">
            <div className="grouped">
              <div className="flex items-center justify-between gap-2 py-1 pl-4 pr-1">
                <span className="section-label px-0">Hlavní body</span>
                <div className="flex items-center">
                  <ToolbarButton label="Kopírovat shrnutí" disabled={!recording.summary} onClick={() => onCopy(recording.summary ?? "")}>
                    <Copy className="size-[1.125rem]" aria-hidden="true" />
                  </ToolbarButton>
                  <ToolbarButton
                    label="Vytvořit shrnutí znovu"
                    disabled={recording.status !== "done" || recording.summaryStatus === "running"}
                    onClick={onRefreshSummary}
                  >
                    <RefreshCw className="size-[1.125rem]" aria-hidden="true" />
                  </ToolbarButton>
                  <ToolbarButton label="Exportovat shrnutí" disabled={recording.summaryStatus !== "done"} onClick={onExportSummary}>
                    <Download className="size-[1.125rem]" aria-hidden="true" />
                  </ToolbarButton>
                </div>
              </div>
              <div className="border-t border-separator px-4 py-4">
                {recording.summaryStatus === "error" ? (
                  <p className="text-[0.9375rem] text-destructive" role="alert">{recording.summaryError}</p>
                ) : recording.summary ? (
                  <p className="whitespace-pre-wrap text-[1.0625rem] leading-[1.6] text-foreground">{recording.summary}</p>
                ) : (
                  <div className="flex min-h-36 flex-col items-center justify-center gap-2 text-center" aria-live="polite">
                    <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
                    <p className="headline text-foreground">Připravuji shrnutí</p>
                    <p className="footnote">Mezitím můžete aplikaci dál používat.</p>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="transcript" className="mt-4 animate-fade-in">
            <div className="flex items-center gap-2">
              <label className="search-field relative flex h-10 min-w-0 flex-1 items-center">
                <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <input
                  className="h-full w-full bg-transparent pl-8 pr-3 text-[1.0625rem] text-foreground outline-none placeholder:text-muted-foreground"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Hledat v přepisu"
                  aria-label="Hledat v přepisu"
                  type="search"
                />
              </label>
              {editing ? (
                <button
                  type="button"
                  className="press h-10 rounded-full bg-primary px-4 text-[0.9375rem] font-semibold text-primary-foreground"
                  onClick={saveEdit}
                >
                  Hotovo
                </button>
              ) : (
                <button
                  type="button"
                  className="press h-10 rounded-full px-3 text-[1.0625rem] text-primary hover:bg-fill disabled:opacity-30"
                  disabled={recording.status !== "done"}
                  onClick={() => {
                    setDraft(recording.transcript);
                    setEditing(true);
                  }}
                >
                  Upravit
                </button>
              )}
            </div>

            <div className="grouped mt-3">
              <div className="flex items-center justify-between gap-2 py-1 pl-4 pr-1">
                <span className="section-label px-0">Celý přepis</span>
                <div className="flex items-center">
                  <ToolbarButton label="Kopírovat přepis" disabled={!recording.transcript} onClick={() => onCopy(recording.transcript)}>
                    <Copy className="size-[1.125rem]" aria-hidden="true" />
                  </ToolbarButton>
                  <ToolbarButton label="Exportovat přepis" disabled={recording.status !== "done"} onClick={onExportTranscript}>
                    <Download className="size-[1.125rem]" aria-hidden="true" />
                  </ToolbarButton>
                </div>
              </div>
              {recording.refineStatus === "running" ? (
                <p className="footnote flex items-center gap-2 border-t border-separator px-4 py-2" aria-live="polite">
                  <WandSparkles className="size-4" aria-hidden="true" /> Dolaďuji češtinu, jména a čísla…
                </p>
              ) : null}
              <div className="max-h-[60vh] overflow-y-auto overscroll-contain border-t border-separator px-4 py-4 lg:max-h-[34rem]">
                {editing ? (
                  <Textarea
                    className="min-h-80 resize-y border-0 bg-transparent p-0 text-[1.0625rem] leading-[1.6] shadow-none focus-visible:ring-0"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    aria-label="Upravit celý přepis"
                  />
                ) : recording.transcript ? (
                  <HighlightedText text={recording.transcript} query={query} />
                ) : (
                  <p className="footnote flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Přepisuji první slova…
                  </p>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="translation" className="mt-4 animate-fade-in">
            <div className="grouped">
              <label className="flex min-h-11 items-center gap-3 pl-4 pr-1">
                <span className="flex-1 text-[1.0625rem] text-foreground">Přeložit do</span>
                <Select value={target} onValueChange={setTarget} disabled={busy}>
                  <SelectTrigger
                    className="h-11 w-auto gap-1 border-0 bg-transparent pr-3 text-[1.0625rem] text-muted-foreground shadow-none focus-visible:ring-0"
                    aria-label="Jazyk překladu"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSLATION_LANGS.map((lang) => (
                      <SelectItem key={lang.value} value={lang.value}>
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>
            <button
              type="button"
              className="press mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-[0.875rem] bg-primary text-[1.0625rem] font-semibold text-primary-foreground disabled:opacity-40"
              disabled={busy || !recording.transcript}
              onClick={() => onTranslate(target)}
            >
              <Languages className="size-5" aria-hidden="true" /> {recording.translation ? "Přeložit znovu" : "Přeložit"}
            </button>
            <p className="footnote mt-2 px-4">Dlouhé přepisy se překládají po částech a spojí se ve stejném pořadí.</p>

            {recording.translationStatus === "running" ? (
              <div className="mt-3 px-1">
                <p className="footnote flex items-center justify-between gap-3">
                  <span>{recording.stageDetail ? `Překládám – ${recording.stageDetail}` : "Připravuji překlad…"}</span>
                  <span className="tabular-nums">{recording.progress ?? 0} %</span>
                </p>
                <Progress value={recording.progress ?? 0} className="mt-1.5 h-1" aria-label="Průběh překladu" />
              </div>
            ) : null}

            {recording.translationError ? (
              <div className="grouped mt-3 p-4" role="alert">
                <p className="text-[0.9375rem] text-destructive">{recording.translationError}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(recording.translationParts ?? []).some((part) => part.trim()) ? (
                    <button
                      type="button"
                      className="press h-11 rounded-full bg-fill px-4 font-semibold text-primary disabled:opacity-40"
                      disabled={busy}
                      onClick={() => onTranslate(target, { resume: true })}
                    >
                      Dokončit chybějící části
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="press h-11 rounded-full bg-fill px-4 font-semibold text-primary disabled:opacity-40"
                    disabled={busy}
                    onClick={() => onTranslate(target)}
                  >
                    Zkusit znovu od začátku
                  </button>
                </div>
              </div>
            ) : null}

            {recording.translation || recording.translationStatus === "running" ? (
              <div className="grouped mt-4">
                <div className="flex items-center justify-between gap-2 py-1 pl-4 pr-1">
                  <span className="section-label px-0">Překlad</span>
                  <div className="flex items-center">
                    <ToolbarButton label="Kopírovat překlad" disabled={!recording.translation} onClick={() => onCopy(recording.translation ?? "")}>
                      <Copy className="size-[1.125rem]" aria-hidden="true" />
                    </ToolbarButton>
                    <ToolbarButton label="Exportovat překlad" disabled={!recording.translation} onClick={onExportTranslation}>
                      <Download className="size-[1.125rem]" aria-hidden="true" />
                    </ToolbarButton>
                  </div>
                </div>
                <div className="max-h-[60vh] overflow-y-auto overscroll-contain border-t border-separator px-4 py-4 lg:max-h-[34rem]">
                  {recording.translation ? (
                    <p className="whitespace-pre-wrap text-[1.0625rem] leading-[1.6] text-foreground">{recording.translation}</p>
                  ) : (
                    <p className="footnote flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Překládám…
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      )}

      {/* Zvuk a mazání jako seskupený seznam; mazání je oddělené a červené. */}
      <div className="mt-6 space-y-6">
        {recording.hasAudio ? (
          <div>
            <h3 className="section-label mb-1.5">Zvuk</h3>
            <div className="grouped">
              <button type="button" className="grouped-row tap-row flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left" onClick={onTogglePlayer}>
                {audioUrl ? <X className="size-5 text-primary" aria-hidden="true" /> : <Play className="size-5 text-primary" aria-hidden="true" />}
                <span className="text-[1.0625rem] text-primary">{audioUrl ? "Zavřít přehrávač" : "Přehrát nahrávku"}</span>
              </button>
              {audioUrl ? (
                <div className="grouped-row px-4 py-3">
                  <audio className="w-full" controls src={audioUrl}>
                    Váš prohlížeč nepodporuje přehrávání zvuku.
                  </audio>
                </div>
              ) : null}
              <button type="button" className="grouped-row tap-row flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left" onClick={onExportAudio}>
                <Music className="size-5 text-primary" aria-hidden="true" />
                <span className="text-[1.0625rem] text-primary">Exportovat zvuk</span>
              </button>
            </div>
          </div>
        ) : null}

        <div className="grouped">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button type="button" className="tap-row flex min-h-11 w-full items-center justify-center gap-2 px-4 py-2.5 text-[1.0625rem] text-destructive">
                <Trash2 className="size-5" aria-hidden="true" /> Smazat nahrávku
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent className="max-w-[20rem] gap-0 rounded-[0.875rem] p-0 text-center">
              <AlertDialogHeader className="px-5 pb-4 pt-5 text-center sm:text-center">
                <AlertDialogTitle className="headline text-[1.0625rem]">Smazat nahrávku?</AlertDialogTitle>
                <AlertDialogDescription className="text-[0.8125rem] leading-5 text-foreground/80">
                  Zvuk, přepis, shrnutí i překlad budou trvale odstraněny. Tuto akci nelze vrátit.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="grid grid-cols-2 gap-0 sm:grid sm:space-x-0">
                <AlertDialogCancel className="m-0 h-11 rounded-none border-0 border-r border-t border-separator bg-transparent text-[1.0625rem] text-primary shadow-none hover:bg-fill">
                  Zrušit
                </AlertDialogCancel>
                <AlertDialogAction
                  className="m-0 h-11 rounded-none border-0 border-t border-separator bg-transparent text-[1.0625rem] font-semibold text-destructive shadow-none hover:bg-fill"
                  onClick={onDelete}
                >
                  Smazat
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </article>
  );
});
