-- v70 — Online-sales interface (Axel review 2026-09-06): sales channels become an editable list
-- (add / remove from the Commande screen) instead of a hardcoded suggestion list.
-- Service-role only (RLS on, no policies), same posture as lab_online_orders.
CREATE TABLE IF NOT EXISTS public.lab_online_channels (
  name text PRIMARY KEY,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lab_online_channels ENABLE ROW LEVEL SECURITY;
INSERT INTO public.lab_online_channels (name) VALUES ('Hoàn Kiếm'), ('Moon Flower'), ('Website'), ('Page Merci')
ON CONFLICT (name) DO NOTHING;
