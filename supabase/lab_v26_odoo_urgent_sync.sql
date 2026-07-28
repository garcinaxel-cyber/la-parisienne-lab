-- v26 — Auto-création Odoo pour les commandes urgentes des shops.
-- Quand un shop soumet une commande via le lien /order/[token] (interface "commande
-- urgente"), la carte de prod est créée tout de suite (comme avant) ET, en parallèle,
-- une ligne de queue est poussée ici. Un cron dédié (voir /api/odoo/urgent-order-sync)
-- traite la queue UNE commande à la fois, dans l'ordre d'arrivée, pour créer le document
-- Odoo (sale.order quotation ou stock.replenishment.request) en BROUILLON — jamais
-- confirmé automatiquement. Ça élimine tout risque de conflit si deux commandes urgentes
-- arrivent en même temps, sans avoir besoin d'un vrai système de verrous.
--
--   order_batch_id : une soumission = un panier (plusieurs lignes lab_manual_cakes
--                    partagent le même id) = un seul document Odoo avec plusieurs lignes.
--   doc_type       : 'quotation' (Moon Flower / Lab / B2B) ou 'replenishment' (4 shops La Paris)
--   status         : pending -> processing -> done | error
--   order_ref      : nom du document Odoo une fois créé (ex: S02988, RR00456)
--   error          : message si la création a échoué. Une ligne 'error' N'EST PAS
--                    ré-essayée automatiquement (seules les lignes 'pending' sont traitées) —
--                    elle reste affichée dans le bandeau d'avertissement pour un traitement
--                    manuel (nouvel essai à prévoir plus tard si besoin).
--
-- En cas d'échec, la carte de prod reste visible au chef (elle a été créée AVANT, dans le
-- flux existant) et retombe dans le flux manuel /exceptional-orders, où un bandeau signale
-- les commandes urgentes non créées automatiquement dans Odoo.

ALTER TABLE lab_manual_cakes ADD COLUMN IF NOT EXISTS order_batch_id uuid;
CREATE INDEX IF NOT EXISTS lab_manual_cakes_batch_idx ON lab_manual_cakes(order_batch_id);

CREATE TABLE IF NOT EXISTS lab_odoo_sync_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_batch_id uuid NOT NULL UNIQUE,
  shop_name      text NOT NULL,
  doc_type       text NOT NULL CHECK (doc_type IN ('quotation', 'replenishment')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
  order_ref      text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS lab_odoo_sync_queue_status_idx ON lab_odoo_sync_queue(status);

ALTER TABLE lab_odoo_sync_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_odoo_sync_queue_manager" ON lab_odoo_sync_queue;
CREATE POLICY "lab_odoo_sync_queue_manager" ON lab_odoo_sync_queue FOR ALL TO authenticated
  USING (current_role_of() IN ('admin', 'lab_manager', 'assistant'))
  WITH CHECK (current_role_of() IN ('admin', 'lab_manager', 'assistant'));

-- Every 5 minutes — draining a queue of single-row inserts is cheap, and this keeps the
-- Odoo document close to real-time without any real concurrency risk (see cron route).
-- Replace <CRON_SECRET> with the same value already used for odoo-hourly-sync.
SELECT cron.unschedule('odoo-urgent-order-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'odoo-urgent-order-sync');

SELECT cron.schedule(
  'odoo-urgent-order-sync',
  '*/5 * * * *',
  $$
  SELECT net.http_get(
    url := 'https://la-parisienne-lab.vercel.app/api/odoo/urgent-order-sync?secret=<CRON_SECRET>',
    timeout_milliseconds := 55000
  );
  $$
);
