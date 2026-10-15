-- Kompletní nastavení databáze Chat Scribe pro nový Supabase projekt.
-- Vložte celé do Supabase → SQL Editor → Run. Spouští se jen jednou.

-- 20260917135447_e42231d3-a205-4d09-8e56-e7fd78b8ae1e.sql
CREATE TABLE public.recordings (
  id UUID NOT NULL PRIMARY KEY,
  user_id UUID NOT NULL,
  title TEXT,
  group_name TEXT,
  duration DOUBLE PRECISION NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '',
  raw_transcript TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  audio_name TEXT,
  audio_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.recordings TO authenticated;
GRANT ALL ON public.recordings TO service_role;
ALTER TABLE public.recordings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own recordings" ON public.recordings FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX recordings_user_created_idx ON public.recordings (user_id, created_at DESC);

CREATE TABLE public.user_groups (
  id UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_groups TO authenticated;
GRANT ALL ON public.user_groups TO service_role;
ALTER TABLE public.user_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own groups" ON public.user_groups FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER recordings_touch_updated_at BEFORE UPDATE ON public.recordings
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 20260917135508_3e25281a-b277-498b-9e00-71be1ba0694e.sql
CREATE POLICY "Users read own audio" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'recordings' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users upload own audio" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'recordings' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users update own audio" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'recordings' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users delete own audio" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'recordings' AND auth.uid()::text = (storage.foldername(name))[1]);

-- 20260918074158_5f912666-81ab-4939-8dd8-f2df78b6213b.sql
ALTER TABLE public.recordings
  ADD COLUMN IF NOT EXISTS translation TEXT,
  ADD COLUMN IF NOT EXISTS translation_lang TEXT;

-- 20261015120000_recordings_bucket.sql
-- Soukromý bucket na zvuk nahrávek (dřív ho vytvářel Lovable mimo migrace).
INSERT INTO storage.buckets (id, name, public)
VALUES ('recordings', 'recordings', false)
ON CONFLICT (id) DO NOTHING;


