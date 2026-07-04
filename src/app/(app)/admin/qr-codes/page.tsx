import Link from 'next/link';
import { TEAMS, TEAM_LABELS } from '@/lib/types';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://la-parisienne-lab.vercel.app';

export default function QrCodesPage() {
  const teams = TEAMS.map(team => ({
    team,
    label: TEAM_LABELS[team],
    url: `${BASE_URL}/station/${team}`,
    qr: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(`${BASE_URL}/station/${team}`)}&format=png`,
  }));

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="font-serif text-3xl font-bold text-navy mb-1">QR Codes — Stations</h1>
        <p className="text-ink-light text-sm">
          Print and display these at each team's workstation. Scanning opens the station view directly.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {teams.map(({ team, label, url, qr }) => (
          <div key={team} className="card p-6 flex flex-col items-center gap-4 text-center">
            {/* Team header */}
            <div className="w-full flex items-center justify-between">
              <div>
                <div className="font-bold text-lg" style={{ color: label.color }}>{label.en}</div>
                <div className="text-xs text-ink-light font-mono mt-0.5">{url}</div>
              </div>
              <Link href={`/station/${team}`} target="_blank"
                className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors"
                style={{ borderColor: label.color, color: label.color }}>
                Open →
              </Link>
            </div>

            {/* QR code */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qr}
              alt={`QR code for ${label.en}`}
              width={220}
              height={220}
              className="rounded-xl border"
              style={{ borderColor: '#E0D49A' }}
            />

            {/* Print button */}
            <a
              href={qr.replace('300x300', '600x600')}
              download={`qr-station-${team}.png`}
              className="text-xs font-semibold px-4 py-2 rounded-lg transition-colors"
              style={{ backgroundColor: label.bg, color: label.color }}>
              ⬇ Download PNG
            </a>
          </div>
        ))}
      </div>

      {/* Print instructions */}
      <div className="mt-8 p-4 rounded-xl text-sm text-ink-light"
        style={{ backgroundColor: '#F9F6F0', border: '1px solid #E0D49A' }}>
        💡 Tip: Download each QR code as PNG and print at A5 or A6 size. Laminate for durability.
        Each code links directly to that team's station view. The tablet must be signed in
        (use a worker account per team) — anyone not signed in is sent to the login page.
      </div>
    </main>
  );
}
