import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'XAUUSD Institutional Trading Assistant',
  description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
  openGraph: {
    title: 'XAUUSD Institutional Trading Assistant',
    description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'XAUUSD Institutional Trading Assistant',
    description: 'Real-time institutional SMC & ICT analysis, multi-timeframe setups, self-learning strategy engine, and risk management for XAUUSD.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
