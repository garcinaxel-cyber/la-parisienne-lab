import { NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { fetchAllPages } from '@/lib/fetch-all-pages';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Archives mensuelles (Axel, 2026-09-19 : "mensuel et pas glissant, bien rangé"). Appelé par
// pg_cron le 1er du mois (20:30 UTC = 03:30 VN) avec ?secret=CRON_SECRET : exporte le mois
// calendaire PRÉCÉDENT, un fichier Excel par thème, dans le bucket privé `lab-archives` :
//
//   lab-archives/2026/2026-09/2026-09_production-equipes.xlsx
//   lab-archives/2026/2026-09/2026-09_commandes-speciales.xlsx
//   lab-archives/2026/2026-09/2026-09_ventes-en-ligne.xlsx
//   lab-archives/2026/2026-09/2026-09_ecarts-livraison.xlsx
//   lab-archives/2026/2026-09/2026-09_pertes.xlsx
//   lab-archives/2026/2026-09/2026-09_inventaires-lab.xlsx
//
// Les fichiers sont téléchargeables dans /admin/archives. Un fichier déjà présent est réécrit
// à l'identique (upsert) — relancer le cron est sans risque.
//
// ?month=YYYY-MM   → exporter ce mois précis (rattrapage / vérification)
// ?mode=backup     → sauvegarde hebdo (pg_cron `lab-backup-weekly`, dimanche 21:00 UTC) des
//                    tables "à vie" en JSON/CSV : lab-archives/sauvegarde/YYYY-MM-DD/…
//                    (les 8 dernières sont conservées).
//
// Règle de cohérence avec la purge : aucun horizon de lab_retention_policy ne descend sous 60 j,
// et le mois M-1 est exporté au plus tard le 1er de M+1 (≤ 31 j après sa fin) — les données sont
// donc toujours exportées AVANT d'être purgées. Les commandes spéciales / ventes en ligne lisent
// de toute façon le ledger permanent, jamais la table vive.

type Row = Record<string, unknown>;
const VN_OFFSET_MS = 7 * 3600 * 1000;

function vnToday(): string { return new Date(Date.now() + VN_OFFSET_MS).toISOString().slice(0, 10); }
function previousMonth(): string {
  const d = new Date(Date.now() + VN_OFFSET_MS);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function monthBounds(month: string): { from: string; to: string; toExclusive: string } {
  const [y, m] = month.split('-').map(Number);
  const from = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(last).padStart(2, '0')}`;
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  return { from, to, toExclusive: next };
}
function vnDateTime(v: unknown): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + VN_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

function sheet(rows: Row[], columns: { key: string; label: string; fmt?: (v: unknown, r: Row) => unknown }[]): XLSX.WorkSheet {
  const aoa: unknown[][] = [columns.map(c => c.label)];
  for (const r of rows) aoa.push(columns.map(c => (c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? ''))));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = columns.map(c => ({ wch: Math.min(48, Math.max(10, c.label.length + 2)) }));
  return ws;
}
function workbookBuffer(sheets: { name: string; ws: XLSX.WorkSheet }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, s.ws, s.name.slice(0, 31));
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function upload(supabase: SupabaseClient, path: string, body: Buffer | string, contentType: string): Promise<string | null> {
  const { error } = await supabase.storage.from('lab-archives').upload(path, body, { contentType, upsert: true });
  return error ? `${path}: ${error.message}` : null;
}

// ── Exports mensuels ────────────────────────────────────────────────────────

async function exportProduction(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, to } = monthBounds(month);
  const imports = await fetchAllPages<Row>((f, t) => sb.from('lab_imports')
    .select('id, delivery_date, order_number, type, status').gte('delivery_date', from).lte('delivery_date', to).order('id').range(f, t));
  const byImport = new Map(imports.map(i => [i.id as string, i]));
  const ids = imports.map(i => i.id as string);
  const rows: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const asg = await fetchAllPages<Row>((f, t) => sb.from('lab_assignments')
      .select('id, import_id, team, product_name_vi, product_name_en, variant_label, variant_id, total_qty, qty_to_produce, qty_produced, qty_sent_total, status, is_extra, cancelled, produced_by_name, produced_at, blocked_reason, blocked_by_name, blocked_at, notes, exception_reason, created_at')
      .in('import_id', chunk).order('id').range(f, t));
    for (const a of asg) rows.push({ ...a, _imp: byImport.get(a.import_id as string) });
  }
  const variantIds = Array.from(new Set(rows.map(r => r.variant_id).filter(Boolean))) as string[];
  const skuByVariant = new Map<string, string>();
  for (let i = 0; i < variantIds.length; i += 500) {
    const { data } = await sb.from('lab_fiche_variants').select('id, sku').in('id', variantIds.slice(i, i + 500));
    for (const v of data ?? []) if (v.sku) skuByVariant.set(v.id, v.sku);
  }
  rows.sort((a, b) => String((a._imp as Row)?.delivery_date ?? '').localeCompare(String((b._imp as Row)?.delivery_date ?? '')) || String(a.team).localeCompare(String(b.team)));
  const ws = sheet(rows, [
    { key: '_imp', label: 'Ngày giao / Date', fmt: v => (v as Row)?.delivery_date ?? '' },
    { key: '_imp', label: 'Import', fmt: v => (v as Row)?.order_number ?? '' },
    { key: 'team', label: 'Équipe' },
    { key: 'variant_id', label: 'SKU', fmt: v => (v ? skuByVariant.get(String(v)) ?? '' : '') },
    { key: 'product_name_vi', label: 'Sản phẩm' },
    { key: 'variant_label', label: 'Variante' },
    { key: 'qty_to_produce', label: 'Qté à produire' },
    { key: 'qty_produced', label: 'Qté produite' },
    { key: 'qty_sent_total', label: 'Qté envoyée' },
    { key: 'status', label: 'Statut' },
    { key: 'is_extra', label: 'Extra', fmt: v => (v ? 'oui' : '') },
    { key: 'cancelled', label: 'Annulé', fmt: v => (v ? 'oui' : '') },
    { key: 'produced_by_name', label: 'Produit par' },
    { key: 'produced_at', label: 'Produit le', fmt: vnDateTime },
    { key: 'blocked_reason', label: 'Raison blocage' },
    { key: 'blocked_by_name', label: 'Bloqué par' },
    { key: 'blocked_at', label: 'Bloqué le', fmt: vnDateTime },
    { key: 'exception_reason', label: 'Exception' },
    { key: 'notes', label: 'Notes' },
  ]);
  // Feuille 2 : agrégats du mois (lab_daily_stats) — le résumé qui survit à tout
  const stats = await fetchAllPages<Row>((f, t) => sb.from('lab_daily_stats')
    .select('day, team, sku, product_name, qty_ordered, qty_produced, qty_extra, cards_total, cards_done, cards_blocked')
    .gte('day', from).lte('day', to).order('day').order('team').order('sku').range(f, t));
  const ws2 = sheet(stats, [
    { key: 'day', label: 'Jour' }, { key: 'team', label: 'Équipe' }, { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Produit' },
    { key: 'qty_ordered', label: 'Commandé' }, { key: 'qty_produced', label: 'Produit' }, { key: 'qty_extra', label: 'dont extra' },
    { key: 'cards_total', label: 'Cartes' }, { key: 'cards_done', label: 'Faites' }, { key: 'cards_blocked', label: 'Bloquées' },
  ]);
  return { buf: workbookBuffer([{ name: 'Cartes de production', ws }, { name: 'Résumé quotidien', ws: ws2 }]), rows: rows.length };
}

async function exportSpecialOrders(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, to } = monthBounds(month);
  const rows = await fetchAllPages<Row>((f, t) => sb.from('lab_manual_cake_ledger')
    .select('*').gte('delivery_date', from).lte('delivery_date', to).order('delivery_date').order('created_at').range(f, t));
  const ws = sheet(rows, [
    { key: 'delivery_date', label: 'Ngày giao / Date' }, { key: 'ready_time', label: 'Heure' },
    { key: 'shop_name', label: 'Boutique' }, { key: 'channel', label: 'Canal' }, { key: 'delivered_by', label: 'Livré par' },
    { key: 'customer_name', label: 'Client' }, { key: 'customer_phone', label: 'Téléphone' }, { key: 'delivery_address', label: 'Adresse' }, { key: 'district', label: 'Quận' },
    { key: 'product_sku', label: 'SKU' }, { key: 'product_name_vi', label: 'Sản phẩm' }, { key: 'team', label: 'Équipe' },
    { key: 'qty', label: 'Qté' }, { key: 'unit_price', label: 'Prix unit.' },
    { key: 'qty', label: 'Total', fmt: (v, r) => Number(v ?? 0) * Number(r.unit_price ?? 0) },
    { key: 'message', label: 'Message' }, { key: 'design_notes', label: 'Design' }, { key: 'notes', label: 'Notes' },
    { key: 'matched_order_ref', label: 'Odoo' }, { key: 'cancelled_at', label: 'Annulé le', fmt: vnDateTime }, { key: 'cancel_reason', label: 'Motif annulation' },
    { key: 'created_by_name', label: 'Créé par' }, { key: 'created_at', label: 'Créé le', fmt: vnDateTime },
    { key: 'order_batch_id', label: 'Commande en ligne (batch)' },
  ]);
  return { buf: workbookBuffer([{ name: 'Commandes spéciales', ws }]), rows: rows.length };
}

async function exportOnlineSales(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, to } = monthBounds(month);
  const orders = await fetchAllPages<Row>((f, t) => sb.from('lab_online_orders')
    .select('*').gte('delivery_date', from).lte('delivery_date', to).order('delivery_date').order('created_at').range(f, t));
  const batchIds = orders.map(o => o.order_batch_id as string);
  const lines: Row[] = [];
  for (let i = 0; i < batchIds.length; i += 300) {
    const chunk = batchIds.slice(i, i + 300);
    const [{ data: mc }, { data: sl }] = await Promise.all([
      sb.from('lab_manual_cake_ledger').select('order_batch_id, product_sku, product_name_vi, qty, unit_price, cancelled_at, matched_order_ref').in('order_batch_id', chunk),
      sb.from('lab_online_sale_lines').select('order_batch_id, sku, product_name_vi, qty, unit_price, is_fee, category, line_note').in('order_batch_id', chunk),
    ]);
    for (const l of mc ?? []) lines.push({ ...l, sku: l.product_sku, kind: 'lab' });
    for (const l of sl ?? []) lines.push({ ...l, kind: l.is_fee ? 'frais' : 'stock boutique' });
  }
  const orderByBatch = new Map(orders.map(o => [o.order_batch_id as string, o]));
  const totalByBatch = new Map<string, number>();
  for (const l of lines) {
    if (l.cancelled_at) continue;
    const b = l.order_batch_id as string;
    totalByBatch.set(b, (totalByBatch.get(b) ?? 0) + Number(l.qty ?? 0) * Number(l.unit_price ?? 0));
  }
  const ws = sheet(orders, [
    { key: 'delivery_date', label: 'Ngày giao / Date' }, { key: 'source', label: 'Source' }, { key: 'shop_name', label: 'Boutique' }, { key: 'channel', label: 'Canal' },
    { key: 'customer_name', label: 'Client' }, { key: 'customer_phone', label: 'Téléphone' }, { key: 'delivery_address', label: 'Adresse' }, { key: 'district', label: 'Quận' },
    { key: 'delivery_mode', label: 'Livraison' },
    { key: 'order_batch_id', label: 'Total produits', fmt: v => totalByBatch.get(String(v)) ?? 0 },
    { key: 'delivery_fee', label: 'Frais livraison' },
    { key: 'order_batch_id', label: 'Total commande', fmt: (v, r) => (totalByBatch.get(String(v)) ?? 0) + Number(r.delivery_fee ?? 0) },
    { key: 'payment_status', label: 'Paiement' }, { key: 'payment_method', label: 'Moyen' }, { key: 'amount_paid', label: 'Payé' },
    { key: 'shop_delivered', label: 'Livré boutique', fmt: v => (v ? 'oui' : '') }, { key: 'shop_delivered_at', label: 'Livré le', fmt: vnDateTime },
    { key: 'refunded_at', label: 'Remboursé le', fmt: vnDateTime }, { key: 'refund_amount', label: 'Montant remboursé' },
    { key: 'customer_returning_override', label: 'Client fidèle (manuel)', fmt: v => (v == null ? '' : v ? 'oui' : 'non') },
    { key: 'notes', label: 'Notes' }, { key: 'created_at', label: 'Créé le', fmt: vnDateTime }, { key: 'order_batch_id', label: 'Batch' },
  ]);
  lines.sort((a, b) => String(orderByBatch.get(a.order_batch_id as string)?.delivery_date ?? '').localeCompare(String(orderByBatch.get(b.order_batch_id as string)?.delivery_date ?? '')));
  const ws2 = sheet(lines, [
    { key: 'order_batch_id', label: 'Ngày giao / Date', fmt: v => orderByBatch.get(String(v))?.delivery_date ?? '' },
    { key: 'order_batch_id', label: 'Client', fmt: v => orderByBatch.get(String(v))?.customer_name ?? '' },
    { key: 'order_batch_id', label: 'Boutique', fmt: v => orderByBatch.get(String(v))?.shop_name ?? '' },
    { key: 'kind', label: 'Type' }, { key: 'sku', label: 'SKU' }, { key: 'product_name_vi', label: 'Sản phẩm' }, { key: 'category', label: 'Catégorie' },
    { key: 'qty', label: 'Qté' }, { key: 'unit_price', label: 'Prix unit.' },
    { key: 'qty', label: 'Total', fmt: (v, r) => Number(v ?? 0) * Number(r.unit_price ?? 0) },
    { key: 'cancelled_at', label: 'Annulé le', fmt: vnDateTime }, { key: 'matched_order_ref', label: 'Odoo' }, { key: 'line_note', label: 'Note' },
    { key: 'order_batch_id', label: 'Batch' },
  ]);
  return { buf: workbookBuffer([{ name: 'Commandes', ws }, { name: 'Lignes', ws: ws2 }]), rows: orders.length };
}

async function exportDeliveryDiscrepancies(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, to } = monthBounds(month);
  const orders = await fetchAllPages<Row>((f, t) => sb.from('lab_delivery_orders')
    .select('id, delivery_date, order_ref, source_type, shop_name, customer_name, status, validated_by_name, validated_at, odoo_push_status, marked_not_delivered, marked_not_delivered_by_name')
    .gte('delivery_date', from).lte('delivery_date', to).order('id').range(f, t));
  const byId = new Map(orders.map(o => [o.id as string, o]));
  const ids = orders.map(o => o.id as string);
  const checkLines: Row[] = []; const receipt: Row[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const cl = await fetchAllPages<Row>((f, t) => sb.from('lab_delivery_check_lines')
      .select('delivery_order_id, sku, product_name_vi, team, qty_expected, qty_checked, status, discrepancy_reason, discrepancy_note, note, checked_by_name, checked_at')
      .in('delivery_order_id', chunk).order('id').range(f, t));
    const rl = await fetchAllPages<Row>((f, t) => sb.from('lab_shop_receipt_lines')
      .select('delivery_order_id, check_line_id, shop_name, qty_received, status, note, confirmed_by_name, confirmed_at')
      .in('delivery_order_id', chunk).order('id').range(f, t));
    checkLines.push(...cl); receipt.push(...rl);
  }
  // Ne garder que ce qui a une valeur d'archive : écart, ajustement, note, problème boutique
  const labRows = checkLines.filter(l => l.status !== 'ok' || l.note || l.discrepancy_note || l.discrepancy_reason || Number(l.qty_expected ?? 0) !== Number(l.qty_checked ?? l.qty_expected ?? 0));
  const shopRows = receipt.filter(l => l.status !== 'ok' || l.note);
  const orderCols = (key = 'delivery_order_id') => ([
    { key, label: 'Ngày giao / Date', fmt: (v: unknown) => byId.get(String(v))?.delivery_date ?? '' },
    { key, label: 'Bon', fmt: (v: unknown) => byId.get(String(v))?.order_ref ?? '' },
    { key, label: 'Boutique', fmt: (v: unknown) => byId.get(String(v))?.shop_name ?? byId.get(String(v))?.customer_name ?? '' },
  ]);
  const ws = sheet(labRows, [
    ...orderCols(), { key: 'sku', label: 'SKU' }, { key: 'product_name_vi', label: 'Sản phẩm' }, { key: 'team', label: 'Équipe' },
    { key: 'qty_expected', label: 'Attendu' }, { key: 'qty_checked', label: 'Vérifié' }, { key: 'status', label: 'Statut' },
    { key: 'discrepancy_reason', label: 'Raison' }, { key: 'discrepancy_note', label: 'Détail' }, { key: 'note', label: 'Note' },
    { key: 'checked_by_name', label: 'Vérifié par' }, { key: 'checked_at', label: 'Vérifié le', fmt: vnDateTime },
  ]);
  const ws2 = sheet(shopRows, [
    ...orderCols(), { key: 'shop_name', label: 'Boutique (portail)' }, { key: 'qty_received', label: 'Reçu' }, { key: 'status', label: 'Statut' }, { key: 'note', label: 'Note' },
    { key: 'confirmed_by_name', label: 'Confirmé par' }, { key: 'confirmed_at', label: 'Confirmé le', fmt: vnDateTime },
  ]);
  const ws3 = sheet(orders, [
    { key: 'delivery_date', label: 'Ngày giao / Date' }, { key: 'order_ref', label: 'Bon' }, { key: 'source_type', label: 'Type' }, { key: 'shop_name', label: 'Boutique' }, { key: 'customer_name', label: 'Client' },
    { key: 'status', label: 'Statut' }, { key: 'validated_by_name', label: 'Validé par' }, { key: 'validated_at', label: 'Validé le', fmt: vnDateTime }, { key: 'odoo_push_status', label: 'Odoo' },
    { key: 'marked_not_delivered', label: 'Non livré', fmt: v => (v ? 'oui' : '') }, { key: 'marked_not_delivered_by_name', label: 'Par' },
  ]);
  return { buf: workbookBuffer([{ name: 'Écarts contrôle lab', ws }, { name: 'Écarts réception boutique', ws: ws2 }, { name: 'Tous les bons', ws: ws3 }]), rows: labRows.length + shopRows.length };
}

async function exportLosses(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, toExclusive } = monthBounds(month);
  const shop = await fetchAllPages<Row>((f, t) => sb.from('lab_shop_losses')
    .select('reported_at, shop_name, sku, product_name, qty, reason_tag_name, note, reported_by_name, odoo_scrap_id, odoo_sync_error, lab_received_qty, lab_received_by_name, lab_received_at, lab_receive_note, follow_up_note, follow_up_note_by_name')
    .gte('reported_at', `${from}T00:00:00+07:00`).lt('reported_at', `${toExclusive}T00:00:00+07:00`).order('id').range(f, t));
  const lab = await fetchAllPages<Row>((f, t) => sb.from('lab_internal_losses')
    .select('reported_at, sku, product_name, qty, reason_tag_name, note, reported_by_name, odoo_scrap_id, odoo_sync_error')
    .gte('reported_at', `${from}T00:00:00+07:00`).lt('reported_at', `${toExclusive}T00:00:00+07:00`).order('id').range(f, t));
  const ws = sheet(shop, [
    { key: 'reported_at', label: 'Déclaré le', fmt: vnDateTime }, { key: 'shop_name', label: 'Boutique' }, { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Sản phẩm' },
    { key: 'qty', label: 'Qté' }, { key: 'reason_tag_name', label: 'Raison' }, { key: 'note', label: 'Note' }, { key: 'reported_by_name', label: 'Déclaré par' },
    { key: 'odoo_scrap_id', label: 'Scrap Odoo' }, { key: 'odoo_sync_error', label: 'Erreur Odoo' },
    { key: 'lab_received_qty', label: 'Reçu au lab' }, { key: 'lab_received_by_name', label: 'Reçu par' }, { key: 'lab_received_at', label: 'Reçu le', fmt: vnDateTime }, { key: 'lab_receive_note', label: 'Note lab' },
    { key: 'follow_up_note', label: 'Suivi' }, { key: 'follow_up_note_by_name', label: 'Suivi par' },
  ]);
  const ws2 = sheet(lab, [
    { key: 'reported_at', label: 'Déclaré le', fmt: vnDateTime }, { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Sản phẩm' },
    { key: 'qty', label: 'Qté' }, { key: 'reason_tag_name', label: 'Raison' }, { key: 'note', label: 'Note' }, { key: 'reported_by_name', label: 'Déclaré par' },
    { key: 'odoo_scrap_id', label: 'Scrap Odoo' }, { key: 'odoo_sync_error', label: 'Erreur Odoo' },
  ]);
  return { buf: workbookBuffer([{ name: 'Pertes boutiques', ws }, { name: 'Pertes lab', ws: ws2 }]), rows: shop.length + lab.length };
}

async function exportInventories(sb: SupabaseClient, month: string): Promise<{ buf: Buffer; rows: number }> {
  const { from, to } = monthBounds(month);
  const sessions = await fetchAllPages<Row>((f, t) => sb.from('lab_inventory_sessions')
    .select('id, inventory_date, status, created_by_name, created_at, submitted_by_name, submitted_at, odoo_push_status')
    .gte('inventory_date', from).lte('inventory_date', to).order('inventory_date').range(f, t));
  const sheets: { name: string; ws: XLSX.WorkSheet }[] = [{
    name: 'Sessions',
    ws: sheet(sessions, [
      { key: 'inventory_date', label: 'Date' }, { key: 'status', label: 'Statut' }, { key: 'created_by_name', label: 'Créé par' }, { key: 'created_at', label: 'Créé le', fmt: vnDateTime },
      { key: 'submitted_by_name', label: 'Envoyé par' }, { key: 'submitted_at', label: 'Envoyé le', fmt: vnDateTime }, { key: 'odoo_push_status', label: 'Odoo' },
    ]),
  }];
  let n = 0;
  for (const s of sessions) {
    const lines = await fetchAllPages<Row>((f, t) => sb.from('lab_inventory_lines')
      .select('sku, product_name_vi, category, qty_system, qty_counted, odoo_push_status, odoo_push_error').eq('session_id', s.id).order('id').range(f, t));
    n += lines.length;
    sheets.push({
      name: `${s.inventory_date}${sessions.filter(x => x.inventory_date === s.inventory_date).length > 1 ? ' ' + String(s.id).slice(0, 4) : ''}`,
      ws: sheet(lines, [
        { key: 'sku', label: 'SKU' }, { key: 'product_name_vi', label: 'Sản phẩm' }, { key: 'category', label: 'Catégorie' },
        { key: 'qty_system', label: 'Système' }, { key: 'qty_counted', label: 'Compté' },
        { key: 'qty_counted', label: 'Écart', fmt: (v, r) => Number(v ?? 0) - Number(r.qty_system ?? 0) },
        { key: 'odoo_push_status', label: 'Odoo' }, { key: 'odoo_push_error', label: 'Erreur' },
      ]),
    });
  }
  return { buf: workbookBuffer(sheets), rows: n };
}

// ── Sauvegarde hebdo des tables "à vie" ────────────────────────────────────

function csv(rows: Row[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

async function runBackup(sb: SupabaseClient): Promise<{ folder: string; files: string[]; errors: string[] }> {
  const day = vnToday();
  const folder = `sauvegarde/${day}`;
  const errors: string[] = []; const files: string[] = [];
  const all = (table: string, order = 'id') => fetchAllPages<Row>((f, t) => sb.from(table).select('*').order(order).range(f, t));
  const put = async (name: string, body: string, type: string) => {
    const e = await upload(sb, `${folder}/${name}`, body, type);
    if (e) errors.push(e); else files.push(name);
  };
  try {
    const [meta, steps, variants, vq] = await Promise.all([all('lab_fiche_meta'), all('lab_fiche_steps'), all('lab_fiche_variants'), all('lab_fiche_variant_quantities')]);
    await put('fiches-techniques.json', JSON.stringify({ exported_at: new Date().toISOString(), lab_fiche_meta: meta, lab_fiche_steps: steps, lab_fiche_variants: variants, lab_fiche_variant_quantities: vq }), 'application/json');
    await put('daily-stats.csv', csv(await fetchAllPages<Row>((f, t) => sb.from('lab_daily_stats').select('*').order('day').order('team').order('sku').range(f, t))), 'text/csv');
    await put('clients.csv', csv(await all('lab_customers', 'phone_key')), 'text/csv');
    await put('produits-non-production.csv', csv(await all('lab_excluded_skus', 'sku')), 'text/csv');
    await put('seuils-stock.csv', csv(await all('lab_stock_safety_thresholds', 'sku')), 'text/csv');
    const [oo, sl, mc] = await Promise.all([all('lab_online_orders', 'created_at'), all('lab_online_sale_lines'), all('lab_manual_cake_ledger', 'created_at')]);
    await put('ventes-en-ligne.json', JSON.stringify({ exported_at: new Date().toISOString(), lab_online_orders: oo, lab_online_sale_lines: sl, lab_manual_cake_ledger: mc }), 'application/json');
    await put('comptages-stock-boutiques.csv', csv(await fetchAllPages<Row>((f, t) => sb.from('lab_shop_stock_counts').select('*').order('id').range(f, t))), 'text/csv');
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  // Ne garder que les 8 dernières sauvegardes
  const { data: folders } = await sb.storage.from('lab-archives').list('sauvegarde', { limit: 200, sortBy: { column: 'name', order: 'desc' } });
  const old = (folders ?? []).map(f => f.name).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse().slice(8);
  for (const f of old) {
    const { data: inner } = await sb.storage.from('lab-archives').list(`sauvegarde/${f}`, { limit: 100 });
    if (inner?.length) await sb.storage.from('lab-archives').remove(inner.map(x => `sauvegarde/${f}/${x.name}`));
  }
  return { folder, files, errors };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? req.headers.get('authorization')?.replace('Bearer ', '');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json({ error: 'Server not configured (SUPABASE_SERVICE_ROLE_KEY)' }, { status: 503 });
  }
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const startedAt = Date.now();

  if (url.searchParams.get('mode') === 'backup') {
    const r = await runBackup(sb);
    console.log('[archive] backup', JSON.stringify(r));
    return NextResponse.json({ ok: r.errors.length === 0, ...r, ms: Date.now() - startedAt }, { status: r.errors.length ? 502 : 200 });
  }

  const month = url.searchParams.get('month') ?? previousMonth();
  if (!/^\d{4}-\d{2}$/.test(month) || month >= vnToday().slice(0, 7)) {
    return NextResponse.json({ error: 'month must be YYYY-MM and already finished' }, { status: 400 });
  }
  const dir = `${month.slice(0, 4)}/${month}`;
  const jobs: { name: string; run: () => Promise<{ buf: Buffer; rows: number }> }[] = [
    { name: 'production-equipes', run: () => exportProduction(sb, month) },
    { name: 'commandes-speciales', run: () => exportSpecialOrders(sb, month) },
    { name: 'ventes-en-ligne', run: () => exportOnlineSales(sb, month) },
    { name: 'ecarts-livraison', run: () => exportDeliveryDiscrepancies(sb, month) },
    { name: 'pertes', run: () => exportLosses(sb, month) },
    { name: 'inventaires-lab', run: () => exportInventories(sb, month) },
  ];
  const files: Record<string, number> = {}; const errors: string[] = [];
  for (const j of jobs) {
    try {
      const { buf, rows } = await j.run();
      const e = await upload(sb, `${dir}/${month}_${j.name}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (e) errors.push(e); else files[`${month}_${j.name}.xlsx`] = rows;
    } catch (e) {
      errors.push(`${j.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const res = { ok: errors.length === 0, month, dir, files, errors, ms: Date.now() - startedAt };
  console.log('[archive]', JSON.stringify(res));
  return NextResponse.json(res, { status: errors.length ? 502 : 200 });
}
