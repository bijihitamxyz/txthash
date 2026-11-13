'use client';

import React, { useState, useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import {
  ShieldCheck,
  X,
  Eye,
  EyeOff,
  Lock,
  Server,
  Check,
  AlertCircle,
  RefreshCw,
  KeyRound,
  Cpu,
} from 'lucide-react';

export const ExnessVaultModal: React.FC = () => {
  const isApiKeyModalOpen = useTradingStore((s) => s.isApiKeyModalOpen || s.isVaultModalOpen);
  const closeApiKeyModal = useTradingStore((s) => s.closeApiKeyModal);
  const addTelemetryLog = useTradingStore((s) => s.addTelemetryLog);
  const fetchAccountInfo = useTradingStore((s) => s.fetchAccountInfo);
  const setCredentials = useTradingStore((s) => s.setCredentials);

  // Exness Exchange Credentials States ONLY (AI & VPS config are strictly Admin-managed)
  const [mode, setMode] = useState<'DEMO' | 'REAL'>('DEMO');
  const [accountId, setAccountId] = useState('');
  const [server, setServer] = useState('https://api.exness-api.com');
  const [apiKey, setApiKey] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: 'success' | 'error';
    text: string;
    metrics?: { balance: number; equity: number; latencyMs?: number };
  } | null>(null);

  useEffect(() => {
    if (isApiKeyModalOpen) {
      setStatusMessage(null);

      fetch('/api/exness/vault')
        .then((res) => res.json())
        .then((data) => {
          if (data?.success && data?.credentials) {
            const creds = data.credentials;
            if (creds.mode) setMode(creds.mode);
            if (creds.accountId) setAccountId(creds.accountId);
            if (creds.server) setServer(creds.server);
            if (creds.apiKey) setApiKey(creds.apiKey);
          }
        })
        .catch(() => {});
    }
  }, [isApiKeyModalOpen]);

  if (!isApiKeyModalOpen) return null;

  const handleCloseModal = () => {
    closeApiKeyModal();
    useTradingStore.getState().closeVaultModal();
  };

  const handleSaveAndConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanAccountId = accountId.trim();
    const cleanApiKey = apiKey.trim();
    const cleanPrivateKey = privateKey.trim();
    let cleanServer = server.trim();
    if (!cleanServer) {
      cleanServer = 'https://api.exness-api.com';
    }

    if (!cleanAccountId || !/^\d+$/.test(cleanAccountId)) {
      setStatusMessage({
        type: 'error',
        text: 'Account ID Exness tidak valid. Masukkan nomor login MT5/Terminal berupa angka (contoh: 464129221 atau 30000143146).',
      });
      return;
    }

    if (!cleanApiKey.startsWith('exnsk-') || cleanApiKey.length < 36) {
      setStatusMessage({
        type: 'error',
        text: "API Key Exness tidak valid. Gunakan Public Key resmi berawalan 'exnsk-' dari menu API Management Exness.",
      });
      return;
    }

    if (!cleanPrivateKey) {
      setStatusMessage({
        type: 'error',
        text: 'Private Key Ed25519 wajib diisi (128-char Hex, 64-char Hex seed, Base64, atau PEM PKCS#8 resmi Exness).',
      });
      return;
    }

    setIsLoading(true);
    setStatusMessage(null);

    try {
      const res = await fetch('/api/exness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'connect',
          credentials: {
            accountId: cleanAccountId,
            mode,
            server: cleanServer,
            apiKey: cleanApiKey,
            privateKey: cleanPrivateKey,
          },
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage({
          type: 'success',
          text: `Verified & Encrypted in AES-256 Vault: Account #${data.accountId || cleanAccountId} (${mode} Mode)`,
          metrics: {
            balance: Number(data.balance ?? 0.0),
            equity: Number(data.equity ?? 0.0),
            latencyMs: data.latencyMs || 14,
          },
        });

        try {
          await setCredentials({
            accountMode: mode,
            demoAccountId: mode === 'DEMO' ? cleanAccountId : undefined,
            demoServer: mode === 'DEMO' ? cleanServer : undefined,
            demoApiKey: mode === 'DEMO' ? cleanApiKey : undefined,
            demoApiSecret: mode === 'DEMO' ? cleanPrivateKey : undefined,
            realAccountId: mode === 'REAL' ? cleanAccountId : undefined,
            realServer: mode === 'REAL' ? cleanServer : undefined,
            realApiKey: mode === 'REAL' ? cleanApiKey : undefined,
            realApiSecret: mode === 'REAL' ? cleanPrivateKey : undefined,
          });
        } catch (vaultErr) {
          console.warn('[ExnessVaultModal] Local vault sync warning (server vault already saved):', vaultErr);
        }

        addTelemetryLog(
          'VAULT',
          'INFO',
          `[SECURITY] Exness Ed25519 credentials verified & saved in AES-256 Vault (${mode} Mode)`
        );

        addTelemetryLog(
          'ACCOUNT',
          'ORDER',
          `Connected to ${cleanServer} — Balance: $${Number(data.balance ?? 0.0).toFixed(2)}`
        );

        await fetchAccountInfo();
      } else {
        useTradingStore.setState({
          balance: null,
          equity: null,
          dailyPnl: null,
          positions: [],
          openPositions: [],
          accountInfo: {
            ...useTradingStore.getState().accountInfo,
            accountNumber: cleanAccountId,
            server: cleanServer,
            currency: 'USD',
            balance: null,
            equity: null,
            margin: 0,
            freeMargin: null,
            marginLevelPct: 0,
            dailyRealizedPnL: null,
            dailyRealizedLossUsd: 0,
            latencyMs: 0,
            connected: false,
            mode,
            error: data.error || 'Failed to authenticate with Exness gateway.',
          },
        });
        setStatusMessage({
          type: 'error',
          text: data.error || 'Failed to authenticate with Exness gateway.',
        });
      }
    } catch (err: any) {
      setStatusMessage({
        type: 'error',
        text: `Network or Connection Error: ${err?.message || 'Server timeout'}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearVault = async () => {
    if (!confirm('Clear Exness credentials from the AES-256 Vault?')) return;
    try {
      await fetch('/api/exness/vault', { method: 'DELETE' });
      setApiKey('');
      setPrivateKey('');
      await setCredentials({
        demoApiKey: '',
        demoApiSecret: '',
        realApiKey: '',
        realApiSecret: '',
      });
      useTradingStore.setState({
        balance: null,
        equity: null,
        dailyPnl: null,
        positions: [],
        openPositions: [],
        accountInfo: {
          accountNumber: '',
          server: '',
          currency: 'USD',
          balance: null,
          equity: null,
          margin: 0,
          freeMargin: null,
          marginLevelPct: 0,
          dailyRealizedPnL: null,
          dailyRealizedLossUsd: 0,
          latencyMs: 0,
          connected: false,
          mode: 'DEMO',
        },
      });
      setStatusMessage({
        type: 'success',
        text: 'Exness AES-256 Vault credentials cleared.',
      });
      addTelemetryLog('VAULT', 'INFO', '[SECURITY] Exness AES-256 Vault cleared');
      await fetchAccountInfo();
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] text-slate-900 dark:text-slate-100 transition-colors">
        {/* Top Header */}
        <div className="bg-slate-50 dark:bg-zinc-950 px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-[#0F172A] dark:text-slate-100 text-sm tracking-wide">
                  EXNESS EXCHANGE VAULT (ED25519)
                </h3>
                <span className="text-[10px] bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-400 font-mono px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" /> AES-256
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                Configure your personal Exness Forex / Metals trading account credentials
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCloseModal}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSaveAndConnect} className="p-6 overflow-y-auto space-y-4 text-xs font-mono">
          {/* Account Mode Selection */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5 text-xs">TRADING ENVIRONMENT</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('DEMO')}
                className={`py-2.5 px-3 rounded-xl border text-center transition-all flex items-center justify-center gap-2 font-bold cursor-pointer ${
                  mode === 'DEMO'
                    ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 shadow-xs'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Cpu className="w-4 h-4" /> DEMO (TRIAL / PRACTICE)
              </button>
              <button
                type="button"
                onClick={() => setMode('REAL')}
                className={`py-2.5 px-3 rounded-xl border text-center transition-all flex items-center justify-center gap-2 font-bold cursor-pointer ${
                  mode === 'REAL'
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-300 shadow-xs'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <KeyRound className="w-4 h-4" /> REAL (LIVE CAPITAL)
              </button>
            </div>
          </div>

          {/* Account Login Number */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5">EXNESS / MT5 ACCOUNT LOGIN #</label>
            <input
              type="text"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="e.g. 464129221 or 30000143146"
              className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 transition-colors"
              required
            />
          </div>

          {/* Gateway Host */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5 flex items-center justify-between">
              <span>GATEWAY HOST (EXNESS ACCESS POINT)</span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-normal">Default: https://api.exness-api.com</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder="https://api.exness-api.com"
                className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 transition-colors pr-10"
              />
              <Server className="w-4 h-4 text-slate-400 absolute right-3.5 top-3" />
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5 flex items-center justify-between">
              <span>EXNESS API PUBLIC KEY (exnsk-...)</span>
              <span className="text-[10px] text-emerald-700 dark:text-emerald-400 font-semibold">Personal Area &gt; API Management</span>
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="exnsk-..."
                className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 transition-colors pr-10"
                required
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Ed25519 Private Key */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5 flex items-center justify-between">
              <span>ED25519 PRIVATE KEY</span>
              <span className="text-[10px] text-amber-700 dark:text-amber-400 font-semibold">Strict Ed25519 Signature Auth</span>
            </label>
            <div className="relative">
              <textarea
                rows={2}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="128-character Hex, 64-char Hex seed, Base64, or PEM PKCS#8"
                className={`w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 transition-colors pr-10 text-[11px] ${
                  !showPrivateKey && privateKey ? 'tracking-widest' : ''
                }`}
                style={!showPrivateKey && privateKey ? ({ WebkitTextSecurity: 'disc' } as React.CSSProperties) : undefined}
                required
              />
              <button
                type="button"
                onClick={() => setShowPrivateKey(!showPrivateKey)}
                className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                {showPrivateKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Feedback & Status Alert */}
          {statusMessage && (
            <div
              className={`p-3.5 rounded-xl border flex items-start gap-2.5 ${
                statusMessage.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800/80 text-rose-800 dark:text-rose-300'
              }`}
            >
              {statusMessage.type === 'success' ? (
                <Check className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
              )}
              <div className="space-y-1">
                <p className="font-semibold">{statusMessage.text}</p>
                {statusMessage.metrics && (
                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400 flex items-center gap-3">
                    <span>Balance: ${statusMessage.metrics.balance.toFixed(2)}</span>
                    <span>Equity: ${statusMessage.metrics.equity.toFixed(2)}</span>
                    <span>Latency: ~{statusMessage.metrics.latencyMs}ms</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="pt-2 flex items-center justify-between gap-3 border-t border-slate-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={handleClearVault}
              className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:underline px-2 py-1 cursor-pointer"
            >
              Clear Vault
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCloseModal}
                className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-zinc-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-zinc-700 border border-slate-200 dark:border-zinc-700 transition-colors cursor-pointer"
              >
                Close
              </button>
              <button
                type="submit"
                disabled={isLoading}
                className="px-5 py-2 rounded-xl bg-[#0F172A] hover:bg-[#1E293B] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-bold transition-all shadow-xs flex items-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" /> Verifying...
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 text-emerald-400 dark:text-white" /> Save &amp; Connect Exness
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ExnessVaultModal;
