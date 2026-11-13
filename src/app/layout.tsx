import type { Metadata, Viewport } from 'next';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';
import { isPreviewReadOnly, browserPreviewGuardScript } from '@/lib/preview-guard';

// Without this, iOS renders at desktop width (980px) and lets the page zoom freely.
// maximumScale 1 keeps the workshop view locked — no accidental pinch/double-tap zoom.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#2A1810',
};

export const metadata: Metadata = {
  title: 'La Paris — Lab',
  description: 'Production management for La Parisienne lab',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon-32.png',
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const preview = isPreviewReadOnly();
  return (
    <html lang="vi">
      <body>
        {/* Vercel PREVIEW only: read-only guard + a visible strip. Never rendered in production. */}
        {preview && <script dangerouslySetInnerHTML={{ __html: browserPreviewGuardScript() }} />}
        {preview && (
          <div className="text-center text-[11px] font-bold tracking-wide py-1"
            style={{ backgroundColor: '#B8893A', color: '#2A1810' }}>
            PREVIEW · chỉ xem, không lưu · read-only, nothing is saved
          </div>
        )}
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
