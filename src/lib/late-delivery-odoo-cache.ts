// Signal "fait sur Odoo" pour la page opérationnelle /delivery-check (Axel, 2026-09-03,
// screenshot S03515 "Fully Delivered" sur Odoo mais toujours listée "en retard" sans AUCUN
// signal vert dans l'app — isOrderDone ne connaît que le statut app, jamais Odoo en direct).
//
// Contrainte : cette page est ouverte en continu par toute l'équipe (contrairement à l'onglet
// Check admin, vérifié une fois par jour via cron) — un appel Odoo par commande en retard à
// CHAQUE chargement de page serait un coût opérationnel réel. On borne donc le coût de deux
// façons : (1) uniquement les commandes déjà "en retard" côté app (typiquement moins d'une
// vingtaine), jamais aujourd'hui/demain ; (2) un cache (lab_late_delivery_odoo_cache) avec TTL
// — une fois confirmée faite sur Odoo, plus jamais revérifiée (ça ne peut que rester fait) ; pas
// encore faite, revérifiée au plus toutes les 20 min, quel que soit le nombre de personnes qui
// ouvrent la page entre-temps.
import type { SupabaseClient } from '@supabase/supabase-js';
import { crossCheckOdooDone } from '@/lib/checks';

const CACHE_TTL_MS = 20 * 60 * 1000;

export async function getOdooDoneExternalMap(
  supabase: SupabaseClient,
  lateCandidates: { order_ref: string; delivery_date: string }[],
): Promise<Record<string, boolean>> {
  const map: Record<string, boolean> = {};
  if (!lateCandidates.length) return map;
  const key = (d: string, r: string) => `${d}||${r}`;

  const dates = Array.from(new Set(lateCandidates.map(o => o.delivery_date)));
  const { data: cached } = await supabase.from('lab_late_delivery_odoo_cache')
    .select('order_ref, delivery_date, done_on_odoo, checked_at')
    .in('delivery_date', dates);
  const cacheByKey: Record<string, { done: boolean; checkedAt: number }> = {};
  for (const c of cached ?? []) {
    cacheByKey[key(c.delivery_date, c.order_ref)] = { done: c.done_on_odoo, checkedAt: new Date(c.checked_at).getTime() };
  }

  const now = Date.now();
  const stale = lateCandidates.filter(o => {
    const c = cacheByKey[key(o.delivery_date, o.order_ref)];
    if (!c) return true;
    if (c.done) { map[key(o.delivery_date, o.order_ref)] = true; return false; } // une fois fait, ça ne redevient jamais "pas fait"
    return (now - c.checkedAt) > CACHE_TTL_MS;
  });

  if (stale.length) {
    try {
      const results = await crossCheckOdooDone(Array.from(new Set(stale.map(o => o.order_ref))));
      const rows = stale.map(o => ({
        delivery_date: o.delivery_date,
        order_ref: o.order_ref,
        done_on_odoo: results[o.order_ref] ?? false,
        checked_at: new Date().toISOString(),
      }));
      for (const r of rows) map[key(r.delivery_date, r.order_ref)] = r.done_on_odoo;
      // Best-effort — un échec d'écriture du cache ne doit jamais casser le rendu de la page.
      await supabase.from('lab_late_delivery_odoo_cache').upsert(rows, { onConflict: 'delivery_date,order_ref' });
    } catch {
      // Odoo injoignable ou cache en échec : les commandes restent "pas fait" pour ce chargement
      // (jamais fatal), on garde ce qu'on avait déjà en cache pour les autres.
      for (const o of stale) {
        const k = key(o.delivery_date, o.order_ref);
        if (!(k in map)) map[k] = cacheByKey[k]?.done ?? false;
      }
    }
  }

  return map;
}
