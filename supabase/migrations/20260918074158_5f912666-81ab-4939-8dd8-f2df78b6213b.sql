ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS translation TEXT,
  ADD COLUMN IF NOT EXISTS translation_lang TEXT;