-- "Ne sera pas livré" — marquage app-only, réversible, sur une commande de la page
-- delivery-check qui a été traitée sur Odoo avec 0 unité livrée parce qu'elle ne sera
-- jamais réellement livrée (Odoo ne permet pas de supprimer la commande, seulement de la
-- clôturer avec une quantité livrée à 0 — Axel, 2026-09-18). Sans ce champ, la commande
-- restait indéfiniment avec le badge "À valider sur Odoo" alors qu'il n'y a plus rien à
-- valider côté Odoo. Purement additif et local : aucune écriture Odoo, n'affecte ni
-- odoo_push_status ni aucun autre calcul (réconciliation/KPI) — seulement l'affichage de
-- cette page de suivi de livraison.
alter table lab_delivery_orders
  add column if not exists marked_not_delivered boolean not null default false,
  add column if not exists marked_not_delivered_at timestamptz,
  add column if not exists marked_not_delivered_by_name text;
