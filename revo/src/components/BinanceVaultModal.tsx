'use client';

import React, { useState, useEffect } from 'react';
import { useBinanceStore } from '@/store/useBinanceStore';
import {
  Key,
  X,
  Eye,
  EyeOff,
  Save,
  Check,
  RefreshCw,
  Zap,
  AlertCircle,
  Lock,
  Cpu,
  KeyRound,
} from 'lucide-react';

export const BinanceVaultModal: React.FC = () => {
  const isVaultModalOpen = useBinanceStore((s) => s.isVaultModalOpen);
  const closeVaultModal = useBinanceStore((s) => s.closeVaultModal);
  const apiKey = useBinanceStore((s) => s.apiKey);
  const apiSecret = useBinanceStore((s) => s.apiSecret);
  const isTestnet = useBinanceStore((s) => s.isTestnet);
  const saveCredentials = useBinanceStore((s) => s.saveCredentials);
  const clearCredentials = useBinanceStore((s) => s.clearCredentials);
  const fetchAccountInfo = useBinanceStore((s) => s.fetchAccountInfo);

  const [formKey, setFormKey] = useState(apiKey);
  const [formSecret, setFormSecret] = useState(apiSecret);
  const [formTestnet, setFormTestnet] = useState(isTestnet);
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [isSavedAlert, setIsSavedAlert] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    success: boolean;
    message: string;
    balance?: number;
    availableBalance?: number;
    latencyMs?: number;
  } | null>(null);

  useEffect(() => {
    setFormKey(apiKey);
    setFormSecret(apiSecret);
    setFormTestnet(isTestnet);
    setValidationError(null);
    setTestStatus(null);
  }, [apiKey, apiSecret, isTestnet, isVaultModalOpen]);

  if (!isVaultModalOpen) return null;

  const handleTest = async () => {
    if (!formKey.trim() || !formSecret.trim()) {
      setValidationError('Binance API Key and API Secret are required before testing.');
      return;
    }

    setIsTesting(true);
    setTestStatus(null);
    setValidationError(null);

    try {
      const res = await fetch('/api/binance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'TEST_CONNECTION',
          credentials: {
            apiKey: formKey.trim(),
            apiSecret: formSecret.trim(),
            isTestnet: formTestnet,
          },
        }),
      });
      const data = await res.json();
      setTestStatus(data);
    } catch (err: any) {
      setTestStatus({
        success: false,
        message: `Network error: ${err.message || 'Connection failed'}`,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleClear = async () => {
    if (!confirm('Clear Binance API credentials from your AES-256 Vault?')) return;
    await clearCredentials();
    setFormKey('');
    setFormSecret('');
    setTestStatus({
      success: true,
      message: 'Binance API credentials cleared from AES-256 Vault.',
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!formKey.trim() || !formSecret.trim()) {
      setValidationError('Binance API Key and API Secret cannot be empty.');
      return;
    }

    await saveCredentials(formKey.trim(), formSecret.trim(), formTestnet);
    setIsSavedAlert(true);
    await fetchAccountInfo();
    setTimeout(() => {
      setIsSavedAlert(false);
      closeVaultModal();
    }, 700);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl max-w-xl w-full shadow-2xl relative text-slate-900 dark:text-slate-100 flex flex-col max-h-[92vh] overflow-hidden transition-colors">
        {/* Header */}
        <div className="bg-slate-50 dark:bg-zinc-950 px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800/60 text-emerald-700 dark:text-emerald-400">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-[#0F172A] dark:text-slate-100 text-sm tracking-wide">
                  BINANCE USDⓈ-M FUTURES API VAULT
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" /> AES-256
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                Configure your personal Binance USDⓈ-M Futures HMAC-SHA256 exchange credentials
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeVaultModal}
            className="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4 text-xs overflow-y-auto flex-1 font-mono">
          {validationError && (
            <div className="p-3.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/80 flex items-center gap-2 text-rose-800 dark:text-rose-300 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{validationError}</span>
            </div>
          )}

          {/* Network Selector (Testnet vs Live Real) */}
          <div>
            <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1.5">TARGET NETWORK</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setFormTestnet(true)}
                className={`py-2.5 px-3 rounded-xl font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  formTestnet
                    ? 'bg-amber-50 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700 shadow-xs'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Cpu className="w-4 h-4" /> DEMO TESTNET
              </button>
              <button
                type="button"
                onClick={() => setFormTestnet(false)}
                className={`py-2.5 px-3 rounded-xl font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  !formTestnet
                    ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 shadow-xs'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <KeyRound className="w-4 h-4" /> LIVE REAL (MAINNET)
              </button>
            </div>
          </div>

          <div>
            <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
              BINANCE API KEY
            </label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={formKey}
                onChange={(e) => setFormKey(e.target.value)}
                placeholder="Paste your Binance USDⓈ-M API Key"
                className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 pr-10 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
              BINANCE API SECRET (HMAC-SHA256)
            </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={formSecret}
                onChange={(e) => setFormSecret(e.target.value)}
                placeholder="Paste your Binance API Secret"
                className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 pr-10 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-[#0F172A] dark:focus:border-emerald-500 focus:outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 font-sans">
              Encrypted locally using AES-256-GCM. Ensure Futures Trading permission is enabled (withdrawals disabled).
            </p>
          </div>

          {/* Test Status Feedback */}
          {testStatus && (
            <div
              className={`p-3.5 rounded-xl border flex flex-col gap-1 text-xs ${
                testStatus.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-800/80 text-rose-800 dark:text-rose-300'
              }`}
            >
              <div className="flex items-center justify-between font-bold">
                <span className="flex items-center gap-1.5">
                  {testStatus.success ? (
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                  )}
                  <span>{testStatus.message}</span>
                </span>
                {typeof testStatus.latencyMs === 'number' && (
                  <span className="text-[10px] opacity-80">{testStatus.latencyMs}ms</span>
                )}
              </div>
              {testStatus.success && typeof testStatus.balance === 'number' && (
                <div className="text-[10px] text-emerald-700 dark:text-emerald-400 pt-1 border-t border-emerald-200/80 dark:border-emerald-800/60 flex items-center justify-between">
                  <span>Wallet Balance: ${testStatus.balance.toFixed(2)} USDT</span>
                  <span>Available: ${testStatus.availableBalance?.toFixed(2)} USDT</span>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-200 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={isTesting}
                onClick={handleTest}
                className="px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-[#0F172A] dark:text-slate-100 font-semibold flex items-center gap-1.5 text-xs cursor-pointer border border-slate-200 dark:border-zinc-700 disabled:opacity-50 transition-colors"
              >
                {isTesting ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Zap className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                )}
                <span>{isTesting ? 'Testing...' : 'Test API'}</span>
              </button>
              <button
                type="button"
                onClick={handleClear}
                className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:underline px-2 py-1 cursor-pointer"
              >
                Clear Vault
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeVaultModal}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-zinc-700 text-xs font-semibold cursor-pointer transition-colors"
              >
                Close
              </button>
              <button
                type="submit"
                className="px-5 py-2 rounded-xl bg-[#0F172A] hover:bg-[#1E293B] dark:bg-emerald-600 dark:hover:bg-emerald-500 text-white font-bold flex items-center gap-2 shadow-xs text-xs cursor-pointer transition-colors"
              >
                {isSavedAlert ? (
                  <Check className="w-4 h-4 text-emerald-400 dark:text-white" />
                ) : (
                  <Save className="w-4 h-4 text-emerald-400 dark:text-white" />
                )}
                <span>{isSavedAlert ? 'Saved to Vault' : 'Save & Connect Binance'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export default BinanceVaultModal;
