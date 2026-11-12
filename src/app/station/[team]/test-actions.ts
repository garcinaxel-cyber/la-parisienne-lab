'use server';
// Chef test recipes (Axel, 2026-11-12) — pilot Team Hung. The test lives in the app only; nothing is
// created in Odoo until the office approves it (later phase). A trial turns the raw materials /
// packaging of the version × pieces into chef losses of kind 'test' ("làm hàng thử"), validated by
// the team lead like any loss. Chefs never see costs.
import { unstable_cache } from 'next/cache';
import { rawService, rawActor, canActForTeam, canApproveForTeam } from '@/lib/raw-materials-db';
import { odooExecute, odooConfigured, vnTodayStr } from '@/lib/odoo';
import {
  CHEF_RD_TEAMS, REASON_TEST, trialConsumption,
  type TestSummary, type TestVersion, type TestTrial, type Recipe, type RecipeStep, type RecipeSub, type RecipeRow, type TestStage,
} from '@/lib/chef-rd';

const guard = (team: string) => CHEF_RD_TEAMS.includes(team);
async function ctx(team: string) {
  if (!guard(team)) return { error: 'Not available for this team yet' } as const;
  const a = await rawActor();
  if (!a) return { error: 'Not authenticated' } as const;
  if (!canActForTeam(a, team)) return { error: 'Forbidden' } as const;
  const db = rawService();
  if (!db) return { error: 'Server not configured' } as const;
  return { a, db } as const;
}

function mapVersion(v: any, trialCount = 0): TestVersion {
  const r = v.recipe ?? {};
  return {
    id: v.id, n: v.n, note: v.note ?? null, yieldPcs: Number(v.yield_pcs) || 1, pieceWeightG: v.piece_weight_g != null ? Number(v.piece_weight_g) : null,
    recipe: { subs: Array.isArray(r.subs) ? r.subs : [], direct: Array.isArray(r.direct) ? r.direct : [] },
    steps: Array.isArray(v.steps) ? v.steps : [], isFinal: !!v.is_final, createdAt: v.created_at, createdBy: v.created_by_name ?? null, trialCount,
  };
}
function mapTrial(t: any): TestTrial {
  return { id: t.id, versionN: t.version_n, pcs: Number(t.pcs), stars: t.stars ?? null, verdict: t.verdict ?? null, note: t.note ?? null,
    photoUrl: t.photo_url ?? null, labDay: t.lab_day, madeBy: t.made_by_name ?? null, madeAt: t.made_at };
}
function recipeText(r: any): string {
  const names: string[] = [];
  for (const s of r?.subs ?? []) { names.push(s.name); for (const x of s.rows ?? []) names.push(x.name); }
  for (const x of r?.direct ?? []) names.push(x.name);
  return names.join(' ').toLowerCase();
}

export async function listTestsAction(team: string): Promise<{ items?: TestSummary[]; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db } = c;
  const { data: tests, error } = await db.from('lab_tests').select('*').eq('team', team).order('last_activity_at', { ascending: false }).limit(500);
  if (error) return { error: error.message };
  const ids = (tests ?? []).map((t: any) => t.id);
  const [{ data: vers }, { data: trials }] = ids.length ? await Promise.all([
    db.from('lab_test_versions').select('test_id, n, recipe').in('test_id', ids),
    db.from('lab_test_trials').select('test_id').in('test_id', ids),
  ]) : [{ data: [] as any[] }, { data: [] as any[] }];
  const last = new Map<string, any>();
  for (const v of vers ?? []) { const cur = last.get(v.test_id); if (!cur || v.n > cur.n) last.set(v.test_id, v); }
  const tc = new Map<string, number>();
  for (const t of trials ?? []) tc.set(t.test_id, (tc.get(t.test_id) ?? 0) + 1);
  return { items: (tests ?? []).map((t: any) => ({
    id: t.id, name: t.name, family: t.family ?? null, collection: t.collection ?? null, tags: t.tags ?? [], stage: t.stage,
    startKind: t.start_kind, improveName: t.improve_name ?? null, photoUrl: t.photo_url ?? null, targetDate: t.target_date ?? null,
    pinned: !!t.pinned, lastVersion: last.get(t.id)?.n ?? 0, trialCount: tc.get(t.id) ?? 0, lastActivity: t.last_activity_at,
    createdAt: t.created_at, createdBy: t.created_by_name ?? null,
    officeFeedback: t.office_feedback ?? null, officeFeedbackBy: t.office_feedback_by ?? null, officeFeedbackAt: t.office_feedback_at ?? null,
    searchText: recipeText(last.get(t.id)?.recipe),
  })) };
}

export async function getTestAction(team: string, id: string): Promise<{ test?: TestSummary; versions?: TestVersion[]; trials?: TestTrial[]; canValidate?: boolean; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db, a } = c;
  const { data: t } = await db.from('lab_tests').select('*').eq('id', id).eq('team', team).maybeSingle();
  if (!t) return { error: 'Not found' };
  const [{ data: vers }, { data: trials }] = await Promise.all([
    db.from('lab_test_versions').select('*').eq('test_id', id).order('n'),
    db.from('lab_test_trials').select('*').eq('test_id', id).order('made_at', { ascending: false }),
  ]);
  const tc = new Map<number, number>();
  for (const tr of trials ?? []) tc.set(tr.version_n, (tc.get(tr.version_n) ?? 0) + 1);
  const versions = (vers ?? []).map((v: any) => mapVersion(v, tc.get(v.n) ?? 0));
  const lastV = versions[versions.length - 1];
  return {
    test: {
      id: t.id, name: t.name, family: t.family ?? null, collection: t.collection ?? null, tags: t.tags ?? [], stage: t.stage,
      startKind: t.start_kind, improveName: t.improve_name ?? null, photoUrl: t.photo_url ?? null, targetDate: t.target_date ?? null,
      pinned: !!t.pinned, lastVersion: lastV?.n ?? 0, trialCount: (trials ?? []).length, lastActivity: t.last_activity_at,
      createdAt: t.created_at, createdBy: t.created_by_name ?? null,
      officeFeedback: t.office_feedback ?? null, officeFeedbackBy: t.office_feedback_by ?? null, officeFeedbackAt: t.office_feedback_at ?? null,
      searchText: '',
    },
    versions, trials: (trials ?? []).map(mapTrial), canValidate: canApproveForTeam(a, team),
  };
}

async function touch(db: any, id: string) {
  await db.from('lab_tests').update({ last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id);
}

// Odoo recipe of an existing product → our recipe shape (improve an existing product).
async function recipeFromOdoo(sku: string): Promise<{ recipe: Recipe; yieldPcs: number } | null> {
  if (!odooConfigured()) return null;
  const prods = await odooExecute<any[]>('product.product', 'search_read', [[['default_code', '=', sku]]], { fields: ['id', 'product_tmpl_id'], limit: 1 });
  const p = prods[0]; if (!p) return null;
  const tmpl = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
  const boms = await odooExecute<any[]>('mrp.bom', 'search_read', [['|', ['product_id', '=', p.id], ['product_tmpl_id', '=', tmpl]]], { fields: ['id', 'product_qty', 'product_id'], limit: 5 });
  const bom = boms.find(b => b.product_id && (Array.isArray(b.product_id) ? b.product_id[0] : b.product_id) === p.id) ?? boms[0];
  if (!bom) return null;
  const lines = await odooExecute<any[]>('mrp.bom.line', 'search_read', [[['bom_id', '=', bom.id]]], { fields: ['product_id', 'product_qty', 'product_uom_id'], limit: 200 });
  const pids = lines.map(l => Array.isArray(l.product_id) ? l.product_id[0] : l.product_id);
  const info = pids.length ? await odooExecute<any[]>('product.product', 'read', [pids], { fields: ['default_code', 'name', 'product_tmpl_id', 'categ_id'] }) : [];
  const byId = new Map(info.map((i: any) => [i.id, i]));
  const recipe: Recipe = { subs: [], direct: [] };
  for (const l of lines) {
    const pid = Array.isArray(l.product_id) ? l.product_id[0] : l.product_id;
    const i: any = byId.get(pid) ?? {};
    const name = String(i.name ?? l.product_id?.[1] ?? '').replace(/^\[[^\]]+\]\s*/, '');
    const uom = String(l.product_uom_id?.[1] ?? 'kg');
    const categ = String(i.categ_id?.[1] ?? '').toLowerCase();
    if (/^SM-/i.test(name)) {
      recipe.subs.push({ key: `sm-${pid}`, name, src: 'odoo', productId: pid, sku: i.default_code ?? null, uom, qty: Number(l.product_qty) });
    } else {
      recipe.direct.push({ tmplId: Array.isArray(i.product_tmpl_id) ? i.product_tmpl_id[0] : null, productId: pid, sku: i.default_code ?? null,
        name, uom, qty: Number(l.product_qty), kind: categ.includes('packag') || categ.includes('bao bì') ? 'packaging' : 'raw' });
    }
  }
  return { recipe, yieldPcs: Number(bom.product_qty) || 1 };
}

export async function createTestAction(team: string, input: {
  name: string; family?: string | null; collection?: string | null; targetDate?: string | null;
  startKind: 'new' | 'improve' | 'copy'; improveSku?: string | null; improveName?: string | null; copyFromId?: string | null;
}): Promise<{ id?: string; warning?: string; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db, a } = c;
  const name = input.name.trim();
  if (name.length < 2) return { error: 'Tên quá ngắn / Name too short' };
  let recipe: Recipe = { subs: [], direct: [] }; let yieldPcs = 1; let steps: RecipeStep[] = []; let pieceWeightG: number | null = null;
  let warning: string | undefined;
  if (input.startKind === 'improve' && input.improveSku) {
    try { const r = await recipeFromOdoo(input.improveSku); if (r) { recipe = r.recipe; yieldPcs = r.yieldPcs; } else warning = 'Không tìm thấy công thức Odoo / No Odoo recipe found — empty V0'; }
    catch { warning = 'Odoo chưa trả lời / Odoo did not answer — empty V0'; }
  }
  if (input.startKind === 'copy' && input.copyFromId) {
    const { data: src } = await db.from('lab_test_versions').select('*').eq('test_id', input.copyFromId).order('n', { ascending: false }).limit(1);
    const v = src?.[0];
    if (v) { recipe = v.recipe; yieldPcs = Number(v.yield_pcs) || 1; steps = v.steps ?? []; pieceWeightG = v.piece_weight_g; }
  }
  const { data: t, error } = await db.from('lab_tests').insert({
    team, name, family: input.family || null, collection: input.collection?.trim() || null,
    target_date: input.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(input.targetDate) ? input.targetDate : null,
    start_kind: input.startKind, improve_sku: input.startKind === 'improve' ? input.improveSku ?? null : null,
    improve_name: input.startKind === 'improve' ? input.improveName ?? null : null,
    created_by_id: a.userId, created_by_name: a.name || null,
  }).select('id').single();
  if (error || !t) return { error: error?.message ?? 'Insert failed' };
  const { error: e2 } = await db.from('lab_test_versions').insert({
    test_id: t.id, n: 0, note: input.startKind === 'improve' ? `From the Odoo recipe of ${input.improveName ?? input.improveSku}` : input.startKind === 'copy' ? 'Copied from another test' : null,
    yield_pcs: yieldPcs, piece_weight_g: pieceWeightG, recipe, steps, created_by_name: a.name || null,
  });
  if (e2) return { error: e2.message };
  return { id: t.id, warning };
}

export async function updateTestAction(team: string, id: string, patch: {
  name?: string; family?: string | null; collection?: string | null; tags?: string[]; targetDate?: string | null;
  pinned?: boolean; stage?: TestStage; photoUrl?: string | null;
}): Promise<{ ok?: boolean; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db } = c;
  const upd: any = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) { if (patch.name.trim().length < 2) return { error: 'Name too short' }; upd.name = patch.name.trim(); }
  if (patch.family !== undefined) upd.family = patch.family || null;
  if (patch.collection !== undefined) upd.collection = patch.collection?.trim() || null;
  if (patch.tags !== undefined) upd.tags = Array.from(new Set(patch.tags.map(x => x.trim().toLowerCase()).filter(Boolean))).slice(0, 12);
  if (patch.targetDate !== undefined) upd.target_date = patch.targetDate && /^\d{4}-\d{2}-\d{2}$/.test(patch.targetDate) ? patch.targetDate : null;
  if (patch.pinned !== undefined) upd.pinned = !!patch.pinned;
  if (patch.photoUrl !== undefined) upd.photo_url = patch.photoUrl || null;
  if (patch.stage !== undefined) {
    // Chefs move a test between idea / testing / paused; sent / approved / odoo belong to the office flow.
    if (!['idea', 'testing', 'archived'].includes(patch.stage)) return { error: 'Not allowed' };
    upd.stage = patch.stage;
  }
  if (patch.pinned === undefined) upd.last_activity_at = new Date().toISOString();
  const { error } = await db.from('lab_tests').update(upd).eq('id', id).eq('team', team);
  if (error) return { error: error.message };
  return { ok: true };
}


// The chef's catalogue rows carry the template id; Odoo needs the product.product id.
async function fillProductIds(db: any, r: Recipe): Promise<Recipe> {
  const rows: RecipeRow[] = [...r.direct, ...r.subs.flatMap(s => s.rows ?? [])];
  const missing = Array.from(new Set(rows.filter(x => !x.productId && x.tmplId).map(x => Number(x.tmplId))));
  if (!missing.length) return r;
  const { data } = await db.from('lab_raw_materials').select('tmpl_id, product_id').in('tmpl_id', missing);
  const map = new Map((data ?? []).map((x: any) => [Number(x.tmpl_id), x.product_id ? Number(x.product_id) : null]));
  for (const x of rows) if (!x.productId && x.tmplId) x.productId = (map.get(Number(x.tmplId)) as number | null) ?? null;
  return r;
}

function cleanRecipe(r: Recipe): Recipe {
  const num = (x: any) => { const n = Number(x); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : 0; };
  const row = (x: RecipeRow): RecipeRow => ({ tmplId: x.tmplId ?? null, productId: x.productId ?? null, sku: x.sku ?? null, name: String(x.name ?? '').slice(0, 200), uom: String(x.uom ?? 'kg'), qty: num(x.qty), kind: x.kind === 'packaging' ? 'packaging' : 'raw' });
  return {
    subs: (r.subs ?? []).slice(0, 30).map((s: RecipeSub) => ({
      key: String(s.key ?? crypto.randomUUID()), name: String(s.name ?? '').slice(0, 200), src: s.src === 'new' ? 'new' : 'odoo',
      productId: s.productId ?? null, sku: s.sku ?? null, uom: String(s.uom ?? 'kg'), qty: num(s.qty),
      ...(s.src === 'new' ? { batchQty: num(s.batchQty) || 1, batchUom: String(s.batchUom ?? 'kg'), rows: (s.rows ?? []).slice(0, 60).map(row) } : {}),
    })),
    direct: (r.direct ?? []).slice(0, 80).map(row),
  };
}

export async function saveVersionAction(team: string, versionId: string, v: {
  note?: string | null; yieldPcs?: number; pieceWeightG?: number | null; recipe?: Recipe; steps?: RecipeStep[];
}): Promise<{ ok?: boolean; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db } = c;
  const { data: ver } = await db.from('lab_test_versions').select('id, test_id, n, lab_tests!inner(team)').eq('id', versionId).maybeSingle();
  if (!ver || (ver as any).lab_tests?.team !== team) return { error: 'Not found' };
  const { count } = await db.from('lab_test_trials').select('id', { count: 'exact', head: true }).eq('version_id', versionId);
  if ((count ?? 0) > 0) return { error: 'Phiên bản này đã làm thử — tạo phiên bản mới / This version has a trial: make a new version to change it' };
  const upd: any = { updated_at: new Date().toISOString() };
  if (v.note !== undefined) upd.note = v.note?.trim() || null;
  if (v.yieldPcs !== undefined) { const y = Number(v.yieldPcs); if (!(y > 0)) return { error: 'Yield must be > 0' }; upd.yield_pcs = y; }
  if (v.pieceWeightG !== undefined) upd.piece_weight_g = v.pieceWeightG && v.pieceWeightG > 0 ? v.pieceWeightG : null;
  if (v.recipe) upd.recipe = await fillProductIds(db, cleanRecipe(v.recipe));
  if (v.steps) upd.steps = v.steps.slice(0, 40).map(s => ({ title: String(s.title ?? '').slice(0, 120), text: String(s.text ?? '').slice(0, 1000), temp: s.temp ? String(s.temp).slice(0, 30) : null, time: s.time ? String(s.time).slice(0, 30) : null }));
  const { error } = await db.from('lab_test_versions').update(upd).eq('id', versionId);
  if (error) return { error: error.message };
  await touch(db, ver.test_id);
  return { ok: true };
}

export async function newVersionAction(team: string, testId: string, fromVersionId: string, note: string | null): Promise<{ id?: string; n?: number; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db, a } = c;
  const { data: t } = await db.from('lab_tests').select('id').eq('id', testId).eq('team', team).maybeSingle();
  if (!t) return { error: 'Not found' };
  const { data: src } = await db.from('lab_test_versions').select('*').eq('id', fromVersionId).eq('test_id', testId).maybeSingle();
  if (!src) return { error: 'Version not found' };
  const { data: maxV } = await db.from('lab_test_versions').select('n').eq('test_id', testId).order('n', { ascending: false }).limit(1);
  const n = (maxV?.[0]?.n ?? 0) + 1;
  const { data: nv, error } = await db.from('lab_test_versions').insert({
    test_id: testId, n, note: note?.trim() || `Copy of V${src.n}`, yield_pcs: src.yield_pcs, piece_weight_g: src.piece_weight_g,
    recipe: src.recipe, steps: src.steps, created_by_name: a.name || null,
  }).select('id').single();
  if (error || !nv) return { error: error?.message ?? 'Insert failed' };
  await touch(db, testId);
  return { id: nv.id, n };
}

export async function deleteVersionAction(team: string, versionId: string): Promise<{ ok?: boolean; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db } = c;
  const { data: ver } = await db.from('lab_test_versions').select('id, test_id, lab_tests!inner(team)').eq('id', versionId).maybeSingle();
  if (!ver || (ver as any).lab_tests?.team !== team) return { error: 'Not found' };
  const { count } = await db.from('lab_test_trials').select('id', { count: 'exact', head: true }).eq('version_id', versionId);
  if ((count ?? 0) > 0) return { error: 'Đã làm thử phiên bản này — không xoá được / This version has a trial: it cannot be deleted' };
  const { count: nVer } = await db.from('lab_test_versions').select('id', { count: 'exact', head: true }).eq('test_id', ver.test_id);
  if ((nVer ?? 0) <= 1) return { error: 'Phải còn ít nhất 1 phiên bản / A test keeps at least one version' };
  const { error } = await db.from('lab_test_versions').delete().eq('id', versionId);
  if (error) return { error: error.message };
  await touch(db, ver.test_id);
  return { ok: true };
}

export async function addTrialAction(team: string, testId: string, input: {
  versionId: string; pcs: number; stars?: number | null; verdict?: 'ok' | 'adjust' | 'failed' | null; note?: string | null; photoUrl?: string | null;
}): Promise<{ ok?: boolean; lines?: number; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db, a } = c;
  const { data: t } = await db.from('lab_tests').select('id, name, stage').eq('id', testId).eq('team', team).maybeSingle();
  if (!t) return { error: 'Not found' };
  const { data: v } = await db.from('lab_test_versions').select('*').eq('id', input.versionId).eq('test_id', testId).maybeSingle();
  if (!v) return { error: 'Version not found' };
  const pcs = Number(input.pcs);
  if (!(pcs > 0)) return { error: 'Số cái > 0 / Pieces must be > 0' };
  const today = vnTodayStr();
  const { data: tr, error } = await db.from('lab_test_trials').insert({
    test_id: testId, version_id: v.id, version_n: v.n, pcs,
    stars: input.stars && input.stars >= 1 && input.stars <= 5 ? Math.round(input.stars) : null,
    verdict: input.verdict ?? null, note: input.note?.trim() || null, photo_url: input.photoUrl || null,
    lab_day: today, made_by_id: a.userId, made_by_name: a.name || null,
  }).select('id').single();
  if (error || !tr) return { error: error?.message ?? 'Insert failed' };
  const mv = mapVersion(v); mv.recipe = await fillProductIds(db, mv.recipe);
  const lines = trialConsumption(mv, pcs);
  if (lines.length) {
    const { error: e2 } = await db.from('lab_chef_losses').insert(lines.map(r => ({
      team, kind: 'test', tmpl_id: r.tmplId, product_id: r.productId, sku: r.sku, product_name: r.name, uom: r.uom, qty: r.qty,
      reason_tag_id: REASON_TEST.id, reason_tag_name: REASON_TEST.vi, note: `${t.name} V${v.n} × ${pcs}`,
      test_id: testId, trial_id: tr.id, lab_day: today, declared_by_id: a.userId, declared_by_name: a.name || null,
    })));
    if (e2) return { error: e2.message };
  }
  const upd: any = { last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  if (t.stage === 'idea') upd.stage = 'testing';
  if (input.photoUrl) upd.photo_url = input.photoUrl;
  await db.from('lab_tests').update(upd).eq('id', testId);
  return { ok: true, lines: lines.length };
}

export async function sendToOfficeAction(team: string, testId: string, versionId: string): Promise<{ ok?: boolean; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db, a } = c;
  if (!canApproveForTeam(a, team)) return { error: 'Chỉ trưởng nhóm gửi được / Only the team lead sends to the office' };
  const { data: t } = await db.from('lab_tests').select('id, stage').eq('id', testId).eq('team', team).maybeSingle();
  if (!t) return { error: 'Not found' };
  if (t.stage !== 'testing') return { error: 'Only a test in "Testing" can be sent' };
  const { count } = await db.from('lab_test_trials').select('id', { count: 'exact', head: true }).eq('version_id', versionId);
  if ((count ?? 0) === 0) return { error: 'Hãy làm thử phiên bản này trước / Make a trial of this version first' };
  await db.from('lab_test_versions').update({ is_final: false }).eq('test_id', testId);
  await db.from('lab_test_versions').update({ is_final: true }).eq('id', versionId).eq('test_id', testId);
  const { error } = await db.from('lab_tests').update({ stage: 'sent', last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', testId);
  if (error) return { error: error.message };
  return { ok: true };
}

// Intermediate recipes (SM) existing in Odoo — listed regardless of stock (Axel, 07/11). Cached 1 h.
const cachedSm = unstable_cache(async () => {
  if (!odooConfigured()) return [] as { productId: number; sku: string | null; name: string; uom: string }[];
  const rows = await odooExecute<any[]>('product.product', 'search_read', [[['name', '=ilike', 'SM-%'], ['active', '=', true]]],
    { fields: ['id', 'default_code', 'name', 'uom_id'], limit: 3000, order: 'name' });
  return rows.map(r => ({ productId: r.id, sku: r.default_code || null, name: String(r.name).replace(/^\[[^\]]+\]\s*/, ''), uom: String(r.uom_id?.[1] ?? 'kg') }));
}, ['chef-rd-sm-v1'], { revalidate: 3600 });

export async function listIntermediatesAction(team: string): Promise<{ items?: { productId: number; sku: string | null; name: string; uom: string }[]; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  try { return { items: await cachedSm() }; } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

// The team's own products (to "improve an existing product").
export async function listTeamProductsAction(team: string): Promise<{ items?: { sku: string; name: string; photo: string | null }[]; error?: string }> {
  const c = await ctx(team); if ('error' in c) return { error: c.error };
  const { db } = c;
  const { data } = await db.from('lab_fiche_meta').select('name_en, name_vi, image_url, lab_fiche_variants(sku, label, image_url, is_active)')
    .contains('teams', [team]).eq('is_active', true).limit(500);
  const out: { sku: string; name: string; photo: string | null }[] = [];
  for (const f of data ?? []) for (const v of (f as any).lab_fiche_variants ?? []) {
    if (!v.sku || v.is_active === false) continue;
    const label = v.label && !/^default$/i.test(v.label) ? ` · ${v.label}` : '';
    out.push({ sku: v.sku, name: `${f.name_en || f.name_vi}${label}`, photo: v.image_url || f.image_url || null });
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  return { items: out };
}
