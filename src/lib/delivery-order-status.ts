// Statut "fait" d'une commande côté app — extrait de DeliveryCheckIndexView (2026-09-03) pour
// que la page /delivery-check (server, calcule quelles commandes "en retard" vérifier contre
// Odoo) et la vue (client, filtre l'onglet "En retard") utilisent EXACTEMENT la même définition
// et ne puissent jamais diverger silencieusement.
export type MinimalOrderStatus = {
  status: string;
  odoo_push_status: string | null;
  total: number;
  checked: number;
};

export function isOrderDone(o: MinimalOrderStatus): boolean {
  return o.odoo_push_status === 'validated' || o.odoo_push_status === 'already_done'
    || o.status === 'validated'
    || (o.total > 0 && o.checked === o.total);
}
