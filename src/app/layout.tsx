import type { Metadata, Viewport } from 'next';
import './globals.css';
import { I18nProvider } from '@/lib/i18n';

// Without this, iOS renders at desktop width (980px) and lets the page zoom freely.
// maximumScale 1 keeps the workshop view locked — no accidental pinch/double-tap zoom.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#1A4731',
};

export const metadata: Metadata = {
  title: 'La Parisienne — Lab',
  description: 'Production management for La Parisienne lab',
  manifest: '/manifest.json',
  icons: {
    icon: '/favicon-32.png',
    apple: '/apple-touch-icon.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
