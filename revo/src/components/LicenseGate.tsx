'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { InstitutionalFooter, ThemeToggle } from './InstitutionalChrome';
import {
  ShieldCheck,
  KeyRound,
  Loader2,
  AlertCircle,
  CheckCircle2,
  UserPlus,
  Copy,
  Check,
  ClipboardPaste,
  ArrowRight,
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

function buildValidatedLicense(data: any, fallbackKey: string): LicenseInfo {
  const teleHandle = data.telegram
    ? data.telegram.startsWith('@')
      ? data.telegram
      : `@${data.telegram}`
    : data.username?.startsWith('@')
    ? data.username
    : `@${data.username || 'trader'}`;

  return {
    valid: true,
    licenseKey: data.licenseKey || fallbackKey,
    username: data.username || teleHandle,
    telegram: teleHandle,
    email: data.email,
    duration: data.duration === '30d' ? '30d' : '7d',
    expiresAt: data.expiresAt,
    createdAt: data.createdAt,
    status: data.status || 'ACTIVE',
  };
}

export const LicenseGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [authTab, setAuthTab] = useState<'LOGIN' | 'REGISTER'>('LOGIN');

  // Login via Key state
  const [inputKey, setInputKey] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // User Registration state
  const [regUsername, setRegUsername] = useState('');
  const [regTelegram, setRegTelegram] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDuration, setRegDuration] = useState<'7d' | '30d'>('30d');
  const [registeredLicense, setRegisteredLicense] = useState<LicenseInfo | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const licenseRef = useRef(license);
  useEffect(() => {
    licenseRef.current = license;
  }, [license]);

  const reverify = useCallback(
    async (keyToVerify?: string): Promise<boolean> => {
      const key = keyToVerify || licenseRef.current?.licenseKey;
      if (!key) return false;

      try {
        const res = await fetch('/api/license/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey: key }),
        });

        const data = await res.json();
        if (res.ok && data.valid) {
          const validatedLicense = buildValidatedLicense(data, key);
          setLicense(validatedLicense);
          if (typeof window !== 'undefined') {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(validatedLicense));
          }
          return true;
        } else if (res.status === 401 || data.status === 'REVOKED' || data.status === 'EXPIRED') {
          // Explicitly revoked or expired by server
          if (typeof window !== 'undefined') {
            localStorage.removeItem(LOCAL_STORAGE_KEY);
          }
          setLicense(null);
          setErrorMessage(data.message || 'Access key is invalid, revoked, or expired.');
          return false;
        }
        return false;
      } catch {
        // Network timeout / connection error -> preserve cached valid session
        return false;
      }
    },
    []
  );

  // Initial check on mount: instantly restore cached session without stalling on loading screen
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

        // If local cache is valid and not expired, unlock immediately!
        if (calculateRemainingDays(parsed.expiresAt) > 0) {
          if (isMounted) {
            setLicense(parsed);
            setIsLoading(false);
          }
          // Re-verify in background without stalling UI
          reverify(parsed.licenseKey).catch(() => {});
          return;
        }

        // Only block/await if local cache was expired
        const isValid = await reverify(parsed.licenseKey);
        if (!isValid && isMounted) {
          localStorage.removeItem(LOCAL_STORAGE_KEY);
        }
      } catch {
        // preserve cache on unexpected error
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

  const handleActivate = async (e?: React.FormEvent, explicitKey?: string) => {
    if (e) e.preventDefault();
    const cleanKey = (explicitKey ?? inputKey).trim().toUpperCase();

    if (!cleanKey) {
      setErrorMessage('Please enter your NMSSx Access Key.');
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
        const newLicense = buildValidatedLicense(data, cleanKey);
        setLicense(newLicense);
        if (typeof window !== 'undefined') {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(newLicense));
        }
        setInputKey('');
      } else {
        setErrorMessage(data.message || 'Access key was not found or is inactive.');
      }
    } catch {
      setErrorMessage('Network error while verifying access key.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUser = regUsername.trim();
    if (cleanUser.length < 2) {
      setErrorMessage('Username must be at least 2 characters.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await fetch('/api/license/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'REGISTER',
          username: cleanUser,
          telegram: regTelegram.trim() || cleanUser,
          email: regEmail.trim() || undefined,
          duration: regDuration,
        }),
      });

      const data = await res.json();

      if (res.ok && data.valid && data.licenseKey) {
        const created = buildValidatedLicense(data, data.licenseKey);
        setRegisteredLicense(created);
        setInputKey(created.licenseKey);
      } else {
        setErrorMessage(data.message || 'Failed to register new access key.');
      }
    } catch {
      setErrorMessage('Network error while registering access key.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnterWithRegisteredKey = () => {
    if (!registeredLicense) return;
    setLicense(registeredLicense);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(registeredLicense));
    }
  };

  const handleCopyKey = async (keyText: string) => {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } catch {}
  };

  const handlePasteKey = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputKey(text.trim().toUpperCase());
        setErrorMessage(null);
      }
    } catch {}
  };

  const handleLogout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
    setLicense(null);
    setRegisteredLicense(null);
    setErrorMessage(null);
  };

  const remainingDays = license?.expiresAt ? calculateRemainingDays(license.expiresAt) : 0;

  // Loading splash screen adapting cleanly to Dark & Light themes
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] dark:bg-slate-950 flex flex-col items-center justify-center p-4 text-[#0F172A] dark:text-slate-100 transition-colors">
        <div className="bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 rounded-2xl px-6 py-5 shadow-[0_2px_12px_rgba(15,23,42,0.04)] flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-[#0F172A] dark:bg-zinc-800 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-xs shrink-0">
            NX
          </div>
          <div className="space-y-0.5">
            <div className="font-sans font-bold text-sm text-[#0F172A] dark:text-slate-100 flex items-center gap-2">
              <span>NEMESIS x Trade</span>
              <Loader2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 animate-spin" />
            </div>
            <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              Verifying institutional terminal access key...
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Authenticated: unlock Client Terminal
  if (
    license &&
    license.valid &&
    remainingDays > 0 &&
    license.status !== 'REVOKED' &&
    license.status !== 'EXPIRED'
  ) {
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

  // Unauthenticated: Institutional Login (via Key) & User Registration Gateway
  return (
    <div className="min-h-screen flex flex-col justify-between bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 transition-colors">
      {/* Top Bar */}
      <header className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-zinc-800 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-sm shadow-2xs">
              NX
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-sans font-bold text-[#0F172A] dark:text-slate-100 text-sm sm:text-base tracking-tight">
                  NEMESIS x Trade
                </span>
                <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 font-semibold">
                  CLIENT ACCESS
                </span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono hidden sm:block">
                Exness Forex &amp; Binance Futures Multi-AI Consensus / Risk Governance Terminal
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle showLabel />
          </div>
        </div>
      </header>

      {/* Main Authentication Card */}
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-md bg-white dark:bg-zinc-900/95 border border-slate-200/90 dark:border-zinc-800 rounded-2xl p-6 sm:p-7 shadow-[0_4px_24px_rgba(15,23,42,0.05)] dark:shadow-black/40 space-y-5">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 font-semibold">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>ZERO-TRUST KEY AUTHENTICATION</span>
              </div>
              <h1 className="font-sans font-bold text-xl text-[#0F172A] dark:text-slate-100 tracking-tight">
                {authTab === 'LOGIN' ? 'Client Terminal Login' : 'Register Access Key'}
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                {authTab === 'LOGIN'
                  ? 'Enter your provisioned access key to unlock Forex (Exness) & Crypto (Binance) execution.'
                  : 'Register your trader profile to generate an instant terminal access key.'}
              </p>
            </div>
            <div className="w-11 h-11 rounded-2xl bg-slate-50 dark:bg-zinc-800 border border-slate-200/90 dark:border-zinc-700 flex items-center justify-center text-[#0F172A] shrink-0">
              {authTab === 'LOGIN' ? (
                <KeyRound className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <UserPlus className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              )}
            </div>
          </div>

          {/* Mode Tabs: Login via Key | Register Access Key */}
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 border border-slate-200/80 dark:border-zinc-800 font-mono text-xs">
            <button
              type="button"
              onClick={() => {
                setAuthTab('LOGIN');
                setErrorMessage(null);
              }}
              className={`py-2 px-3 rounded-lg font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'LOGIN'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" />
              <span>Login via Key</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthTab('REGISTER');
                setErrorMessage(null);
              }}
              className={`py-2 px-3 rounded-lg font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                authTab === 'REGISTER'
                  ? 'bg-[#0F172A] dark:bg-emerald-600 text-white shadow-2xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>Register</span>
            </button>
          </div>

          {/* Error Banner */}
          {errorMessage && (
            <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 flex items-start gap-2.5 text-rose-700 dark:text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
              <span className="flex-1 font-medium">{errorMessage}</span>
              <button
                type="button"
                onClick={() => setErrorMessage(null)}
                className="text-rose-400 hover:text-rose-700 dark:hover:text-rose-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* TAB 1: LOGIN VIA KEY */}
          {authTab === 'LOGIN' && (
            <form onSubmit={(e) => handleActivate(e)} className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                    ACCESS KEY <span className="text-emerald-600 dark:text-emerald-400">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={handlePasteKey}
                    className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-500 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 cursor-pointer"
                  >
                    <ClipboardPaste className="w-3 h-3" />
                    <span>Paste</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={inputKey}
                  onChange={(e) => setInputKey(e.target.value.toUpperCase())}
                  placeholder="EQ-30D-XXXX-XXXX"
                  disabled={isSubmitting}
                  className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 font-mono text-center text-sm tracking-widest font-bold text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500 transition-all uppercase"
                  autoFocus
                />
                <p className="text-[11px] text-slate-400 dark:text-zinc-500 font-mono">
                  Format: EQ-7D-XXXX-XXXX or EQ-30D-XXXX-XXXX
                </p>
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !inputKey.trim()}
                className="w-full bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-sans font-bold text-xs sm:text-sm py-3.5 px-4 rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400 dark:text-white" />
                    <span>Verifying Key...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4 text-emerald-400 dark:text-white" />
                    <span>Unlock Client Terminal</span>
                  </>
                )}
              </button>

              <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('REGISTER');
                    setErrorMessage(null);
                  }}
                  className="text-xs font-mono text-slate-500 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                >
                  Need an access key?{' '}
                  <strong className="text-emerald-700 dark:text-emerald-400 underline underline-offset-4">
                    Register new key
                  </strong>
                </button>
              </div>
            </form>
          )}

          {/* TAB 2: USER REGISTRATION */}
          {authTab === 'REGISTER' && (
            <div className="space-y-4">
              {registeredLicense ? (
                <div className="space-y-4">
                  <div className="p-4 rounded-xl bg-emerald-50/80 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 space-y-3">
                    <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-sans font-bold text-xs">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      <span>Access Key Registered &amp; Stored</span>
                    </div>

                    <div className="bg-white dark:bg-slate-950 border border-emerald-200 dark:border-emerald-500/30 rounded-xl p-3 flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-bold tracking-wider text-[#0F172A] dark:text-slate-100 select-all">
                        {registeredLicense.licenseKey}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyKey(registeredLicense.licenseKey)}
                        className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-xs font-mono font-semibold text-[#0F172A] dark:text-slate-100 flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        {copiedKey ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                      <div>
                        Trader:{' '}
                        <strong className="text-[#0F172A] dark:text-white">
                          {registeredLicense.username}
                        </strong>
                      </div>
                      <div className="text-right">
                        Tier:{' '}
                        <strong className="text-emerald-700 dark:text-emerald-400">
                          {registeredLicense.duration.toUpperCase()}
                        </strong>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleEnterWithRegisteredKey}
                    className="w-full bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-sans font-bold text-xs sm:text-sm py-3.5 px-4 rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <span>Activate &amp; Enter Client Terminal</span>
                    <ArrowRight className="w-4 h-4 text-emerald-400 dark:text-white" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setRegisteredLicense(null)}
                    className="w-full text-xs font-mono text-slate-500 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 py-1 cursor-pointer"
                  >
                    Register another key
                  </button>
                </div>
              ) : (
                <form onSubmit={handleRegister} className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="block font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                      USERNAME <span className="text-emerald-600 dark:text-emerald-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={regUsername}
                      onChange={(e) => setRegUsername(e.target.value)}
                      placeholder="e.g. quant_trader"
                      required
                      disabled={isSubmitting}
                      className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 font-mono text-xs text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                        TELEGRAM HANDLE
                      </label>
                      <input
                        type="text"
                        value={regTelegram}
                        onChange={(e) => setRegTelegram(e.target.value)}
                        placeholder="@username"
                        disabled={isSubmitting}
                        className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 font-mono text-xs text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                        EMAIL (OPTIONAL)
                      </label>
                      <input
                        type="email"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="trader@domain.com"
                        disabled={isSubmitting}
                        className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 font-mono text-xs text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                      ACCESS KEY DURATION
                    </label>
                    <div className="grid grid-cols-2 gap-2 font-mono text-xs">
                      <button
                        type="button"
                        onClick={() => setRegDuration('7d')}
                        className={`py-2.5 px-3 rounded-xl border font-semibold transition-all cursor-pointer ${
                          regDuration === '7d'
                            ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600'
                            : 'bg-[#F8FAFC] dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        7 Days (EQ-7D)
                      </button>
                      <button
                        type="button"
                        onClick={() => setRegDuration('30d')}
                        className={`py-2.5 px-3 rounded-xl border font-semibold transition-all cursor-pointer ${
                          regDuration === '30d'
                            ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-[#0F172A] dark:border-emerald-600'
                            : 'bg-[#F8FAFC] dark:bg-slate-950 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800'
                        }`}
                      >
                        30 Days (EQ-30D)
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting || regUsername.trim().length < 2}
                    className="w-full bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-sans font-bold text-xs sm:text-sm py-3.5 px-4 rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin text-emerald-400 dark:text-white" />
                        <span>Provisioning Access Key...</span>
                      </>
                    ) : (
                      <>
                        <UserPlus className="w-4 h-4 text-emerald-400 dark:text-white" />
                        <span>Generate &amp; Register Access Key</span>
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      </main>

      <InstitutionalFooter />
    </div>
  );
};
