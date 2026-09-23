import type {Metadata, Viewport} from 'next';
import './globals.css'; // Global styles
import ServiceWorkerRegistrar from '@/components/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: 'XAUUSD Institutional Trading Assistant',
  description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
  openGraph: {
    title: 'XAUUSD Institutional Trading Assistant',
    description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
    type: 'website',
  },
  applicationName: 'XAU Assistant',
  appleWebApp: {
    capable: true,
    title: 'XAU Assistant',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'XAUUSD Institutional Trading Assistant',
    description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
  },
};

export const viewport: Viewport = {
  themeColor: '#020617',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <ServiceWorkerRegistrar />
        {children}
      </body>
    </html>
  );
}
