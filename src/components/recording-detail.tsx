import { memo, useMemo, useState } from "react";
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
import { formatDuration } from "@/lib/wav";

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
  uploadProgress?: number;
  uploadStatus?: "running" | "done" | "error";
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
  onTranslate: (target: string) => void;
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

function statusInfo(recording: RecordingView) {
  if (recording.status === "error") return { label: "Přepis selhal", tone: "destructive" as const };
  if (recording.stage) return { label: STAGE_LABELS[recording.stage] ?? "Zpracovávám", tone: "secondary" as const };
  if (recording.status === "running") return { label: "Přepisuji zvuk", tone: "secondary" as const };
  if (recording.refineStatus === "running") return { label: "Upravuji češtinu", tone: "secondary" as const };
  if (recording.summaryStatus === "running") return { label: "Tvořím shrnutí", tone: "secondary" as const };
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
    <p className="whitespace-pre-wrap text-[0.9375rem] leading-7 text-foreground">
      {parts.map((part, index) =>
        query.trim() && part.toLocaleLowerCase("cs").includes(query.trim().toLocaleLowerCase("cs")) ? (
          <mark key={`${part}-${index}`} className="rounded-sm bg-accent px-0.5 text-accent-foreground">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
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
  const busy = Boolean(recording.stage);

  const saveEdit = () => {
    onUpdateTranscript(draft.trim());
    setEditing(false);
  };

  return (
    <article className="min-w-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 border-b border-border p-4 sm:p-6">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant={status.tone} className="gap-1.5">
              {recording.status === "running" || recording.refineStatus === "running" || recording.summaryStatus === "running" ? (
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              ) : null}
              {status.label}
            </Badge>
            {recording.group ? <Badge variant="secondary">{recording.group}</Badge> : null}
          </div>
          <h2 className="truncate font-display text-xl font-semibold text-foreground sm:text-2xl">
            {recording.title || new Date(recording.createdAt).toLocaleString("cs-CZ")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(recording.createdAt).toLocaleString("cs-CZ")} · {formatDuration(recording.duration)}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Zavřít detail" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>

      {busy ? (
        <div className="border-b border-border bg-muted/30 px-4 py-3 sm:px-6" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-foreground">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
              {STAGE_LABELS[recording.stage ?? ""] ?? "Zpracovávám"}
              {recording.stageDetail ? <span className="text-muted-foreground">· část {recording.stageDetail}</span> : null}
            </span>
            <span className="tabular-nums text-muted-foreground">{recording.progress ?? 0} %</span>
          </div>
          <Progress value={recording.progress ?? 0} className="mt-2 h-1.5" aria-label="Průběh zpracování" />
        </div>
      ) : null}

      {recording.uploadStatus === "running" ? (
        <div className="border-b border-border bg-muted/30 px-4 py-3 sm:px-6" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-foreground">Ukládám zvuk po částech do cloudu</span>
            <span className="tabular-nums text-muted-foreground">{recording.uploadProgress ?? 0} %</span>
          </div>
          <Progress value={recording.uploadProgress ?? 0} className="mt-2 h-1.5" aria-label="Průběh ukládání zvuku" />
        </div>
      ) : recording.uploadStatus === "error" ? (
        <p className="border-b border-border bg-destructive/5 px-4 py-3 text-sm text-destructive sm:px-6" role="alert">
          Zvuk je uložený v tomto zařízení, cloudové uložení se ale nedokončilo.
        </p>
      ) : null}

      {!busy && recording.failedChunks ? (
        <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 sm:m-6" role="alert">
          <p className="font-medium text-destructive">Některé části se nepodařilo přepsat</p>
          <p className="mt-1 text-sm text-foreground">
            Chybí {recording.failedChunks} z {recording.chunkCount ?? "?"} částí. Zbytek přepisu je zachovaný ve správném pořadí.
          </p>
          <Button variant="outline" className="mt-3 min-h-11" onClick={onRetry}>
            <RotateCcw aria-hidden="true" /> Zpracovat znovu
          </Button>
        </div>
      ) : null}

      {recording.status === "error" ? (
        <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 sm:m-6" role="alert">
          <p className="font-medium text-destructive">Přepis se nepodařilo dokončit</p>
          <p className="mt-1 text-sm text-foreground">{recording.error || "Zkuste nahrávku nahrát znovu."}</p>
          {recording.hasAudio ? (
            <Button variant="outline" className="mt-3 min-h-11" disabled={busy} onClick={onRetry}>
              <RotateCcw aria-hidden="true" /> Zkusit přepis znovu
            </Button>
          ) : null}
        </div>
      ) : (
        <Tabs defaultValue="summary" className="p-4 sm:p-6">
          <TabsList className="grid h-11 w-full grid-cols-3 sm:w-auto">
            <TabsTrigger value="summary" className="h-9 gap-2">
              <Sparkles aria-hidden="true" /> AI shrnutí
            </TabsTrigger>
            <TabsTrigger value="transcript" className="h-9 gap-2">
              <FileText aria-hidden="true" /> Celý přepis
            </TabsTrigger>
            <TabsTrigger value="translation" className="h-9 gap-2">
              <Languages aria-hidden="true" /> Překlad
            </TabsTrigger>
          </TabsList>


          <TabsContent value="summary" className="mt-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">Nejdůležitější body rozhovoru</p>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Kopírovat AI shrnutí" disabled={!recording.summary} onClick={() => onCopy(recording.summary ?? "")}>
                  <Copy aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Vytvořit AI shrnutí znovu" disabled={recording.status !== "done" || recording.summaryStatus === "running"} onClick={onRefreshSummary}>
                  <RefreshCw aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Exportovat AI shrnutí" disabled={recording.summaryStatus !== "done"} onClick={onExportSummary}>
                  <Download aria-hidden="true" />
                </Button>
              </div>
            </div>
            {recording.summaryStatus === "error" ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">{recording.summaryError}</p>
            ) : recording.summary ? (
              <p className="whitespace-pre-wrap rounded-md bg-muted/60 p-4 text-[0.9375rem] leading-7 text-foreground sm:p-5">{recording.summary}</p>
            ) : (
              <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border p-6 text-center" aria-live="polite">
                <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
                <div>
                  <p className="font-medium text-foreground">AI připravuje shrnutí</p>
                  <p className="mt-1 text-sm text-muted-foreground">Můžete mezitím pokračovat v aplikaci.</p>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="transcript" className="mt-5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <label className="relative block min-w-0">
                <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input className="h-11 pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat v přepisu…" aria-label="Hledat v přepisu" />
              </label>
              <div className="flex items-center gap-1">
                {editing ? (
                  <Button className="min-h-11" onClick={saveEdit}><Check aria-hidden="true" /> Uložit změny</Button>
                ) : (
                  <Button variant="outline" className="min-h-11" disabled={recording.status !== "done"} onClick={() => { setDraft(recording.transcript); setEditing(true); }}><Pencil aria-hidden="true" /> Upravit</Button>
                )}
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Kopírovat celý přepis" disabled={!recording.transcript} onClick={() => onCopy(recording.transcript)}><Copy aria-hidden="true" /></Button>
                <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Exportovat celý přepis" disabled={recording.status !== "done"} onClick={onExportTranscript}><Download aria-hidden="true" /></Button>
              </div>
            </div>

            {recording.refineStatus === "running" ? (
              <p className="mt-3 inline-flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite"><WandSparkles className="size-4" aria-hidden="true" /> Dolaďuji češtinu, jména a čísla…</p>
            ) : null}
            <div className="mt-4 max-h-[34rem] overflow-y-auto rounded-md border border-border bg-background p-4 sm:p-5">
              {editing ? (
                <Textarea className="min-h-80 resize-y border-0 p-0 leading-7 shadow-none focus-visible:ring-0" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Upravit celý přepis" />
              ) : recording.transcript ? (
                <HighlightedText text={recording.transcript} query={query} />
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Přepisuji první slova…</p>
              )}
            </div>
          </TabsContent>

          <TabsContent value="translation" className="mt-5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_auto_auto_auto]">
              <Select value={target} onValueChange={setTarget} disabled={busy}>
                <SelectTrigger className="h-11" aria-label="Jazyk překladu"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRANSLATION_LANGS.map((lang) => (
                    <SelectItem key={lang.value} value={lang.value}>{lang.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button className="min-h-11" disabled={busy || !recording.transcript} onClick={() => onTranslate(target)}>
                <Languages aria-hidden="true" /> {recording.translation ? "Přeložit znovu" : "Přeložit"}
              </Button>
              <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Kopírovat překlad" disabled={!recording.translation} onClick={() => onCopy(recording.translation ?? "")}>
                <Copy aria-hidden="true" />
              </Button>
              <Button variant="ghost" size="icon" className="min-h-11 min-w-11" aria-label="Exportovat překlad" disabled={!recording.translation} onClick={onExportTranslation}>
                <Download aria-hidden="true" />
              </Button>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Dlouhé přepisy se překládají po částech a spojí se do jednoho souvislého textu ve stejném pořadí.
            </p>
            {recording.translationError ? (
              <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive" role="alert">{recording.translationError}</p>
            ) : null}
            <div className="mt-4 max-h-[34rem] overflow-y-auto rounded-md border border-border bg-background p-4 sm:p-5">
              {recording.translation ? (
                <p className="whitespace-pre-wrap text-[0.9375rem] leading-7 text-foreground">{recording.translation}</p>
              ) : recording.translationStatus === "running" ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /> Překládám…</p>
              ) : (
                <p className="text-sm text-muted-foreground">Vyberte jazyk a spusťte překlad celého přepisu.</p>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}

      <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 p-4 sm:px-6">
        {recording.hasAudio ? (
          <>
            <Button variant="outline" className="min-h-11" onClick={onTogglePlayer}>
              {audioUrl ? <X aria-hidden="true" /> : <Play aria-hidden="true" />}
              {audioUrl ? "Zavřít přehrávač" : "Přehrát záznam"}
            </Button>
            <Button variant="ghost" className="min-h-11" onClick={onExportAudio}><Music aria-hidden="true" /> Export zvuku</Button>
          </>
        ) : null}
        <Button variant="ghost" className="min-h-11 text-destructive hover:text-destructive sm:ml-auto" onClick={onDelete}><Trash2 aria-hidden="true" /> Smazat</Button>
        {audioUrl ? <audio className="w-full" controls src={audioUrl}>Váš prohlížeč nepodporuje přehrávání zvuku.</audio> : null}
      </footer>
    </article>
  );
});