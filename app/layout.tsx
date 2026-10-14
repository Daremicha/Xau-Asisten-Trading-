import type {Metadata, Viewport} from 'next';
import './globals.css'; // Global styles
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'Asisten Trading XAUUSD',
  description: 'Analisis SMC & ICT real-time, setup multi-timeframe, engine strategi self-learning, dan manajemen risiko untuk XAUUSD.',
  openGraph: {
    title: 'Asisten Trading XAUUSD',
    description: 'Analisis SMC & ICT real-time, setup multi-timeframe, engine strategi self-learning, dan manajemen risiko untuk XAUUSD.',
    type: 'website',
  },
  applicationName: 'Asisten XAU',
  appleWebApp: {
    capable: true,
    title: 'Asisten XAU',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Asisten Trading XAUUSD',
    description: 'Analisis SMC & ICT real-time, setup multi-timeframe, engine strategi self-learning, dan manajemen risiko untuk XAUUSD.',
  },
};

export const viewport: Viewport = {
  themeColor: '#020617',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="id">
      <body suppressHydrationWarning>
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
