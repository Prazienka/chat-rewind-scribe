-- Soukromý bucket na zvuk nahrávek (dřív ho vytvářel Lovable mimo migrace).
INSERT INTO storage.buckets (id, name, public)
VALUES ('recordings', 'recordings', false)
ON CONFLICT (id) DO NOTHING;
