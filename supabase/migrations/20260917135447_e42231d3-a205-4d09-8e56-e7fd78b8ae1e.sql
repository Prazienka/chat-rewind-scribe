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