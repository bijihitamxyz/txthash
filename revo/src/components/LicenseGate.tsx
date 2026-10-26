'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  ShieldAlert,
  Lock,
  Key,
  ExternalLink,
  Loader2,
  AlertCircle,
  Sparkles,
  Send,
  X,
} from 'lucide-react';

export interface LicenseInfo {
  valid: boolean;
  licenseKey: string;
  username: string;
  telegram: string;
  email?: string;
  duration: '7d' | '30d';
  expiresAt: string;
  createdAt?: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
}

export interface LicenseContextType {
  license: LicenseInfo | null;
  remainingDays: number;
  logout: () => void;
  reverify: () => Promise<boolean>;
}

const LicenseContext = createContext<LicenseContextType>({
  license: null,
  remainingDays: 0,
  logout: () => {},
  reverify: async () => false,
});

export const useLicense = () => useContext(LicenseContext);

const LOCAL_STORAGE_KEY = 'exness_quant_license';

export function calculateRemainingDays(expiresAt: string): number {
  if (!expiresAt) return 0;
  const now = Date.now();
  const expTime = new Date(expiresAt).getTime();
  const diffMs = expTime - now;
  if (diffMs <= 0) return 0;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

export const LicenseGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [inputKey, setInputKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isContactModalOpen, setIsContactModalOpen] = useState(false);

  const reverify = useCallback(async (keyToVerify?: string): Promise<boolean> => {
    const key = keyToVerify || license?.licenseKey;
    if (!key) return false;

    try {
      const res = await fetch('/api/license/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: key }),
      });

      const data = await res.json();
      if (res.ok && data.valid) {
        const teleHandle = data.telegram
          ? (data.telegram.startsWith('@') ? data.telegram : `@${data.telegram}`)
          : (data.username?.startsWith('@') ? data.username : `@${data.username || 'user'}`);

        const validatedLicense: LicenseInfo = {
          valid: true,
          licenseKey: data.licenseKey || key,
          username: teleHandle,
          telegram: teleHandle,
          email: data.email,
          duration: data.duration || '7d',
          expiresAt: data.expiresAt,
          createdAt: data.createdAt,
          status: data.status || 'ACTIVE',
        };
        setLicense(validatedLicense);
        if (typeof window !== 'undefined') {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(validatedLicense));
        }
        return true;
      } else {
        // License invalid or expired
        if (typeof window !== 'undefined') {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
        setLicense(null);
        setErrorMessage(data.message || 'Lisensi tidak valid atau telah kadaluarsa.');
        return false;
      }
    } catch {
      setErrorMessage('Gagal menghubungi server lisensi. Silakan periksa koneksi.');
      return false;
    }
  }, [license?.licenseKey]);

  // Initial check on mount
  useEffect(() => {
    let isMounted = true;

    const checkSavedLicense = async () => {
      try {
        if (typeof window === 'undefined') return;
        const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (!saved) {
          if (isMounted) setIsLoading(false);
          return;
        }

        const parsed = JSON.parse(saved);
        if (!parsed || !parsed.licenseKey) {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
          if (isMounted) setIsLoading(false);
          return;
        }

        // Verify with server
        const isValid = await reverify(parsed.licenseKey);
        if (!isValid && isMounted) {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
      } catch {
        if (typeof window !== 'undefined') {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    checkSavedLicense();

    return () => {
      isMounted = false;
    };
  }, [reverify]);

  const handleActivate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanKey = inputKey.trim().toUpperCase();

    if (!cleanKey) {
      setErrorMessage('Masukkan License Key Anda.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/license/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: cleanKey }),
      });

      const data = await res.json();

      if (res.ok && data.valid) {
        const teleHandle = data.telegram
          ? (data.telegram.startsWith('@') ? data.telegram : `@${data.telegram}`)
          : (data.username?.startsWith('@') ? data.username : `@${data.username || 'user'}`);

        const newLicense: LicenseInfo = {
          valid: true,
          licenseKey: data.licenseKey || cleanKey,
          username: teleHandle,
          telegram: teleHandle,
          email: data.email,
          duration: data.duration || '7d',
          expiresAt: data.expiresAt,
          createdAt: data.createdAt,
          status: data.status || 'ACTIVE',
        };

        setLicense(newLicense);
        if (typeof window !== 'undefined') {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newLicense));
        }
        setInputKey('');
      } else {
        setErrorMessage(data.message || 'License Key tidak ditemukan atau tidak aktif.');
      }
    } catch {
      setErrorMessage('Terjadi kesalahan koneksi server saat memverifikasi lisensi.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
    setLicense(null);
    setErrorMessage(null);
  };

  const remainingDays = license?.expiresAt ? calculateRemainingDays(license.expiresAt) : 0;

  // Initial loading splash screen
  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <div className="relative">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Key className="w-6 h-6 animate-pulse" />
            </div>
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-indigo-500 animate-ping" />
          </div>
          <span className="font-mono text-xs tracking-wider text-slate-400 animate-pulse">
            MEMERIKSA OTENTIKASI LISENSI QUANT...
          </span>
        </div>
      </div>
    );
  }

  // If authenticated, render children with Context
  if (license && license.valid) {
    return (
      <LicenseContext.Provider
        value={{
          license,
          remainingDays,
          logout: handleLogout,
          reverify: () => reverify(),
        }}
      >
        {children}
      </LicenseContext.Provider>
    );
  }

  // Not authenticated: Sleek Dark-Mode Institutional Login Gateway
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-indigo-500/30 selection:text-indigo-200">
      {/* Background Ambient Glows */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-indigo-600/10 rounded-full blur-[140px]" />
        <div className="absolute bottom-1/4 left-1/3 w-[500px] h-[300px] bg-emerald-600/5 rounded-full blur-[120px]" />
      </div>

      {/* Top Bar Branding */}
      <header className="relative z-10 max-w-7xl mx-auto w-full px-4 py-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center text-white shadow-lg shadow-indigo-600/20">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-black text-sm sm:text-base tracking-wider text-slate-100">
                QUANT AI
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                PRO v3.8
              </span>
            </div>
            <p className="text-[11px] text-slate-400 font-mono">
              INSTITUTIONAL QUANT TERMINAL (FOREX & CRYPTO)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-900/60 hover:bg-slate-800 border border-slate-800 rounded-lg px-3 py-1.5 transition-colors font-mono"
          >
            <Lock className="w-3.5 h-3.5 text-slate-400" />
            <span>Admin Panel</span>
          </Link>
        </div>
      </header>

      {/* Main Login Card Section */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-md">
          <div className="bg-slate-900/90 border border-slate-800/80 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
            {/* Card Emblem & Title */}
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400 mb-4 shadow-inner">
                <Key className="w-7 h-7 text-indigo-400" />
              </div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white mb-1.5">
                License Key Activation
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 max-w-xs leading-relaxed">
                Masukkan kunci lisensi Quant AI Anda untuk membuka workspace Forex &amp; Crypto.
              </p>
            </div>

            {/* Error Alert Box */}
            {errorMessage && (
              <div className="mb-5 p-3.5 rounded-xl bg-rose-950/60 border border-rose-800/80 flex items-start gap-2.5 text-rose-300 text-xs sm:text-sm animate-in fade-in duration-200">
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium">{errorMessage}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-rose-200"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* License Activation Form */}
            <form onSubmit={handleActivate} className="space-y-4">
              <div>
                <label className="block text-xs font-mono font-medium text-slate-300 mb-2">
                  LICENSE KEY <span className="text-indigo-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={inputKey}
                    onChange={(e) => setInputKey(e.target.value.toUpperCase())}
                    placeholder="EQ-7D-XXXX-XXXX atau EQ-30D-XXXX-XXXX"
                    disabled={isSubmitting}
                    className="w-full bg-slate-950/90 border border-slate-700/80 rounded-xl px-4 py-3 font-mono text-center text-sm sm:text-base tracking-widest text-indigo-300 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all uppercase"
                    autoFocus
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-600">
                    <ShieldCheck className="w-4 h-4" />
                  </div>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-500 font-mono">
                  Format: EQ-7D-XXXX-XXXX / EQ-30D-XXXX-XXXX
                </p>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !inputKey.trim()}
                className="w-full bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-600 hover:from-indigo-500 hover:to-indigo-400 text-white font-semibold text-sm py-3.5 px-4 rounded-xl shadow-lg shadow-indigo-600/25 transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>Memverifikasi Lisensi...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4" />
                    <span>Activate & Enter Terminal</span>
                  </>
                )}
              </button>
            </form>

            {/* Quick Demo Key Helper Note */}
            <div className="mt-5 pt-5 border-t border-slate-800/80 flex flex-col gap-2 text-center">
              <button
                type="button"
                onClick={() => setIsContactModalOpen(true)}
                className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium cursor-pointer inline-flex items-center justify-center gap-1.5"
              >
                <Send className="w-3.5 h-3.5" />
                <span>Belum punya lisensi? Hubungi Admin / Beli Lisensi</span>
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Footer Details */}
      <footer className="relative z-10 max-w-7xl mx-auto w-full px-4 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 font-mono">
        <div>
          <span>Exness Quant AI Trading System • Enterprise Edition</span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/admin" className="hover:text-indigo-400 transition-colors">
            Admin Management (/admin)
          </Link>
          <span>•</span>
          <span className="text-emerald-500/80 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Gateway Online
          </span>
        </div>
      </footer>

      {/* Modal: Contact Admin / Buy License */}
      {isContactModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
            <button
              onClick={() => setIsContactModalOpen(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                <Send className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Hubungi Admin Lisensi</h3>
                <p className="text-xs text-slate-400">Dapatkan lisensi instan 7 Hari atau 30 Hari</p>
              </div>
            </div>

            <div className="space-y-3 my-4 text-xs sm:text-sm text-slate-300 leading-relaxed bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <span className="text-slate-400 font-mono">Telegram Official:</span>
                <span className="font-bold text-indigo-300 font-mono">@viptrader_pro</span>
              </div>
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <span className="text-slate-400 font-mono">Paket 7 Hari:</span>
                <span className="font-semibold text-emerald-400">Trial / Scalper Pass</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-mono">Paket 30 Hari:</span>
                <span className="font-semibold text-indigo-400">Enterprise VIP Pass</span>
              </div>
            </div>

            <p className="text-xs text-slate-400 mb-5">
              Hubungi Telegram kami dengan menyebutkan username Anda untuk aktivasi instan tanpa menunggu.
            </p>

            <div className="flex items-center gap-2">
              <a
                href="https://t.me"
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs sm:text-sm py-2.5 px-4 rounded-xl text-center flex items-center justify-center gap-2 transition-colors"
              >
                <Send className="w-4 h-4" />
                <span>Buka Telegram Admin</span>
              </a>
              <button
                type="button"
                onClick={() => setIsContactModalOpen(false)}
                className="px-4 py-2.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
