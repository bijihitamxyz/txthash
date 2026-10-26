'use client';

import React, { useState, useEffect } from 'react';
import { useBinanceStore } from '@/store/useBinanceStore';
import { Key, X, Eye, EyeOff, Save, Check, RefreshCw, Zap, AlertCircle } from 'lucide-react';

export const BinanceVaultModal: React.FC = () => {
  const isVaultModalOpen = useBinanceStore((s) => s.isVaultModalOpen);
  const closeVaultModal = useBinanceStore((s) => s.closeVaultModal);
  const apiKey = useBinanceStore((s) => s.apiKey);
  const apiSecret = useBinanceStore((s) => s.apiSecret);
  const isTestnet = useBinanceStore((s) => s.isTestnet);
  const saveCredentials = useBinanceStore((s) => s.saveCredentials);
  const fetchAccountInfo = useBinanceStore((s) => s.fetchAccountInfo);

  const [formKey, setFormKey] = useState(apiKey);
  const [formSecret, setFormSecret] = useState(apiSecret);
  const [formTestnet, setFormTestnet] = useState(isTestnet);
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
  }, [apiKey, apiSecret, isTestnet]);

  if (!isVaultModalOpen) return null;

  const handleTest = async () => {
    if (!formKey.trim() || !formSecret.trim()) {
      setValidationError('Binance API Key dan API Secret wajib diisi sebelum melakukan test.');
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!formKey.trim() || !formSecret.trim()) {
      setValidationError('Binance API Key dan API Secret tidak boleh kosong.');
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[#181A20] border border-[#F3BA2F]/40 rounded-2xl max-w-lg w-full p-4 sm:p-6 shadow-2xl relative text-slate-100 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#F3BA2F]/20 border border-[#F3BA2F]/40 flex items-center justify-center text-[#F3BA2F]">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm sm:text-base text-white flex items-center gap-2">
                <span>Binance Futures API Vault</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#F3BA2F]/20 text-[#F3BA2F] border border-[#F3BA2F]/30">
                  AES-256
                </span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Official Binance USDⓈ-M Futures HMAC-SHA256 API Credentials
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeVaultModal}
            className="text-slate-400 hover:text-white transition-colors cursor-pointer p-1 rounded-lg hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {validationError && (
          <div className="mb-3 p-3 rounded-xl bg-rose-950/60 border border-rose-800 flex items-center gap-2 text-rose-300 text-xs font-mono">
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{validationError}</span>
          </div>
        )}

        {/* Network Selector (Testnet vs Live Real) */}
        <div className="bg-[#0B0E11] p-3 rounded-xl border border-slate-800 mb-3 flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">Target Network:</span>
          <div className="flex gap-2 font-mono text-xs">
            <button
              type="button"
              onClick={() => setFormTestnet(true)}
              className={`px-3 py-1.5 rounded-lg font-bold border transition-all cursor-pointer ${
                formTestnet
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-sm'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              🟡 Binance Demo Testnet
            </button>
            <button
              type="button"
              onClick={() => setFormTestnet(false)}
              className={`px-3 py-1.5 rounded-lg font-bold border transition-all cursor-pointer ${
                !formTestnet
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                  : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              🟢 Binance Live Real
            </button>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="space-y-3.5 text-xs overflow-y-auto flex-1 pr-1 font-mono">
          <div>
            <label className="text-slate-300 font-semibold block mb-1">
              Binance API Key
            </label>
            <input
              type="text"
              value={formKey}
              onChange={(e) => setFormKey(e.target.value)}
              placeholder="Paste your Binance USDⓈ-M API Key"
              className="w-full bg-[#0B0E11] border border-slate-700 rounded-lg px-3 py-2 text-slate-100 placeholder:text-slate-600 focus:border-[#F3BA2F] focus:outline-none"
            />
          </div>

          <div>
            <label className="text-slate-300 font-semibold block mb-1">
              Binance API Secret (HMAC-SHA256)
            </label>
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={formSecret}
                onChange={(e) => setFormSecret(e.target.value)}
                placeholder="Paste your Binance API Secret"
                className="w-full bg-[#0B0E11] border border-slate-700 rounded-lg px-3 py-2 pr-10 text-slate-100 placeholder:text-slate-600 focus:border-[#F3BA2F] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-3 top-2.5 text-slate-500 hover:text-slate-300 cursor-pointer"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[10px] text-slate-500 mt-1 font-sans">
              Credentials are encrypted using AES-256-GCM in your device browser storage. Never exposed to public endpoints.
            </p>
          </div>

          {/* Test Status Feedback */}
          {testStatus && (
            <div
              className={`p-3 rounded-xl border flex flex-col gap-1 text-[11px] ${
                testStatus.success
                  ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200'
                  : 'bg-rose-950/70 border-rose-500 text-rose-200'
              }`}
            >
              <div className="flex items-center justify-between font-bold">
                <span className="flex items-center gap-1.5">
                  {testStatus.success ? <Check className="w-4 h-4 text-emerald-400" /> : <X className="w-4 h-4 text-rose-400" />}
                  <span>{testStatus.message}</span>
                </span>
                {typeof testStatus.latencyMs === 'number' && (
                  <span className="text-[10px] opacity-80">{testStatus.latencyMs}ms</span>
                )}
              </div>
              {testStatus.success && typeof testStatus.balance === 'number' && (
                <div className="text-[10px] text-emerald-300 pt-1 border-t border-emerald-800/40 flex items-center justify-between">
                  <span>Wallet Balance: ${testStatus.balance.toFixed(2)} USDT</span>
                  <span>Available: ${testStatus.availableBalance?.toFixed(2)} USDT</span>
                </div>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-3 border-t border-slate-800">
            <button
              type="button"
              disabled={isTesting}
              onClick={handleTest}
              className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold flex items-center gap-1.5 text-xs cursor-pointer border border-slate-700 disabled:opacity-50 transition-colors"
            >
              {isTesting ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#F3BA2F]" />
              ) : (
                <Zap className="w-3.5 h-3.5 text-[#F3BA2F]" />
              )}
              <span>{isTesting ? 'Validating...' : 'Test Binance API'}</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeVaultModal}
                className="px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[#F3BA2F] hover:bg-[#F3BA2F]/90 text-slate-950 font-bold flex items-center gap-1.5 shadow-lg shadow-[#F3BA2F]/20 text-xs cursor-pointer"
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

export default BinanceVaultModal;
