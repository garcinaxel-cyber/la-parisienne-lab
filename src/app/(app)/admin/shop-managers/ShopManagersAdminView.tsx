'use client';
import { useEffect, useState } from 'react';
import { UserCog, Loader2, CheckCircle2, AlertCircle, KeyRound } from 'lucide-react';
import { provisionShopManagerAccountsAction, listShopManagersAction, type ProvisionResult, type ShopManagerRow } from './actions';

export default function ShopManagersAdminView() {
  const [managers, setManagers] = useState<ShopManagerRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ProvisionResult[] | null>(null);

  async function load() {
    const res = await listShopManagersAction();
    setManagers(res.managers ?? []);
  }
  useEffect(() => { load(); }, []);

  async function run() {
    setRunning(true);
    setResults(null);
    const res = await provisionShopManagerAccountsAction();
    setResults(res.results ?? null);
    setRunning(false);
    load();
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <UserCog size={22} className="text-navy" />
        <h1 className="text-xl font-bold">Shop managers</h1>
      </div>

      <div className="bg-white rounded-2xl p-5 space-y-3" style={{ border: '1px solid #E5E7EB' }}>
        <div className="text-sm font-semibold">Provision the 3 shop manager accounts</div>
        <p className="text-xs text-gray-500">
          Creates (or updates the password of) the 3 individual shop-manager logins, each covering every
          portal shop. Safe to run more than once — existing accounts are updated in place, PINs are
          only generated the first time.
        </p>
        <button onClick={run} disabled={running}
          className="inline-flex items-center gap-2 text-sm font-bold rounded-lg px-4 py-2.5 text-white disabled:opacity-50"
          style={{ backgroundColor: '#1f2937' }}>
          {running && <Loader2 size={14} className="animate-spin" />}
          Create / update the 3 managers
        </button>

        {results && (
          <div className="space-y-1.5 pt-1">
            {results.map(r => (
              <div key={r.email} className="flex items-center gap-2 text-xs rounded-lg px-3 py-2" style={{ backgroundColor: '#F9FAFB' }}>
                {r.status === 'error' ? <AlertCircle size={14} className="text-red-600 shrink-0" /> : <CheckCircle2 size={14} className="text-green-600 shrink-0" />}
                <span className="font-semibold">{r.name}</span>
                <span className="text-gray-500">{r.email}</span>
                <span className="text-gray-400">·</span>
                <span>{r.status === 'created' ? 'created' : r.status === 'updated' ? 'updated' : r.error}</span>
                {r.pin && (
                  <span className="ml-auto inline-flex items-center gap-1 font-bold text-amber-700">
                    <KeyRound size={12} /> PIN {r.pin}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide" style={{ borderBottom: '1px solid #E5E7EB' }}>
          All shop managers (PIN-unlock rows and individual logins)
        </div>
        {!managers ? (
          <div className="py-6 text-center"><Loader2 size={16} className="animate-spin inline text-gray-400" /></div>
        ) : !managers.length ? (
          <div className="px-4 py-4 text-xs text-gray-400">None yet</div>
        ) : managers.map((m, i) => (
          <div key={m.id} className="flex items-center gap-2.5 px-4 py-2.5 text-sm" style={{ borderTop: i === 0 ? 'none' : '1px solid #F3F4F6' }}>
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
            <div className="font-semibold flex-1 min-w-0">{m.name}</div>
            <div className="text-xs text-gray-500 shrink-0">{m.shops.length} shop{m.shops.length > 1 ? 's' : ''}</div>
            <div className="text-xs shrink-0" style={{ color: m.hasLogin ? '#15803D' : '#9CA3AF' }}>{m.hasLogin ? 'individual login' : 'PIN only'}</div>
            {!m.active && <div className="text-xs text-red-600 shrink-0">inactive</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
