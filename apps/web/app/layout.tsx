import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '@/components/AuthProvider';
import { FxProvider } from '@/components/Fx';
import { Shell } from '@/components/Shell';
import { ToastProvider } from '@/components/ui';

export const metadata: Metadata = {
  title: { default: 'NUTEX', template: '%s · NUTEX' },
  description: 'NUTEX attendance with location check-in, leave and payroll. Smart Attendance.',
  icons: { icon: '/brand/nutex-mark.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#050816' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <a href="#main" className="sr-only">Skip to content</a>
        <FxProvider />
        <ToastProvider>
          <AuthProvider>
            <Shell>{children}</Shell>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
