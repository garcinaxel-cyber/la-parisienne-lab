-- v85 — Rétention v2 (Axel, 2026-09-19).
-- 1. lab_manual_cake_ledger : copie permanente (jamais purgée) de chaque gâteau manuel /
--    ligne de commande en ligne "lab" — c'est ce que lisent désormais le Suivi, l'Analytic,
--    la Base client et l'export mensuel. Maintenue par trigger, donc tous les chemins d'écriture
--    (online-orders, /exceptional-orders, /order/[token], shop-manager) sont couverts sans code.
-- 2. lab_customers : identité client par téléphone (clé = 9 derniers chiffres, même règle que
--    normalizePhoneKey côté app), alimentée par trigger depuis lab_online_orders et lab_manual_cakes.
-- 3. lab_retention_policy + lab_purge_rolling() : purge quotidienne glissante, un horizon par
--    table, modifiable en SQL sans redéploiement. Remplace lab_purge_old(60) (job lab-purge,
--    désactivé le 2026-09-19).

-- ── 1. Ledger des gâteaux manuels ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_manual_cake_ledger (
  id                uuid PRIMARY KEY,                 -- = lab_manual_cakes.id
  order_batch_id    uuid,
  fiche_id          uuid,
  variant_id        uuid,
  product_sku       text,
  product_name_vi   text,
  product_name_en   text,
  team              text,
  qty               integer,
  unit_price        numeric,
  delivery_date     date,
  ready_time        text,
  delivered_by      text,
  shop_name         text,
  channel           text,
  customer_name     text,
  customer_phone    text,
  delivery_address  text,
  district          text,
  message           text,
  design_notes      text,
  design_photo_url  text,
  notes             text,
  needs_odoo        boolean,
  matched_order_ref text,
  matched_at        timestamptz,
  cancelled_at      timestamptz,
  cancelled_by_name text,
  cancel_reason     text,
  created_by_name   text,
  created_at        timestamptz,
  source_deleted_at timestamptz,                      -- rempli quand la ligne vive est purgée
  design_photo_deleted_at timestamptz,
  ledger_updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_mc_ledger_batch_idx    ON public.lab_manual_cake_ledger(order_batch_id);
CREATE INDEX IF NOT EXISTS lab_mc_ledger_delivery_idx ON public.lab_manual_cake_ledger(delivery_date);
CREATE INDEX IF NOT EXISTS lab_mc_ledger_phone_idx    ON public.lab_manual_cake_ledger(customer_phone);
ALTER TABLE public.lab_manual_cake_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_mc_ledger_read" ON public.lab_manual_cake_ledger;
CREATE POLICY "lab_mc_ledger_read" ON public.lab_manual_cake_ledger FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant','online_sales'));
-- écritures : triggers (SECURITY DEFINER) + service_role uniquement

CREATE OR REPLACE FUNCTION public.lab_manual_cake_ledger_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO lab_manual_cake_ledger (
    id, order_batch_id, fiche_id, variant_id, product_sku, product_name_vi, product_name_en, team,
    qty, unit_price, delivery_date, ready_time, delivered_by, shop_name, channel,
    customer_name, customer_phone, delivery_address, district, message, design_notes, design_photo_url,
    notes, needs_odoo, matched_order_ref, matched_at, cancelled_at, cancelled_by_name, cancel_reason,
    created_by_name, created_at, ledger_updated_at)
  VALUES (
    NEW.id, NEW.order_batch_id, NEW.fiche_id, NEW.variant_id, NEW.product_sku, NEW.product_name_vi, NEW.product_name_en, NEW.team,
    NEW.qty, NEW.unit_price, NEW.delivery_date, NEW.ready_time, NEW.delivered_by, NEW.shop_name, NEW.channel,
    NEW.customer_name, NEW.customer_phone, NEW.delivery_address, NEW.district, NEW.message, NEW.design_notes, NEW.design_photo_url,
    NEW.notes, NEW.needs_odoo, NEW.matched_order_ref, NEW.matched_at, NEW.cancelled_at, NEW.cancelled_by_name, NEW.cancel_reason,
    NEW.created_by_name, NEW.created_at, now())
  ON CONFLICT (id) DO UPDATE SET
    order_batch_id = EXCLUDED.order_batch_id, fiche_id = EXCLUDED.fiche_id, variant_id = EXCLUDED.variant_id,
    product_sku = EXCLUDED.product_sku, product_name_vi = EXCLUDED.product_name_vi, product_name_en = EXCLUDED.product_name_en,
    team = EXCLUDED.team, qty = EXCLUDED.qty, unit_price = EXCLUDED.unit_price, delivery_date = EXCLUDED.delivery_date,
    ready_time = EXCLUDED.ready_time, delivered_by = EXCLUDED.delivered_by, shop_name = EXCLUDED.shop_name, channel = EXCLUDED.channel,
    customer_name = EXCLUDED.customer_name, customer_phone = EXCLUDED.customer_phone, delivery_address = EXCLUDED.delivery_address,
    district = EXCLUDED.district, message = EXCLUDED.message, design_notes = EXCLUDED.design_notes,
    design_photo_url = COALESCE(EXCLUDED.design_photo_url, lab_manual_cake_ledger.design_photo_url),
    notes = EXCLUDED.notes, needs_odoo = EXCLUDED.needs_odoo, matched_order_ref = EXCLUDED.matched_order_ref, matched_at = EXCLUDED.matched_at,
    cancelled_at = EXCLUDED.cancelled_at, cancelled_by_name = EXCLUDED.cancelled_by_name, cancel_reason = EXCLUDED.cancel_reason,
    created_by_name = EXCLUDED.created_by_name, created_at = EXCLUDED.created_at, ledger_updated_at = now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.lab_manual_cake_ledger_mark_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE lab_manual_cake_ledger SET source_deleted_at = now() WHERE id = OLD.id AND source_deleted_at IS NULL;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS lab_manual_cakes_ledger_sync ON public.lab_manual_cakes;
CREATE TRIGGER lab_manual_cakes_ledger_sync
  AFTER INSERT OR UPDATE ON public.lab_manual_cakes
  FOR EACH ROW EXECUTE FUNCTION public.lab_manual_cake_ledger_sync();
DROP TRIGGER IF EXISTS lab_manual_cakes_ledger_deleted ON public.lab_manual_cakes;
CREATE TRIGGER lab_manual_cakes_ledger_deleted
  AFTER DELETE ON public.lab_manual_cakes
  FOR EACH ROW EXECUTE FUNCTION public.lab_manual_cake_ledger_mark_deleted();

-- Rattrapage : tout l'existant (les lignes déjà purgées par lab_purge_old sont perdues, c'est connu).
INSERT INTO public.lab_manual_cake_ledger (
  id, order_batch_id, fiche_id, variant_id, product_sku, product_name_vi, product_name_en, team,
  qty, unit_price, delivery_date, ready_time, delivered_by, shop_name, channel,
  customer_name, customer_phone, delivery_address, district, message, design_notes, design_photo_url,
  notes, needs_odoo, matched_order_ref, matched_at, cancelled_at, cancelled_by_name, cancel_reason,
  created_by_name, created_at)
SELECT id, order_batch_id, fiche_id, variant_id, product_sku, product_name_vi, product_name_en, team,
  qty, unit_price, delivery_date, ready_time, delivered_by, shop_name, channel,
  customer_name, customer_phone, delivery_address, district, message, design_notes, design_photo_url,
  notes, needs_odoo, matched_order_ref, matched_at, cancelled_at, cancelled_by_name, cancel_reason,
  created_by_name, created_at
FROM public.lab_manual_cakes
ON CONFLICT (id) DO NOTHING;

-- ── 2. Base client permanente ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lab_phone_key(raw text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(regexp_replace(coalesce(raw,''), '\D', '', 'g')) < 8 THEN NULL
              ELSE right(regexp_replace(raw, '\D', '', 'g'), 9) END
$$;

CREATE TABLE IF NOT EXISTS public.lab_customers (
  phone_key        text PRIMARY KEY,
  customer_phone   text,
  customer_name    text,
  delivery_address text,
  district         text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  sources          text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.lab_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_customers_read" ON public.lab_customers;
CREATE POLICY "lab_customers_read" ON public.lab_customers FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager','assistant','online_sales'));

CREATE OR REPLACE FUNCTION public.lab_customers_touch(
  p_phone text, p_name text, p_address text, p_district text, p_at timestamptz, p_source text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := lab_phone_key(p_phone);
BEGIN
  IF k IS NULL THEN RETURN; END IF;
  INSERT INTO lab_customers (phone_key, customer_phone, customer_name, delivery_address, district, first_seen_at, last_seen_at, sources)
  VALUES (k, p_phone, nullif(btrim(p_name),''), nullif(btrim(p_address),''), p_district,
          coalesce(p_at, now()), coalesce(p_at, now()), CASE WHEN p_source IS NULL THEN '{}' ELSE ARRAY[p_source] END)
  ON CONFLICT (phone_key) DO UPDATE SET
    customer_phone   = CASE WHEN coalesce(p_at, now()) >= lab_customers.last_seen_at THEN coalesce(EXCLUDED.customer_phone, lab_customers.customer_phone) ELSE lab_customers.customer_phone END,
    customer_name    = CASE WHEN coalesce(p_at, now()) >= lab_customers.last_seen_at THEN coalesce(EXCLUDED.customer_name, lab_customers.customer_name) ELSE coalesce(lab_customers.customer_name, EXCLUDED.customer_name) END,
    delivery_address = CASE WHEN coalesce(p_at, now()) >= lab_customers.last_seen_at THEN coalesce(EXCLUDED.delivery_address, lab_customers.delivery_address) ELSE coalesce(lab_customers.delivery_address, EXCLUDED.delivery_address) END,
    district         = CASE WHEN coalesce(p_at, now()) >= lab_customers.last_seen_at THEN coalesce(EXCLUDED.district, lab_customers.district) ELSE coalesce(lab_customers.district, EXCLUDED.district) END,
    first_seen_at    = least(lab_customers.first_seen_at, coalesce(p_at, now())),
    last_seen_at     = greatest(lab_customers.last_seen_at, coalesce(p_at, now())),
    sources          = CASE WHEN p_source IS NULL OR p_source = ANY(lab_customers.sources) THEN lab_customers.sources ELSE lab_customers.sources || p_source END,
    updated_at       = now();
END $$;

CREATE OR REPLACE FUNCTION public.lab_customers_from_online_order() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.source,'lab') <> 'event_stock' THEN
    PERFORM lab_customers_touch(NEW.customer_phone, NEW.customer_name, NEW.delivery_address, NEW.district, NEW.created_at, 'online:' || coalesce(NEW.source,'lab'));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lab_online_orders_customers ON public.lab_online_orders;
CREATE TRIGGER lab_online_orders_customers
  AFTER INSERT OR UPDATE OF customer_name, customer_phone, delivery_address, district ON public.lab_online_orders
  FOR EACH ROW EXECUTE FUNCTION public.lab_customers_from_online_order();

CREATE OR REPLACE FUNCTION public.lab_customers_from_manual_cake() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.shop_name IS NOT NULL AND NEW.customer_phone IS NOT NULL THEN
    PERFORM lab_customers_touch(NEW.customer_phone, NEW.customer_name, NEW.delivery_address, NEW.district, NEW.created_at, 'manual_cake');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lab_manual_cakes_customers ON public.lab_manual_cakes;
CREATE TRIGGER lab_manual_cakes_customers
  AFTER INSERT OR UPDATE OF customer_name, customer_phone, delivery_address, district, shop_name ON public.lab_manual_cakes
  FOR EACH ROW EXECUTE FUNCTION public.lab_customers_from_manual_cake();

-- Rattrapage clients (ordre chronologique pour que "dernier vu" soit juste)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT customer_phone, customer_name, delivery_address, district, created_at, 'online:' || coalesce(source,'lab') AS src
      FROM lab_online_orders WHERE coalesce(source,'lab') <> 'event_stock'
    UNION ALL
    SELECT customer_phone, customer_name, delivery_address, district, created_at, 'manual_cake'
      FROM lab_manual_cake_ledger WHERE shop_name IS NOT NULL AND customer_phone IS NOT NULL
    ORDER BY created_at
  LOOP
    PERFORM lab_customers_touch(r.customer_phone, r.customer_name, r.delivery_address, r.district, r.created_at, r.src);
  END LOOP;
END $$;

-- ── 3. Politique de rétention + purge glissante ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.lab_retention_policy (
  table_name   text PRIMARY KEY,
  date_column  text NOT NULL,
  horizon_days int  NOT NULL CHECK (horizon_days >= 7),
  enabled      boolean NOT NULL DEFAULT true,
  note         text
);
ALTER TABLE public.lab_retention_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_retention_policy_read" ON public.lab_retention_policy;
CREATE POLICY "lab_retention_policy_read" ON public.lab_retention_policy FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager'));

INSERT INTO public.lab_retention_policy (table_name, date_column, horizon_days, note) VALUES
  ('lab_manual_cakes',              'delivery_date', 60,  'Gâteaux manuels / commandes en ligne lab. Copie permanente dans lab_manual_cake_ledger ; photo design supprimée par le cron Vercel avant purge. Cascade : lab_delivery_check_lines des gâteaux.'),
  ('lab_imports',                   'delivery_date', 365, 'Journées de commandes Odoo. Cascade : lab_order_lines, lab_assignments (saisie chefs), lab_birthday_details. lab_daily_stats agrégé avant suppression.'),
  ('lab_delivery_orders',           'delivery_date', 540, 'Contrôle de livraison lab. Cascade : lab_delivery_check_lines, lab_shop_receipt_lines (réception boutique).'),
  ('lab_inventory_sessions',        'inventory_date', 180, 'Inventaires lab (écarts conservés dans Odoo stock.move.line). Cascade : lab_inventory_lines.'),
  ('lab_internal_losses',           'reported_at',   180, 'Casse lab — scrap dans Odoo.'),
  ('lab_shop_losses',               'reported_at',   180, 'Casse boutique — scrap dans Odoo.'),
  ('lab_stock_transfers',           'created_at',    90,  'Envois lab → boutiques (MO Odoo). Cascade : lab_stock_transfer_lines.'),
  ('lab_shop_transfers',            'created_at',    90,  'Transferts inter-boutiques (Odoo). Cascade : lab_shop_transfer_lines.'),
  ('lab_shop_manager_orders',       'created_at',    90,  'Trace des commandes managers (document Odoo).'),
  ('lab_shop_manager_order_drafts', 'created_at',    30,  'Brouillons de commande.'),
  ('lab_order_packaging_lines',     'synced_at',     180, 'Packaging synchronisé depuis Odoo.'),
  ('lab_odoo_changes',              'detected_at',   30,  'Journal des changements Odoo détectés.'),
  ('lab_delivery_push_log',         'created_at',    30,  'Log push livraison.'),
  ('lab_push_send_log',             'created_at',    30,  'Log push.'),
  ('lab_shop_submission_dedupe',    'created_at',    7,   'Anti-doublon technique.'),
  ('lab_late_delivery_odoo_cache',  'checked_at',    7,   'Cache Odoo.')
ON CONFLICT (table_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.lab_retention_runs (
  id       bigserial PRIMARY KEY,
  run_at   timestamptz NOT NULL DEFAULT now(),
  dry_run  boolean NOT NULL DEFAULT false,
  deleted  jsonb NOT NULL DEFAULT '{}'::jsonb,
  error    text
);
ALTER TABLE public.lab_retention_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lab_retention_runs_read" ON public.lab_retention_runs;
CREATE POLICY "lab_retention_runs_read" ON public.lab_retention_runs FOR SELECT TO authenticated
  USING (current_role_of() IN ('admin','lab_manager'));

-- Purge glissante : pour chaque table activée, supprime ce qui est plus vieux que l'horizon.
-- p_dry_run = true → compte seulement, ne supprime rien. Retourne {table: nb_lignes}.
CREATE OR REPLACE FUNCTION public.lab_purge_rolling(p_dry_run boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p record; n bigint; out jsonb := '{}'::jsonb; d date; coltype text; cutoff_expr text;
BEGIN
  FOR p IN SELECT * FROM lab_retention_policy WHERE enabled ORDER BY table_name LOOP
    SELECT data_type INTO coltype FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p.table_name AND column_name = p.date_column;
    IF coltype IS NULL THEN
      out := out || jsonb_build_object(p.table_name, 'skipped: column not found');
      CONTINUE;
    END IF;
    IF coltype = 'date' THEN
      cutoff_expr := format('%I < current_date - %s', p.date_column, p.horizon_days);
    ELSE
      cutoff_expr := format('%I < now() - make_interval(days => %s)', p.date_column, p.horizon_days);
    END IF;

    IF p.table_name = 'lab_imports' AND NOT p_dry_run THEN
      -- sécurité : (ré)agréger chaque journée avant de la supprimer
      FOR d IN EXECUTE format('SELECT DISTINCT delivery_date FROM lab_imports WHERE status = %L AND %s', 'published', cutoff_expr) LOOP
        PERFORM lab_aggregate_day(d);
      END LOOP;
    END IF;

    IF p_dry_run THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE %s', p.table_name, cutoff_expr) INTO n;
    ELSE
      EXECUTE format('DELETE FROM %I WHERE %s', p.table_name, cutoff_expr);
      GET DIAGNOSTICS n = ROW_COUNT;
    END IF;
    out := out || jsonb_build_object(p.table_name, n);
  END LOOP;
  INSERT INTO lab_retention_runs (dry_run, deleted) VALUES (p_dry_run, out);
  RETURN out;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO lab_retention_runs (dry_run, deleted, error) VALUES (p_dry_run, out, SQLERRM);
  RAISE;
END $$;

REVOKE EXECUTE ON FUNCTION public.lab_purge_rolling(boolean) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.lab_purge_rolling(boolean) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.lab_customers_touch(text,text,text,text,timestamptz,text) FROM PUBLIC, anon, authenticated;

-- ── v85b (appliqué le même jour) — sémantique de suppression du ledger + bucket ──────────
-- Une suppression volontaire (staff, rollback d'un submit échoué) retire aussi la ligne du
-- ledger ; seule la purge (flag de session lab.purging, posé par lab_purge_rolling) conserve
-- la ligne en la marquant source_deleted_at.
CREATE OR REPLACE FUNCTION public.lab_manual_cake_ledger_mark_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('lab.purging', true) = '1' THEN
    UPDATE lab_manual_cake_ledger SET source_deleted_at = now() WHERE id = OLD.id AND source_deleted_at IS NULL;
  ELSE
    DELETE FROM lab_manual_cake_ledger WHERE id = OLD.id;
  END IF;
  RETURN OLD;
END $$;
-- (lab_purge_rolling fait PERFORM set_config('lab.purging','1',true) en début de run — voir la
-- version déployée dans Supabase.)
INSERT INTO storage.buckets (id, name, public) VALUES ('lab-archives', 'lab-archives', false) ON CONFLICT (id) DO NOTHING;
