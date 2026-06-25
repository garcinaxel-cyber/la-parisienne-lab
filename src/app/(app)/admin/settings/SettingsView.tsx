'use client';
import { useState } from 'react';
import { Settings, Bell, CheckCheck, Webhook } from 'lucide-react';
import { saveNotificationSetting } from './actions';

interface NotifSetting {
  target: string;
  zalo_webhook_url: string | null;
}

interface RowProps {
  label: string;
  sublabel: string;
  target: string;
  initialUrl: string | null;
}

function WebhookRow({ label, sublabel, target, initialUrl }: RowProps) {
  const [url, setUrl] = useState(initialUrl ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true); setError(null); setSaved(false);
    const res = await saveNotificationSetting(target, url);
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border-soft last:border-0">
      <div className="w-36 shrink-0">
        <div className="text-sm font-semibold text-navy">{label}</div>
        <div className="text-xs text-ink-light">{sublabel}</div>
      </div>
      <div className="flex-1 flex items-center gap-2">
        <div className="relative flex-1">
          <Webhook size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
          <input
            type="url"
            value={url}
            onChange={e => { setUrl(e.target.value); setSaved(false); }}
            placeholder="https://zalo.me/webhook/..."
            className="input pl-8 w-full text-sm"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary shrink-0 text-xs px-4 py-2 disabled:opacity-60"
        >
          {saving ? '…' : saved ? <CheckCheck size={14} /> : 'Save'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 shrink-0">{error}</p>}
    </div>
  );
}

const TEAM_LABELS: Record<string, { name: string; desc: string }> = {
  baby_mama: { name: 'Team Baby Mama', desc: 'Publication notifications' },
  hung:      { name: 'Team Hung',      desc: 'Publication notifications' },
  entremet:  { name: 'Team Entremet',  desc: 'Publication notifications' },
  baker:     { name: 'Team Baker',     desc: 'Publication notifications' },
  assistants:{ name: 'Assistants',     desc: 'Production done notifications' },
};

export default function SettingsView({ settings }: { settings: NotifSetting[] }) {
  const byTarget = Object.fromEntries(settings.map(s => [s.target, s.zalo_webhook_url]));

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="font-serif text-3xl font-bold text-navy flex items-center gap-3">
          <Settings size={28} /> Paramètres · Settings
        </h1>
        <p className="text-ink-light text-sm mt-1">Configuration des notifications et intégrations</p>
      </div>

      <div className="card p-6 space-y-1">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={18} className="text-navy" />
          <h2 className="font-semibold text-navy">Notifications Zalo</h2>
        </div>
        <p className="text-xs text-ink-light mb-4">
          Entrez l&apos;URL du webhook Zalo pour chaque équipe. Les notifications de publication seront envoyées aux équipes concernées, et la notification &quot;Production prête&quot; ira au groupe Assistantes.
        </p>

        <div className="border-t border-border-soft">
          {['baby_mama', 'hung', 'entremet', 'baker'].map(target => (
            <WebhookRow
              key={target}
              label={TEAM_LABELS[target].name}
              sublabel={TEAM_LABELS[target].desc}
              target={target}
              initialUrl={byTarget[target] ?? null}
            />
          ))}
        </div>

        <div className="mt-4 pt-4 border-t-2 border-border-soft">
          <p className="text-xs font-semibold text-ink-light uppercase tracking-widest mb-3">Production Done</p>
          <WebhookRow
            label={TEAM_LABELS.assistants.name}
            sublabel={TEAM_LABELS.assistants.desc}
            target="assistants"
            initialUrl={byTarget['assistants'] ?? null}
          />
        </div>
      </div>
    </div>
  );
}
