'use server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { createClient as createServiceClient } from '@supabase/supabase-js';
import {
  collectLabStockSnapshot, checkSafetyStock, checkOrphanStock, collectMtoExplanations, STOCK_CATEGORIES,
  type StockSnapshot, type SafetyStockIssue, type OrphanStockIssue,
} from '@/lib/checks';

export interface LiveStockResult {
  snapshot: StockSnapshot;
  safety: SafetyStockIssue[];
  orphan: OrphanStockIssue[];
  sent: Record<string, number>;
  upcoming: Record<string, number>;
}

// "Actualiser en direct" de la section stock d'/analytics (2026-09-02). Par défaut la page rend
// l'instantané du DERNIER run de Check — zéro appel Odoo à l'ouverture (Axel : "il faut que ce
// soit optimisé") ; ce bouton relit Odoo à la demande. Lecture seule, admin only. Service client
// pour les mêmes lectures que le cron (indépendant des policies RLS par table).
export async function refreshStockLiveAction(): Promise<LiveStockResult | { error: string }> {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (profile?.role !== 'admin') return { error: 'Admin only' };
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return { error: 'Server not configured' };
  const service = createServiceClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const snapshot = await collectLabStockSnapshot(service as any);
  if (snapshot.error) return { snapshot, safety: [], orphan: [], sent: {}, upcoming: {} };
  const mtoSkus = snapshot.items
    .filter(i => i.qty !== 0 && !(i.category && STOCK_CATEGORIES.includes(i.category)))
    .map(i => i.sku);
  const [safety, orphan, expl] = await Promise.all([
    checkSafetyStock(service as any, snapshot).catch((): SafetyStockIssue[] => []),
    checkOrphanStock(service as any, snapshot).catch((): OrphanStockIssue[] => []),
    collectMtoExplanations(service as any, mtoSkus).catch(() => ({ sent: {}, upcoming: {} })),
  ]);
  return { snapshot, safety, orphan, sent: expl.sent, upcoming: expl.upcoming };
}
