const DB_NAME = "zapisnik";
const STORE = "audio";
const SEGMENTS = "segments";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(SEGMENTS)) db.createObjectStore(SEGMENTS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

type StoredAudio = { blob?: Blob; filename: string; segmentSession?: string };

export async function saveAudio(id: string, blob: Blob, filename: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ blob, filename } satisfies StoredAudio, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable – export of audio simply won't be offered */
  }
}

/** Připojí již uložené segmenty k hotové nahrávce bez vytvoření druhé velké kopie. */
export async function saveSegmentedAudio(
  id: string,
  segmentSession: string,
  filename: string,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ filename, segmentSession } satisfies StoredAudio, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadAudio(id: string): Promise<{ blob: Blob; filename: string } | null> {
  try {
    const db = await openDb();
    const result = await new Promise<StoredAudio | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as StoredAudio | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!result) return null;
    if (result.blob) return { blob: result.blob, filename: result.filename };
    if (!result.segmentSession) return null;
    const segments = await loadSegments(result.segmentSession);
    if (segments.length === 0) return null;
    const { mergeWavBlobs } = await import("./audio-chunks");
    return { blob: mergeWavBlobs(segments), filename: result.filename };
  } catch {
    return null;
  }
}

export async function deleteAudio(id: string): Promise<void> {
  try {
    const db = await openDb();
    const stored = await new Promise<StoredAudio | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as StoredAudio | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
    if (stored?.segmentSession) await deleteSegments(stored.segmentSession);
  } catch {
    /* ignore */
  }
}

/* ---- Segmenty probíhající nahrávky ----------------------------------------
   Nahrávka se ukládá po částech, takže se při zamrznutí, vybité baterii nebo
   zavření aplikace neztratí to, co už je hotové. */

const segmentKey = (session: string, index: number) => `${session}:${String(index).padStart(5, "0")}`;

export async function saveSegment(session: string, index: number, blob: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, "readwrite");
    tx.objectStore(SEGMENTS).put(blob, segmentKey(session, index));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function loadSegments(session: string): Promise<Blob[]> {
  try {
    const db = await openDb();
    const result = await new Promise<Blob[]>((resolve) => {
      const tx = db.transaction(SEGMENTS, "readonly");
      const store = tx.objectStore(SEGMENTS);
      const range = IDBKeyRange.bound(`${session}:`, `${session}:\uffff`);
      const req = store.getAll(range);
      req.onsuccess = () => resolve((req.result as Blob[] | undefined) ?? []);
      req.onerror = () => resolve([]);
    });
    db.close();
    return result;
  } catch {
    return [];
  }
}

export async function deleteSegments(session: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(SEGMENTS, "readwrite");
      tx.objectStore(SEGMENTS).delete(IDBKeyRange.bound(`${session}:`, `${session}:\uffff`));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}
