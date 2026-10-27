'use client';
// Quick replies for the Tin nhắn tab — type "/" in the composer (like Pancake) to drop a saved
// message (+ its menu photos) into the reply. Shared by the whole team; managed in a small modal.
// Axel, 2026-10-27.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X, Plus, Trash2, ImageIcon, Zap, Search } from 'lucide-react';
import * as inbox from './inbox-actions';
import type { InboxQuickReply } from './inbox-actions';
import { NAVY, GOLD, CREAM, INK, INK_LIGHT, BORDER, useL } from './shared';

const HAIR = '#EFE9CF';

// One fetch per page load, shared by every open thread.
let cache: InboxQuickReply[] | null = null;
let inflight: Promise<InboxQuickReply[]> | null = null;
const listeners = new Set<(r: InboxQuickReply[]) => void>();
function publish(r: InboxQuickReply[]) { cache = r; listeners.forEach(l => l(r)); }
async function fetchReplies(force = false) {
  if (cache && !force) return cache;
  if (!inflight) inflight = inbox.listQuickRepliesAction().then(r => { inflight = null; const list = r.replies ?? []; publish(list); return list; });
  return inflight;
}

export function useQuickReplies() {
  const [replies, setReplies] = useState<InboxQuickReply[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setReplies);
    fetchReplies();
    return () => { listeners.delete(setReplies); };
  }, []);
  return { replies, reload: () => fetchReplies(true) };
}

export function filterReplies(replies: InboxQuickReply[], q: string) {
  const s = q.trim().toLowerCase();
  if (!s) return replies;
  const starts = replies.filter(r => r.shortcut.toLowerCase().startsWith(s));
  const rest = replies.filter(r => !starts.includes(r) && (r.shortcut.toLowerCase().includes(s) || r.body.toLowerCase().includes(s)));
  return [...starts, ...rest];
}

/** Popup list shown above the composer while the user types "/…". */
export function QuickReplyPopup({ items, activeIndex, onPick, onHover }: { items: InboxQuickReply[]; activeIndex: number; onPick: (r: InboxQuickReply) => void; onHover: (i: number) => void }) {
  const { tr } = useL();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector(`[data-i="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);
  return (
    <div ref={ref} role="listbox" className="absolute left-0 right-0 bottom-full mb-2 overflow-y-auto z-20"
      style={{ maxHeight: 300, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: '0 8px 24px rgba(40,30,10,.12)' }}>
      <div className="px-3 py-1.5" style={{ fontSize: 11, color: INK_LIGHT, borderBottom: `1px solid ${HAIR}` }}>{tr('qrPopupHelp')}</div>
      {items.length === 0 && <div className="px-3 py-3" style={{ fontSize: 12.5, color: INK_LIGHT }}>{tr('qrNone')}</div>}
      {items.map((r, i) => (
        <button key={r.id} data-i={i} role="option" aria-selected={i === activeIndex} onMouseDown={e => { e.preventDefault(); onPick(r); }} onMouseEnter={() => onHover(i)}
          className="w-full text-left flex gap-2 px-3 py-2" style={{ backgroundColor: i === activeIndex ? CREAM : '#fff', borderBottom: `1px solid ${HAIR}` }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: NAVY, minWidth: 54 }}>/{r.shortcut}</span>
          <span className="flex-1 min-w-0" style={{ fontSize: 12.5, color: INK, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-line' }}>{r.body}</span>
          {r.images.length > 0 && <span className="flex items-center gap-0.5 self-start" style={{ fontSize: 11, color: '#8A6D14' }}><ImageIcon size={12} aria-hidden />{r.images.length}</span>}
        </button>
      ))}
    </div>
  );
}

async function shrinkImage(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 900_000 && file.type === 'image/jpeg') return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'menu.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

/** Modal to add / edit / delete the team's quick replies. */
export function QuickReplyManager({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const { tr } = useL();
  const { replies } = useQuickReplies();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ id: string | null; shortcut: string; body: string; images: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => filterReplies(replies, q), [replies, q]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  function startEdit(r: InboxQuickReply | null) {
    setErr(null); setConfirmDel(false);
    setEdit(r ? { id: r.id, shortcut: r.shortcut, body: r.body, images: [...r.images] } : { id: null, shortcut: '', body: '', images: [] });
  }

  async function addFiles(files: FileList | null) {
    if (!files || !edit) return;
    const list = Array.from(files).slice(0, 10 - edit.images.length);
    setUploading(n => n + list.length); setErr(null);
    for (const f of list) {
      const fd = new FormData(); fd.append('file', await shrinkImage(f));
      const r = await inbox.uploadQuickReplyImageAction(fd);
      setUploading(n => n - 1);
      if (r.url) setEdit(e => e ? { ...e, images: [...e.images, r.url!] } : e);
      else setErr(tr('qrUploadFailed'));
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  async function save() {
    if (!edit) return;
    setBusy(true); setErr(null);
    const r = await inbox.saveQuickReplyAction(edit);
    setBusy(false);
    if (r.error) { setErr(r.error === 'duplicate' ? tr('qrDuplicate') : r.error === 'shortcut' ? tr('qrBadShortcut') : r.error === 'body' ? tr('qrEmptyBody') : r.error); return; }
    await fetchReplies(true); setEdit(null);
  }

  async function remove() {
    if (!edit?.id) return;
    if (!confirmDel) { setConfirmDel(true); return; }
    setBusy(true);
    await inbox.deleteQuickReplyAction(edit.id);
    setBusy(false); await fetchReplies(true); setEdit(null);
  }

  const label: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: INK_LIGHT, textTransform: 'uppercase', letterSpacing: '.04em' };
  const input: React.CSSProperties = { width: '100%', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '8px 10px', fontSize: 13.5, color: INK, background: '#fff', outline: 'none' };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" style={{ backgroundColor: 'rgba(30,25,10,.35)' }} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal aria-label={tr('qrTitle')} className="w-full sm:max-w-[640px] flex flex-col rounded-t-2xl sm:rounded-2xl"
        style={{ maxHeight: '92dvh', background: '#fff', boxShadow: '0 20px 50px rgba(0,0,0,.2)' }}>
        <div className="flex items-center gap-2 px-4" style={{ minHeight: 54, borderBottom: `1px solid ${HAIR}` }}>
          <Zap size={17} color="#8A6D14" aria-hidden />
          <div className="flex-1" style={{ fontWeight: 700, fontSize: 15, color: INK }}>{edit ? (edit.id ? tr('qrEdit') : tr('qrAdd')) : tr('qrTitle')}</div>
          <button onClick={onClose} aria-label={tr('qrClose')} className="flex items-center justify-center" style={{ width: 36, height: 36, color: INK_LIGHT }}><X size={18} /></button>
        </div>

        {!edit && (
          <>
            <div className="px-4 pt-3 pb-2 flex gap-2">
              <label className="flex-1 flex items-center gap-2 px-3" style={{ height: 38, border: `1px solid ${BORDER}`, borderRadius: 10 }}>
                <Search size={14} color={INK_LIGHT} aria-hidden /><span className="sr-only">{tr('qrSearchPh')}</span>
                <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('qrSearchPh')} className="flex-1 bg-transparent outline-none" style={{ fontSize: 13, color: INK }} />
              </label>
              {!readOnly && (
                <button onClick={() => startEdit(null)} className="flex items-center gap-1.5 px-3" style={{ height: 38, borderRadius: 10, backgroundColor: NAVY, color: '#FFFAEE', fontSize: 13, fontWeight: 600 }}>
                  <Plus size={15} aria-hidden /> {tr('qrAdd')}
                </button>
              )}
            </div>
            <div className="px-4 pb-1" style={{ fontSize: 12, color: INK_LIGHT }}>{tr('qrHelp')}</div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {shown.map(r => (
                <button key={r.id} onClick={() => !readOnly && startEdit(r)} className="w-full text-left flex gap-3 px-2 py-2.5" style={{ borderBottom: `1px solid ${HAIR}`, cursor: readOnly ? 'default' : 'pointer' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: NAVY, minWidth: 66 }}>/{r.shortcut}</span>
                  <span className="flex-1 min-w-0 flex flex-col gap-1">
                    <span style={{ fontSize: 12.5, color: INK, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-line' }}>{r.body}</span>
                    {r.images.length > 0 && (
                      <span className="flex gap-1">
                        {r.images.slice(0, 6).map(u => (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={u} src={u} alt="" loading="lazy" style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, border: `1px solid ${HAIR}` }} />
                        ))}
                      </span>
                    )}
                    {r.needsImages && !r.images.length && (
                      <span className="self-start" style={{ fontSize: 11, color: '#8A6D14', backgroundColor: CREAM, borderRadius: 4, padding: '1px 6px' }}>{tr('qrNeedsImages').replace('{x}', r.needsImages)}</span>
                    )}
                  </span>
                </button>
              ))}
              {shown.length === 0 && <div className="text-center py-8" style={{ fontSize: 13, color: INK_LIGHT }}>{tr('qrNone')}</div>}
            </div>
          </>
        )}

        {edit && (
          <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span style={label}>{tr('qrShortcut')}</span>
              <span className="flex items-center" style={{ ...input, padding: 0 }}>
                <span style={{ padding: '0 0 0 10px', color: NAVY, fontWeight: 700 }}>/</span>
                <input value={edit.shortcut} onChange={e => setEdit({ ...edit, shortcut: e.target.value.replace(/\s+/g, '').replace(/^\/+/, '') })} maxLength={20}
                  placeholder="tira" className="flex-1 bg-transparent outline-none" style={{ padding: '8px 10px 8px 2px', fontSize: 13.5, color: INK }} />
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span style={label}>{tr('qrBody')}</span>
              <textarea value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} rows={8} maxLength={2000} style={{ ...input, resize: 'vertical', lineHeight: 1.45 }} />
            </label>
            <div className="flex flex-col gap-1.5">
              <span style={label}>{tr('qrImages')}</span>
              <div className="flex flex-wrap gap-2">
                {edit.images.map(u => (
                  <span key={u} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={u} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${HAIR}` }} />
                    <button onClick={() => setEdit({ ...edit, images: edit.images.filter(x => x !== u) })} aria-label={tr('qrRemoveImage')}
                      className="absolute flex items-center justify-center" style={{ top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: INK, color: '#fff' }}><X size={12} /></button>
                  </span>
                ))}
                {Array.from({ length: uploading }).map((_, i) => (
                  <span key={`u${i}`} className="flex items-center justify-center" style={{ width: 72, height: 72, borderRadius: 8, border: `1px dashed ${BORDER}` }}><Loader2 className="animate-spin" size={16} color={NAVY} /></span>
                ))}
                {edit.images.length + uploading < 10 && (
                  <button onClick={() => fileRef.current?.click()} className="flex flex-col items-center justify-center gap-1"
                    style={{ width: 72, height: 72, borderRadius: 8, border: `1px dashed ${BORDER}`, color: '#8A6D14', fontSize: 10.5 }}>
                    <ImageIcon size={18} aria-hidden />{tr('qrAddImages')}
                  </button>
                )}
                <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => addFiles(e.target.files)} />
              </div>
            </div>
            {err && <div style={{ fontSize: 12.5, color: '#B42318' }}>{err}</div>}
          </div>
        )}

        {edit && (
          <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: `1px solid ${HAIR}` }}>
            {edit.id && (
              <button onClick={remove} disabled={busy} className="flex items-center gap-1.5 px-3" style={{ height: 40, borderRadius: 10, border: '1px solid #F2C6C2', color: '#B42318', fontSize: 13, fontWeight: 600 }}>
                <Trash2 size={14} aria-hidden /> {confirmDel ? tr('qrConfirmDelete') : tr('qrDelete')}
              </button>
            )}
            <div className="flex-1" />
            <button onClick={() => setEdit(null)} className="px-3" style={{ height: 40, borderRadius: 10, border: `1px solid ${BORDER}`, color: INK, fontSize: 13 }}>{tr('qrCancel')}</button>
            <button onClick={save} disabled={busy || uploading > 0} className="flex items-center gap-1.5 px-4" style={{ height: 40, borderRadius: 10, backgroundColor: GOLD, color: NAVY, fontSize: 13.5, fontWeight: 700, opacity: busy || uploading ? 0.6 : 1 }}>
              {busy && <Loader2 className="animate-spin" size={14} />} {tr('qrSave')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
