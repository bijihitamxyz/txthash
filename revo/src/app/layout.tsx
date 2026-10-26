import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Exness Quant AI Auto-Trader | EA + LLM Confluence',
  description: 'Next.js Institutional Forex & Gold Automated Trading Terminal with Exness REST/WebSocket & AI Confluence Judge',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
