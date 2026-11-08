'use client';

import React, { useState, useEffect } from 'react';
import { useTradingStore } from '@/store/useTradingStore';
import { Key, ShieldCheck, X, Eye, EyeOff, Save, Server, Check, RotateCcw, AlertCircle } from 'lucide-react';
import { StoredCredentials, AccountMode } from '@/lib/cryptoVault';

export const VaultModal: React.FC = () => {
  const isApiKeyModalOpen = useTradingStore((s) => s.isApiKeyModalOpen);
  const closeApiKeyModal = useTradingStore((s) => s.closeApiKeyModal);
  const credentials = useTradingStore((s) => s.credentials);
  const setCredentials = useTradingStore((s) => s.setCredentials);
  const resetDemoAccount = useTradingStore((s) => s.resetDemoAccount);

  const [form, setForm] = useState<StoredCredentials>({
    ...credentials,
    demoAccountId: credentials.demoAccountId || '30000143146',
    realAccountId: credentials.realAccountId || '30000143146',
    demoServer: credentials.demoServer || 'Exness-Trial',
    realServer: credentials.realServer || 'Exness-Real',
  });
  const [showDemoToken, setShowDemoToken] = useState(false);
  const [showRealToken, setShowRealToken] = useState(false);
  const [showDemoSecret, setShowDemoSecret] = useState(false);
  const [showRealSecret, setShowRealSecret] = useState(false);
  const [isSavedAlert, setIsSavedAlert] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Exness Demo & Real separate test states
  const [isTestingDemo, setIsTestingDemo] = useState(false);
  const [demoTestStatus, setDemoTestStatus] = useState<{
    success: boolean;
    message: string;
    balance?: number;
    equity?: number;
    accountNumber?: string;
    server?: string;
    latencyMs?: number;
  } | null>(null);

  const [isTestingReal, setIsTestingReal] = useState(false);
  const [realTestStatus, setRealTestStatus] = useState<{
    success: boolean;
    message: string;
    balance?: number;
    equity?: number;
    accountNumber?: string;
    server?: string;
    latencyMs?: number;
  } | null>(null);

  useEffect(() => {
    setForm({
      ...credentials,
      demoAccountId: credentials.demoAccountId || '30000143146',
      realAccountId: credentials.realAccountId || '30000143146',
      demoServer: credentials.demoServer || 'Exness-Trial',
      realServer: credentials.realServer || 'Exness-Real',
    });
    setValidationError(null);
  }, [credentials]);

  if (!isApiKeyModalOpen) return null;

  const handleTestExnessAccount = async (targetMode: 'DEMO' | 'REAL') => {
    const isReal = targetMode === 'REAL';
    const setTesting = isReal ? setIsTestingReal : setIsTestingDemo;
    const setStatus = isReal ? setRealTestStatus : setDemoTestStatus;

    setTesting(true);
    setStatus(null);
    setValidationError(null);

    const accountId = (isReal ? form.realAccountId : form.demoAccountId)?.trim() || '30000143146';
    const server = (isReal ? form.realServer : form.demoServer)?.trim() || (isReal ? 'Exness-Real' : 'Exness-Trial');
    const apiKey = (isReal ? form.realApiKey : form.demoApiKey)?.trim();
    const secret = (isReal ? form.realApiSecret : form.demoApiSecret)?.trim();
    const initialBalance = isReal ? form.realInitialBalance : form.demoInitialBalance;

    // STRICT VALIDATION: Reject empty passwords / keys
    if (!apiKey) {
      setTesting(false);
      setStatus({
        success: false,
        message: 'Validation Error: Exness API Key is required. Please paste your API key from my.theexness.com.',
      });
      return;
    }

    try {
      const res = await fetch('/api/exness', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          action: 'GET_ACCOUNT',
          credentials: {
            accountId,
            server,
            apiKey,
            token: apiKey,
            password: apiKey,
            secret,
            initialBalance: typeof initialBalance === 'number' && initialBalance > 0 ? initialBalance : undefined,
          },
        }),
      });

      const json = await res.json();
      if ((json.ok || json.success) && json.data && json.data.connected) {
        setStatus({
          success: true,
          message: `✅ Exness API Key Verified — Account #${json.data.accountNumber || accountId} connected`,
          balance: json.data.balance,
          equity: json.data.equity,
          accountNumber: json.data.accountNumber || accountId,
          server: json.data.server || server,
          latencyMs: json.data.latencyMs,
        });
      } else {
        setStatus({
          success: false,
          message: json.error || json.message || 'Exness API Key authentication failed: Invalid API Key or account inaccessible',
        });
      }
    } catch (err: any) {
      setStatus({
        success: false,
        message: `Network error: ${err.message || 'Unable to contact Exness proxy gateway'}`,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleTestDemo = () => handleTestExnessAccount('DEMO');
  const handleTestReal = () => handleTestExnessAccount('REAL');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    // Strict validation: active account mode must have API key
    const activeKey = form.accountMode === 'REAL' ? form.realApiKey?.trim() : form.demoApiKey?.trim();
    if (!activeKey) {
      setValidationError(`Exness API Key untuk mode ${form.accountMode === 'REAL' ? 'Real' : 'Demo'} wajib diisi.`);
      return;
    }

    await setCredentials(form);
    setIsSavedAlert(true);
    setTimeout(() => {
      setIsSavedAlert(false);
      closeApiKeyModal();
    }, 700);
  };

  const renderExnessStatusBadge = (status: {
    success: boolean;
    message: string;
    balance?: number;
    equity?: number;
    accountNumber?: string;
    server?: string;
    latencyMs?: number;
  } | null) => {
    if (!status) return null;
    return (
      <div
        className={`p-3 rounded-xl border flex flex-col gap-1 text-[11px] animate-in fade-in duration-200 ${
          status.success
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800 shadow-xs'
            : 'bg-rose-50 border-rose-200 text-rose-800 shadow-xs'
        }`}
      >
        <div className="flex items-center justify-between font-bold">
          <span className="flex items-center gap-1.5">
            {status.success ? (
              <Check className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <X className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span>{status.message}</span>
          </span>
          {typeof status.latencyMs === 'number' && (
            <span className="text-[10px] font-mono opacity-80">{status.latencyMs}ms</span>
          )}
        </div>
        {status.success && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono text-emerald-700 pt-1.5 border-t border-emerald-200">
            <span>Server: {status.server}</span>
            <span>Account: #{status.accountNumber}</span>
            <span>Live Balance: ${status.balance?.toFixed(2)}</span>
            <span>Live Equity: ${status.equity?.toFixed(2)}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-xl w-full p-4 sm:p-6 shadow-2xl animate-in fade-in zoom-in duration-150 max-h-[90vh] flex flex-col font-sans">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 pb-3 mb-4">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-base">
            <Key className="w-5 h-5 text-amber-500" />
            <span>Exness Credential Vault</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-200">
              AES-256-GCM
            </span>
          </div>
          <button
            type="button"
            onClick={closeApiKeyModal}
            className="text-slate-400 hover:text-slate-700 transition-colors cursor-pointer p-1 rounded-lg hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {validationError && (
          <div className="mb-3 p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-center gap-2 text-rose-700 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
            <span>{validationError}</span>
          </div>
        )}

        <form onSubmit={handleSave} className="space-y-4 text-xs overflow-y-auto flex-1 pr-1">
          {/* Account Mode Switcher */}
          <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 flex items-center justify-between">
            <span className="text-slate-700 font-semibold">Active Account Mode:</span>
            <div className="flex gap-2 font-mono">
              {(['DEMO', 'REAL'] as AccountMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setForm({ ...form, accountMode: mode })}
                  className={`px-3 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${
                    form.accountMode === mode
                      ? mode === 'REAL'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                        : 'bg-amber-50 text-amber-700 border-amber-300'
                      : 'bg-white border-slate-200 text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {mode === 'DEMO' ? 'Exness Demo (Trial)' : 'Exness Real (Live)'}
                </button>
              ))}
            </div>
          </div>

          {/* 1. EXNESS DEMO ACCOUNT */}
          <div className="bg-slate-50/50 p-3.5 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-amber-700 font-bold uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                Exness Demo Account (Trial)
              </span>
              <span className="text-[10px] text-amber-600 font-mono">Full Access API Key</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-slate-500 block mb-1">Account Number</label>
                <input
                  type="text"
                  placeholder="30000143146"
                  value={form.demoAccountId}
                  onChange={(e) => setForm({ ...form, demoAccountId: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:border-amber-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-slate-500 block mb-1">Server Type</label>
                <input
                  type="text"
                  placeholder="Exness-Trial"
                  value={form.demoServer}
                  onChange={(e) => setForm({ ...form, demoServer: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:border-amber-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-slate-500 block mb-1">Exness API Key (Full Access Token)</label>
              <div className="relative">
                <input
                  type={showDemoToken ? 'text' : 'password'}
                  placeholder="Paste Exness API Key (Full access)"
                  value={form.demoApiKey}
                  onChange={(e) => setForm({ ...form, demoApiKey: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 pr-10 text-slate-900 font-mono focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowDemoToken(!showDemoToken)}
                  className="absolute right-3 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showDemoToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="text-slate-500 block mb-1">API Secret / Passphrase (Optional)</label>
              <div className="relative">
                <input
                  type={showDemoSecret ? 'text' : 'password'}
                  placeholder="Optional API Secret if provided"
                  value={form.demoApiSecret || ''}
                  onChange={(e) => setForm({ ...form, demoApiSecret: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 pr-10 text-slate-900 font-mono focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowDemoSecret(!showDemoSecret)}
                  className="absolute right-3 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showDemoSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Live Exness Balance Notice */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-xs text-amber-800 flex items-center gap-2">
              <span className="text-sm">⚡</span>
              <span>Balance, Equity, dan Trade disinkronkan secara murni langsung dari akun Exness via REST API.</span>
            </div>

            {/* Test Demo Button & Sync */}
            <div className="pt-2 flex flex-col gap-2 border-t border-slate-100">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isTestingDemo}
                  onClick={handleTestDemo}
                  className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-bold flex items-center justify-center gap-1.5 text-xs cursor-pointer border border-amber-500 disabled:opacity-50 transition-colors shadow-xs"
                >
                  {isTestingDemo ? (
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  ) : (
                    <span>🧪</span>
                  )}
                  <span>{isTestingDemo ? 'Testing API...' : 'Test Exness Demo'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    resetDemoAccount();
                  }}
                  className="w-full py-2 px-3 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold flex items-center justify-center gap-1.5 text-xs cursor-pointer border border-amber-200 transition-colors"
                  title="Sinkronisasi ulang saldo & posisi dari akun Exness"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Sync Exness</span>
                </button>
              </div>

              {renderExnessStatusBadge(demoTestStatus)}
            </div>
          </div>

          {/* 2. EXNESS REAL ACCOUNT */}
          <div className="bg-slate-50/50 p-3.5 rounded-xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-emerald-700 font-bold uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                Exness Real Account (Live)
              </span>
              <span className="text-[10px] text-emerald-600 font-mono">Full Access API Key</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-slate-500 block mb-1">Account Number</label>
                <input
                  type="text"
                  placeholder="30000143146"
                  value={form.realAccountId}
                  onChange={(e) => setForm({ ...form, realAccountId: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-slate-500 block mb-1">Server Type</label>
                <input
                  type="text"
                  placeholder="Exness-Real"
                  value={form.realServer}
                  onChange={(e) => setForm({ ...form, realServer: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-slate-900 font-mono focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="text-slate-500 block mb-1">Exness API Key (Full Access Token)</label>
              <div className="relative">
                <input
                  type={showRealToken ? 'text' : 'password'}
                  placeholder="Paste Exness API Key (Full access)"
                  value={form.realApiKey}
                  onChange={(e) => setForm({ ...form, realApiKey: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 pr-10 text-slate-900 font-mono focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowRealToken(!showRealToken)}
                  className="absolute right-3 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showRealToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="text-slate-500 block mb-1">API Secret / Passphrase (Optional)</label>
              <div className="relative">
                <input
                  type={showRealSecret ? 'text' : 'password'}
                  placeholder="Optional API Secret if provided"
                  value={form.realApiSecret || ''}
                  onChange={(e) => setForm({ ...form, realApiSecret: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-1.5 pr-10 text-slate-900 font-mono focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowRealSecret(!showRealSecret)}
                  className="absolute right-3 top-2 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  {showRealSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Live Exness Balance Notice */}
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 text-xs text-emerald-800 flex items-center gap-2">
              <span className="text-sm">⚡</span>
              <span>Balance, Equity, dan Trade disinkronkan secara murni langsung dari akun Exness Real via REST API.</span>
            </div>

            {/* Test Real Button */}
            <div className="pt-2 flex flex-col gap-2 border-t border-slate-100">
              <button
                type="button"
                disabled={isTestingReal}
                onClick={handleTestReal}
                className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold flex items-center justify-center gap-1.5 text-xs cursor-pointer border border-emerald-500 disabled:opacity-50 transition-colors shadow-xs"
              >
                {isTestingReal ? (
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                ) : (
                  <span>🧪</span>
                )}
                <span>{isTestingReal ? 'Testing Real API...' : 'Test Exness Real'}</span>
              </button>

              {renderExnessStatusBadge(realTestStatus)}
            </div>
          </div>

          {/* Bottom Bar: Zero duplicate buttons */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-200">
            <div className="flex items-center gap-1.5 text-emerald-600 text-[11px] font-medium">
              <ShieldCheck className="w-4 h-4" />
              <span>AES-256-GCM Encrypted Locally</span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeApiKeyModal}
                className="px-3.5 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold cursor-pointer border border-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold flex items-center gap-1.5 shadow-sm text-xs cursor-pointer"
              >
                {isSavedAlert ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
                <span>{isSavedAlert ? 'Saved to Vault!' : 'Save & Encrypt'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export const ApiKeyModal = VaultModal;
export default VaultModal;
