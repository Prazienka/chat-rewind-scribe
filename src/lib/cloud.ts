import { supabase } from "@/integrations/supabase/client";

export type CloudRecording = {
  id: string;
  createdAt: number;
  duration: number;
  transcript: string;
  status: "running" | "done" | "error";
  title?: string;
  rawTranscript?: string;
  summary?: string;
  summaryStatus?: "running" | "done" | "error";
  translation?: string;
  translationLang?: string;
  group?: string;
  hasAudio?: boolean;
  audioName?: string;
  audioPath?: string;
};

type Row = {
  id: string;
  title: string | null;
  group_name: string | null;
  duration: number | null;
  transcript: string | null;
  raw_transcript: string | null;
  summary: string | null;
  translation: string | null;
  translation_lang: string | null;
  status: string | null;
  audio_name: string | null;
  audio_path: string | null;
  created_at: string;
};

const BUCKET = "recordings";
const CHUNK_PATH_PREFIX = "chunks:";

function audioPaths(value?: string): string[] {
  if (!value) return [];
  if (!value.startsWith(CHUNK_PATH_PREFIX)) return [value];
  try {
    const parsed = JSON.parse(value.slice(CHUNK_PATH_PREFIX.length)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const fromRow = (row: Row): CloudRecording => ({
  id: row.id,
  createdAt: new Date(row.created_at).getTime(),
  duration: row.duration ?? 0,
  transcript: row.transcript ?? "",
  status: (row.status as CloudRecording["status"]) ?? "done",
  title: row.title ?? "",
  rawTranscript: row.raw_transcript ?? "",
  summary: row.summary ?? "",
  ...(row.summary ? { summaryStatus: "done" as const } : {}),
  translation: row.translation ?? "",
  translationLang: row.translation_lang ?? "",
  group: row.group_name ?? "",
  hasAudio: Boolean(row.audio_path),
  audioName: row.audio_name ?? "",
  audioPath: row.audio_path ?? "",
});

export async function fetchCloudRecordings(): Promise<CloudRecording[]> {
  const { data, error } = await supabase
    .from("recordings")
    .select(
      "id,title,group_name,duration,transcript,raw_transcript,summary,translation,translation_lang,status,audio_name,audio_path,created_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(fromRow);
}

export async function upsertCloudRecording(userId: string, rec: CloudRecording) {
  const { error } = await supabase.from("recordings").upsert(
    {
      id: rec.id,
      user_id: userId,
      title: rec.title || null,
      group_name: rec.group || null,
      duration: rec.duration ?? 0,
      transcript: rec.transcript ?? "",
      raw_transcript: rec.rawTranscript || null,
      summary: rec.summary || null,
      translation: rec.translation || null,
      translation_lang: rec.translationLang || null,
      status: rec.status ?? "done",
      audio_name: rec.audioName || null,
      audio_path: rec.audioPath || null,
      created_at: new Date(rec.createdAt).toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw error;
}

export async function deleteCloudRecording(id: string, audioPath?: string) {
  const paths = audioPaths(audioPath);
  if (paths.length > 0) await supabase.storage.from(BUCKET).remove(paths);
  const { error } = await supabase.from("recordings").delete().eq("id", id);
  if (error) throw error;
}

export async function uploadCloudAudioChunks(
  userId: string,
  id: string,
  chunks: Blob[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const paths: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const path = `${userId}/${id}/${String(index).padStart(4, "0")}.wav`;
    let uploaded = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, chunk, { upsert: true, contentType: "audio/wav" });
      if (!error) uploaded = true;
      else {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
    if (!uploaded) throw lastError instanceof Error ? lastError : new Error("chunk-upload-failed");
    paths.push(path);
    onProgress?.(index + 1, chunks.length);
  }
  return `${CHUNK_PATH_PREFIX}${JSON.stringify(paths)}`;
}

export async function uploadCloudAudio(
  userId: string,
  id: string,
  blob: Blob,
  filename: string,
): Promise<string> {
  const ext = filename.includes(".") ? filename.split(".").pop() : "wav";
  const path = `${userId}/${id}.${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true, contentType: blob.type || "audio/wav" });
  if (error) throw error;
  return path;
}

export async function downloadCloudAudio(path: string): Promise<Blob | null> {
  const paths = audioPaths(path);
  if (paths.length === 0) return null;
  const blobs: Blob[] = [];
  for (const item of paths) {
    const { data, error } = await supabase.storage.from(BUCKET).download(item);
    if (error) return null;
    blobs.push(data);
  }
  if (path.startsWith(CHUNK_PATH_PREFIX)) {
    const { mergeWavBlobs } = await import("./audio-chunks");
    return mergeWavBlobs(blobs);
  }
  return blobs[0] ?? null;
}

export async function fetchCloudGroups(): Promise<string[]> {
  const { data, error } = await supabase
    .from("user_groups")
    .select("name")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { name: string }[]).map((g) => g.name);
}

export async function addCloudGroup(userId: string, name: string) {
  const { error } = await supabase
    .from("user_groups")
    .upsert({ user_id: userId, name }, { onConflict: "user_id,name" });
  if (error) throw error;
}

export async function deleteCloudGroup(name: string) {
  const { error } = await supabase.from("user_groups").delete().eq("name", name);
  if (error) throw error;
}
