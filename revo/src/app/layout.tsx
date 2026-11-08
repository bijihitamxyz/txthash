import type { Metadata } from 'next';
import './globals.css';
import { ThemeProvider } from '@/components/InstitutionalChrome';

export const metadata: Metadata = {
  title: 'NEMESIS x Trade (nmssx.xyz) | Multi-AI & Quantitative Trading Terminal',
  description:
    'NEMESIS x Trade is an institutional-grade quantitative trading terminal engineered with Kronos time-series foundation model forecasting, Multi-AI autonomous risk governance, and ultra-low latency Ed25519 Exness execution pipelines.',
};

const themeInitScript = `(function(){try{var t=localStorage.getItem('nmssx-theme');var d=t?t==='dark':true;if(d){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 antialiased min-h-screen transition-colors duration-150">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
