// Cloud a přihlášení se stahují až po prvním vykreslení, aby úvodní načtení
// stránky bylo co nejrychlejší (na mobilu se aplikace otevírá z plochy).
import type { CloudRecording } from "./cloud";

const cloud = () => import("./cloud");
export const getSupabase = () =>
  import("@/integrations/supabase/client").then((m) => m.supabase);

/** Předehřát cloudové moduly, až bude prohlížeč nečinný. */
export function prefetchCloud() {
  const run = () => {
    void cloud();
    void getSupabase();
  };
  if (typeof window === "undefined") return;
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;
  if (idle) idle(run);
  else setTimeout(run, 1200);
}

export const fetchCloudRecordings = async () => (await cloud()).fetchCloudRecordings();
export const upsertCloudRecording = async (userId: string, rec: CloudRecording) =>
  (await cloud()).upsertCloudRecording(userId, rec);
export const deleteCloudRecording = async (id: string, audioPath?: string) =>
  (await cloud()).deleteCloudRecording(id, audioPath);
export const uploadCloudAudio = async (
  userId: string,
  id: string,
  blob: Blob,
  filename: string,
) => (await cloud()).uploadCloudAudio(userId, id, blob, filename);
export const uploadCloudAudioChunks = async (
  userId: string,
  id: string,
  chunks: Blob[],
  onProgress?: (done: number, total: number) => void,
) => (await cloud()).uploadCloudAudioChunks(userId, id, chunks, onProgress);
export const downloadCloudAudio = async (path: string) =>
  (await cloud()).downloadCloudAudio(path);
export const fetchCloudGroups = async () => (await cloud()).fetchCloudGroups();
export const addCloudGroup = async (userId: string, name: string) =>
  (await cloud()).addCloudGroup(userId, name);
export const deleteCloudGroup = async (name: string) => (await cloud()).deleteCloudGroup(name);
