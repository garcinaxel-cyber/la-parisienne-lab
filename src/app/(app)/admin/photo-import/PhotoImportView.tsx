'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { thumb } from '@/lib/img-thumb';
import {
  getPhotoImportStatusAction, runPhotoImportBatchAction, retryPhotoImportAction,
  type PhotoImportStatus, type PhotoImportRow,
} from './actions';

const GROUPS: { key: string; label: string }[] = [
  { key: 'A', label: 'Lab app photo replaced by the website photo' },
  { key: 'N', label: 'Matched by name, website photo' },
  { key: 'B', label: 'No photo before, website photo added' },
  { key: 'C', label: 'Older website photo replaced by the current one' },
  { key: 'C0', label: 'Same photo, copied into the lab app' },
  { key: 'D', label: 'Product no longer on the website, photo copied as is' },
];

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'Waiting', color: '#6B7280', bg: '#F3F4F6' },
  copied: { label: 'Copied, being checked', color: '#92600A', bg: '#FFFAEE' },
  applied: { label: 'Imported', color: '#1A4731', bg: '#E8F3EC' },
  skipped: { label: 'Skipped', color: '#92600A', bg: '#FFFAEE' },
  error: { label: 'Error', color: '#B91C1C', bg: '#FEF2F2' },
};

function Row({ r }: { r: PhotoImportRow }) {
  const st = STATUS[r.status] ?? STATUS.pending;
  const shown = r.status === 'applied' ? r.newUrl : r.oldUrl;
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-sm" style={{ borderTop: '1px solid #F3F4F6' }}>
      {shown ? (
        <img src={thumb(shown, 80)} alt="" loading="lazy" className="w-10 h-10 rounded-lg object-cover shrink-0" style={{ border: '1px solid #E5E7EB' }} />
      ) : (
        <div className="w-10 h-10 rounded-lg shrink-0" style={{ border: '1px dashed #D1D5DB', backgroundColor: '#F9FAFB' }} />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium break-words">{r.nameVi || '(no name)'}</div>
        <div className="text-xs text-gray-500">{r.sku ?? ''}{r.error ? <span className="text-red-700">{r.sku ? ' · ' : ''}{r.error}</span> : null}</div>
      </div>
      <span className="text-[11px] font-bold rounded-full px-2.5 py-1 shrink-0" style={{ color: st.color, backgroundColor: st.bg }}>{st.label}</span>
    </div>
  );
}

export default function PhotoImportView() {
  const [status, setStatus] = useState<PhotoImportStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  async function refresh() {
    const s = await getPhotoImportStatusAction();
    setStatus(s);
    if (s.error) setError(s.error);
    return s;
  }
  useEffect(() => { refresh(); }, []);

  async function run() {
    if (running) return;
    if (!window.confirm('Copy the website photos into the lab app and switch the recipe cards to them?')) return;
    setRunning(true); setError(null); setMessage(null); stop.current = false;
    let idle = 0;
    try {
      for (let i = 0; i < 200 && !stop.current; i++) {
        const res = await runPhotoImportBatchAction(15);
        await refresh();
        if (res.error) { setError(res.error); break; }
        if (res.done) { setMessage('Finished.'); break; }
        // Nothing moved twice in a row: stop rather than loop for ever.
        idle = res.copied + res.failed + res.applied + res.skipped === 0 ? idle + 1 : 0;
        if (idle >= 2) { setError('The import is not progressing. Wait a minute, then press the button again.'); break; }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The import stopped unexpectedly. Press the button again to continue.');
    }
    setRunning(false);
    await refresh();
  }

  async function retry() {
    setError(null); setMessage(null);
    const res = await retryPhotoImportAction();
    if (res.error) setError(res.error);
    await refresh();
  }

  const byGroup = useMemo(() => {
    const m = new Map<string, PhotoImportRow[]>();
    for (const r of status?.rows ?? []) { const a = m.get(r.grp) ?? []; a.push(r); m.set(r.grp, a); }
    return m;
  }, [status]);

  const total = status?.total ?? 0;
  const done = (status?.applied ?? 0) + (status?.skipped ?? 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const stuck = (status?.failed ?? 0) + (running ? 0 : (status?.copied ?? 0));
  const finished = !!status && total > 0 && status.pending === 0 && status.copied === 0 && status.failed === 0;

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Download size={22} className="text-navy" />
        <h1 className="text-xl font-bold">Website photo import</h1>
      </div>

      <div className="bg-white rounded-2xl p-5 space-y-3" style={{ border: '1px solid #E5E7EB' }}>
        <p className="text-sm text-gray-600">
          One-time copy of the website&apos;s product photos into the lab app&apos;s own storage. After the
          import the recipe cards use these copies: later changes on the website do not affect the
          lab app. Photos that belong to a single variant are not touched.
        </p>

        {!status ? (
          <div className="py-4 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              {[
                { v: total, l: 'In the list' },
                { v: status.applied, l: 'Imported' },
                { v: status.pending + status.copied, l: 'Waiting' },
                { v: status.failed + status.skipped, l: 'Errors / skipped' },
              ].map(t => (
                <div key={t.l} className="rounded-xl px-2 py-2.5" style={{ backgroundColor: '#FAF7F0', border: '1px solid #EFE7D6' }}>
                  <div className="text-xl font-extrabold" style={{ color: '#1A4731' }}>{t.v}</div>
                  <div className="text-[11px] text-gray-500">{t.l}</div>
                </div>
              ))}
            </div>

            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#F3F4F6' }}>
              <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: '#1A4731' }} />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {status.pending > 0 && (
                <button onClick={run} disabled={running}
                  className="inline-flex items-center gap-2 text-sm font-bold rounded-lg px-4 py-2.5 text-white disabled:opacity-60"
                  style={{ backgroundColor: '#1A4731' }}>
                  {running ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {running ? `Importing… ${done} / ${total}` : `Import ${status.pending} photos`}
                </button>
              )}
              {running && (
                <button onClick={() => { stop.current = true; }} className="text-sm font-semibold rounded-lg px-3 py-2.5 text-gray-600" style={{ border: '1px solid #E5E7EB' }}>
                  Pause
                </button>
              )}
              {!running && stuck > 0 && (
                <button onClick={retry} className="inline-flex items-center gap-2 text-sm font-semibold rounded-lg px-3 py-2.5" style={{ border: '1px solid #E5E7EB', color: '#1A4731' }}>
                  <RefreshCw size={14} /> Put {stuck} back in the queue
                </button>
              )}
            </div>

            {finished && (
              <div className="flex items-start gap-2 text-sm rounded-lg px-3 py-2" style={{ backgroundColor: '#E8F3EC', color: '#1A4731' }}>
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
                <span>{status.applied} photos imported{status.skipped ? `, ${status.skipped} skipped because the recipe card photo was changed in the meantime` : ''}.</span>
              </div>
            )}
            {message && !finished && <div className="text-xs text-gray-500">{message}</div>}
          </>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-red-700" style={{ backgroundColor: '#FEF2F2' }}>
            <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
          </div>
        )}
      </div>

      {GROUPS.map(g => {
        const rows = byGroup.get(g.key) ?? [];
        if (!rows.length) return null;
        const ok = rows.filter(r => r.status === 'applied').length;
        return (
          <details key={g.key} className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
            <summary className="px-4 py-3 text-sm font-semibold cursor-pointer flex items-center gap-2">
              <span className="flex-1 min-w-0">{g.label}</span>
              <span className="text-xs text-gray-500 shrink-0">{ok} / {rows.length}</span>
            </summary>
            {rows.map(r => <Row key={r.id} r={r} />)}
          </details>
        );
      })}
    </div>
  );
}
