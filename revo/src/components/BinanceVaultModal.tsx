'use client';

import React, { useState, useEffect } from 'react';
import { useBinanceStore } from '@/store/useBinanceStore';
import {
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
  ShieldCheck,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { CryptoExchange, CryptoAccountType } from '@/lib/cryptoVault';

export const BinanceVaultModal: React.FC = () => {
  const isVaultModalOpen = useBinanceStore((s) => s.isVaultModalOpen);
  const closeVaultModal = useBinanceStore((s) => s.closeVaultModal);

  const activeExchange = useBinanceStore((s) => s.activeExchange || 'BINANCE');
  const binanceConfig = useBinanceStore((s) => s.binanceConfig);
  const bitgetConfig = useBinanceStore((s) => s.bitgetConfig);
  const saveCryptoCredentials = useBinanceStore((s) => s.saveCryptoCredentials);
  const clearCredentials = useBinanceStore((s) => s.clearCredentials);
  const fetchAccountInfo = useBinanceStore((s) => s.fetchAccountInfo);
  const fetchSymbolsAndTickers = useBinanceStore((s) => s.fetchSymbolsAndTickers);

  // Active exchange selection inside the modal
  const [selectedExchange, setSelectedExchange] = useState<CryptoExchange>(activeExchange);

  // Form states for Binance
  const [binanceKey, setBinanceKey] = useState(binanceConfig?.apiKey || '');
  const [binanceSecret, setBinanceSecret] = useState(binanceConfig?.secretKey || '');
  const [binanceAccountType, setBinanceAccountType] = useState<CryptoAccountType>(binanceConfig?.accountType || 'DEMO');

  // Form states for Bitget (Real Bitget V2 REST API — Live or Official Demo Trading via API Key)
  const [bitgetKey, setBitgetKey] = useState(bitgetConfig?.apiKey || '');
  const [bitgetSecret, setBitgetSecret] = useState(bitgetConfig?.secretKey || '');
  const [bitgetPassphrase, setBitgetPassphrase] = useState(bitgetConfig?.passphrase || '');
  const [bitgetAccountType, setBitgetAccountType] = useState<CryptoAccountType>(bitgetConfig?.accountType || 'REAL');

  // Visibility toggles
  const [showBinanceSecret, setShowBinanceSecret] = useState(false);
  const [showBitgetSecret, setShowBitgetSecret] = useState(false);
  const [showBitgetPassphrase, setShowBitgetPassphrase] = useState(false);

  // Action status
  const [isSavedAlert, setIsSavedAlert] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<{
    success: boolean;
    exchange?: string;
    message: string;
    balance?: number;
    availableBalance?: number;
    latencyMs?: number;
  } | null>(null);

  // Synchronize initial state when modal opens
  useEffect(() => {
    setSelectedExchange(activeExchange);
    setBinanceKey(binanceConfig?.apiKey || '');
    setBinanceSecret(binanceConfig?.secretKey || '');
    setBinanceAccountType(binanceConfig?.accountType || 'DEMO');

    setBitgetKey(bitgetConfig?.apiKey || '');
    setBitgetSecret(bitgetConfig?.secretKey || '');
    setBitgetPassphrase(bitgetConfig?.passphrase || '');
    setBitgetAccountType(bitgetConfig?.accountType || 'REAL');

    setValidationError(null);
    setTestStatus(null);
  }, [activeExchange, binanceConfig, bitgetConfig, isVaultModalOpen]);

  if (!isVaultModalOpen) return null;

  const isBinanceConfigured = Boolean(binanceConfig?.apiKey && binanceConfig?.secretKey);
  const isBitgetConfigured = Boolean(bitgetConfig?.apiKey && bitgetConfig?.secretKey && bitgetConfig?.passphrase);

  const currentAccountType: CryptoAccountType = selectedExchange === 'BINANCE' ? binanceAccountType : bitgetAccountType;
  const setAccountType = (type: CryptoAccountType) => {
    if (selectedExchange === 'BINANCE') {
      setBinanceAccountType(type);
    } else {
      setBitgetAccountType(type);
    }
    setTestStatus(null);
  };

  const handleTest = async () => {
    setValidationError(null);
    setTestStatus(null);

    if (selectedExchange === 'BINANCE') {
      if (!binanceKey.trim() || !binanceSecret.trim()) {
        setValidationError('Binance API Key and Secret Key are required before testing.');
        return;
      }
    } else {
      if (!bitgetKey.trim() || !bitgetSecret.trim() || !bitgetPassphrase.trim()) {
        setValidationError('Bitget API Key, Secret Key, and API Passphrase are all required before testing.');
        return;
      }
    }

    setIsTesting(true);

    try {
      const payload = selectedExchange === 'BINANCE'
        ? {
            action: 'TEST_CONNECTION',
            exchange: 'BINANCE',
            credentials: {
              apiKey: binanceKey.trim(),
              secretKey: binanceSecret.trim(),
              apiSecret: binanceSecret.trim(),
              accountType: binanceAccountType,
              isTestnet: binanceAccountType === 'DEMO',
            },
          }
        : {
            action: 'TEST_CONNECTION',
            exchange: 'BITGET',
            credentials: {
              apiKey: bitgetKey.trim(),
              secretKey: bitgetSecret.trim(),
              passphrase: bitgetPassphrase.trim(),
              accountType: bitgetAccountType,
              isTestnet: bitgetAccountType === 'DEMO',
            },
          };

      const res = await fetch('/api/binance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      setTestStatus(data);
    } catch (err: any) {
      setTestStatus({
        success: false,
        exchange: selectedExchange,
        message: `Network error: ${err.message || 'Connection failed'}`,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleClear = async () => {
    if (!confirm(`Clear ${selectedExchange} credentials from your AES-256 Vault?`)) return;

    await clearCredentials(selectedExchange);
    if (selectedExchange === 'BINANCE') {
      setBinanceKey('');
      setBinanceSecret('');
    } else {
      setBitgetKey('');
      setBitgetSecret('');
      setBitgetPassphrase('');
    }

    setTestStatus({
      success: true,
      exchange: selectedExchange,
      message: `${selectedExchange} API credentials cleared from AES-256 Vault.`,
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (selectedExchange === 'BINANCE') {
      if (!binanceKey.trim() || !binanceSecret.trim()) {
        setValidationError('Binance API Key and Secret Key cannot be empty.');
        return;
      }

      await saveCryptoCredentials(
        'BINANCE',
        {
          apiKey: binanceKey.trim(),
          secretKey: binanceSecret.trim(),
          accountType: binanceAccountType,
        },
        true
      );
    } else {
      if (!bitgetKey.trim() || !bitgetSecret.trim() || !bitgetPassphrase.trim()) {
        setValidationError('Bitget API Key, Secret Key, and Passphrase are all required.');
        return;
      }

      await saveCryptoCredentials(
        'BITGET',
        {
          apiKey: bitgetKey.trim(),
          secretKey: bitgetSecret.trim(),
          passphrase: bitgetPassphrase.trim(),
          accountType: bitgetAccountType,
        },
        true
      );
    }

    setIsSavedAlert(true);
    await fetchAccountInfo();
    await fetchSymbolsAndTickers();

    setTimeout(() => {
      setIsSavedAlert(false);
      closeVaultModal();
    }, 700);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-3xl max-w-xl w-full shadow-2xl relative text-slate-900 dark:text-slate-100 flex flex-col max-h-[94vh] overflow-hidden transition-colors font-sans">
        {/* Header */}
        <div className="bg-slate-50/80 dark:bg-zinc-950/80 px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between backdrop-blur-md">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200 dark:border-indigo-800/60 text-indigo-700 dark:text-indigo-400">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-extrabold text-[#0F172A] dark:text-slate-100 text-sm tracking-wide">
                  CRYPTO EXCHANGE API VAULT
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-1 font-semibold">
                  <Lock className="w-2.5 h-2.5" /> AES-256
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                Multi-exchange credentials for Binance &amp; Bitget Perpetual Futures
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeVaultModal}
            className="p-2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-xl hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-5 sm:p-6 space-y-5 text-xs overflow-y-auto flex-1 font-mono">
          {validationError && (
            <div className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/80 flex items-center gap-2 text-rose-800 dark:text-rose-300 text-xs animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 dark:text-rose-400" />
              <span>{validationError}</span>
            </div>
          )}

          {/* 1. TOP EXCHANGE LOGO SELECTOR (2 Interactive Brand Cards) */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                1. SELECT EXCHANGE
              </label>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500">
                Active: <strong className="text-[#0F172A] dark:text-slate-200">{selectedExchange}</strong>
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Binance Futures Card */}
              <div
                onClick={() => {
                  setSelectedExchange('BINANCE');
                  setValidationError(null);
                  setTestStatus(null);
                }}
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer relative flex flex-col justify-between ${
                  selectedExchange === 'BINANCE'
                    ? 'border-amber-400 bg-amber-500/10 dark:bg-amber-950/40 shadow-sm ring-2 ring-amber-400/20'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:bg-slate-50 dark:hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-start justify-between">
                  {/* Crisp Binance Diamond SVG Logo (Yellow/Gold) */}
                  <div className="w-9 h-9 rounded-xl bg-[#F0B90B]/15 border border-[#F0B90B]/30 flex items-center justify-center p-1.5 shrink-0">
                    <svg viewBox="0 0 126 126" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M63 0L86.4 23.4L44.8 65L21.4 41.6L63 0Z" fill="#F0B90B" />
                      <path d="M105.2 42.2L126 63L105.2 83.8L84.4 63L105.2 42.2Z" fill="#F0B90B" />
                      <path d="M63 84.8L86.4 108.2L63 126L39.6 102.6L63 84.8Z" fill="#F0B90B" />
                      <path d="M20.8 83.8L0 63L20.8 42.2L41.6 63L20.8 83.8Z" fill="#F0B90B" />
                      <path d="M63 42.2L83.8 63L63 83.8L42.2 63L63 42.2Z" fill="#F0B90B" />
                    </svg>
                  </div>

                  {/* Status Badge */}
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border font-bold flex items-center gap-1 ${
                      isBinanceConfigured
                        ? activeExchange === 'BINANCE'
                          ? 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700'
                          : 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isBinanceConfigured
                          ? activeExchange === 'BINANCE'
                            ? 'bg-amber-500 animate-pulse'
                            : 'bg-emerald-500'
                          : 'bg-slate-400'
                      }`}
                    />
                    {isBinanceConfigured
                      ? activeExchange === 'BINANCE'
                        ? 'ACTIVE'
                        : 'BOUND'
                      : 'STANDBY'}
                  </span>
                </div>

                <div className="mt-3">
                  <div className="font-bold text-[#0F172A] dark:text-slate-100 text-sm flex items-center gap-1.5">
                    <span>Binance</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono">
                      FUTURES
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                    USDⓈ-M Perpetual API
                  </div>
                </div>
              </div>

              {/* Bitget Futures Card */}
              <div
                onClick={() => {
                  setSelectedExchange('BITGET');
                  setValidationError(null);
                  setTestStatus(null);
                }}
                className={`p-4 rounded-2xl border-2 transition-all cursor-pointer relative flex flex-col justify-between ${
                  selectedExchange === 'BITGET'
                    ? 'border-cyan-400 bg-cyan-500/10 dark:bg-cyan-950/40 shadow-sm ring-2 ring-cyan-400/20'
                    : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 hover:bg-slate-50 dark:hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-start justify-between">
                  {/* Crisp Bitget Arrow/Chevron SVG Logo (Cyan/Teal) */}
                  <div className="w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center p-1.5 shrink-0">
                    <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M18 20L50 50L18 80H36L68 50L36 20H18Z" fill="#00F0FF" />
                      <path d="M46 20L78 50L46 80H64L96 50L64 20H46Z" fill="#00A3BF" />
                    </svg>
                  </div>

                  {/* Status Badge */}
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full border font-bold flex items-center gap-1 ${
                      isBitgetConfigured
                        ? activeExchange === 'BITGET'
                          ? 'bg-cyan-100 dark:bg-cyan-950 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-700'
                          : 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700'
                        : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-zinc-700'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        isBitgetConfigured
                          ? activeExchange === 'BITGET'
                            ? 'bg-cyan-500 animate-pulse'
                            : 'bg-emerald-500'
                          : 'bg-slate-400'
                      }`}
                    />
                    {isBitgetConfigured
                      ? activeExchange === 'BITGET'
                        ? 'ACTIVE'
                        : 'BOUND'
                      : 'STANDBY'}
                  </span>
                </div>

                <div className="mt-3">
                  <div className="font-bold text-[#0F172A] dark:text-slate-100 text-sm flex items-center gap-1.5">
                    <span>Bitget</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 font-mono">
                      V2 API
                    </span>
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 font-mono mt-0.5">
                    USDT-M Futures + Passphrase
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 2. ACCOUNT TYPE SELECTOR */}
          <div className="pt-1">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                2. ACCOUNT MODE ({selectedExchange})
              </label>
              <span className="text-[10px] text-slate-400 dark:text-zinc-500">
                Target:{' '}
                {selectedExchange === 'BITGET'
                  ? currentAccountType === 'REAL'
                    ? 'Bitget Live V2'
                    : 'Bitget Demo V2 (API Key · paptrading: 1)'
                  : currentAccountType === 'REAL'
                  ? 'Live Production'
                  : 'Binance Testnet'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAccountType('DEMO')}
                className={`py-2.5 px-3 rounded-2xl font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  currentAccountType === 'DEMO'
                    ? 'bg-amber-500/15 dark:bg-amber-950/70 text-amber-800 dark:text-amber-300 border-amber-300 dark:border-amber-700 shadow-xs ring-1 ring-amber-400/30'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <Cpu className="w-4 h-4 text-amber-500" />
                <div className="text-left">
                  <div className="text-xs">
                    {selectedExchange === 'BITGET' ? 'DEMO V2 (API KEY)' : 'TESTNET'}
                  </div>
                  <div className="text-[9px] opacity-75 font-normal">
                    {selectedExchange === 'BITGET'
                      ? 'Bitget Demo API (paptrading: 1)'
                      : 'Binance Future Testnet'}
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setAccountType('REAL')}
                className={`py-2.5 px-3 rounded-2xl font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                  currentAccountType === 'REAL'
                    ? 'bg-emerald-500/15 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 shadow-xs ring-1 ring-emerald-400/30'
                    : 'bg-slate-50 dark:bg-zinc-950 border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <div className="text-left">
                  <div className="text-xs">REAL ACCOUNT</div>
                  <div className="text-[9px] opacity-75 font-normal">
                    {selectedExchange === 'BITGET' ? 'Bitget Live USDT-M V2' : 'Live USDT-M'}
                  </div>
                </div>
              </button>
            </div>

            {/* Target Endpoint Info */}
            <div className="mt-2 px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-zinc-950 border border-slate-200/70 dark:border-zinc-800 text-[10px] text-slate-500 dark:text-slate-400 flex items-center justify-between">
              <span>Endpoint:</span>
              <span className="font-bold text-[#0F172A] dark:text-slate-200 truncate ml-2">
                {selectedExchange === 'BINANCE'
                  ? currentAccountType === 'REAL'
                    ? 'https://fapi.binance.com'
                    : 'https://testnet.binancefuture.com'
                  : currentAccountType === 'DEMO'
                  ? 'https://api.bitget.com (Bitget Demo V2 · paptrading: 1)'
                  : 'https://api.bitget.com (Bitget Live V2 · USDT-FUTURES)'}
              </span>
            </div>
          </div>

          {/* 3. DYNAMIC CREDENTIAL FORM */}
          <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                3. {selectedExchange} CREDENTIALS
              </label>
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
                <Lock className="w-2.5 h-2.5" /> Client Encrypted
              </span>
            </div>

            {selectedExchange === 'BINANCE' ? (
              /* BINANCE FORM FIELDS */
              <>
                <div>
                  <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
                    BINANCE API KEY
                  </label>
                  <input
                    type="text"
                    value={binanceKey}
                    onChange={(e) => setBinanceKey(e.target.value)}
                    placeholder="Enter your Binance Futures API Key (64 chars)"
                    className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-amber-500 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
                    BINANCE SECRET KEY (HMAC-SHA256)
                  </label>
                  <div className="relative">
                    <input
                      type={showBinanceSecret ? 'text' : 'password'}
                      value={binanceSecret}
                      onChange={(e) => setBinanceSecret(e.target.value)}
                      placeholder="Enter your Binance Secret Key"
                      className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 pr-10 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-amber-500 focus:outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBinanceSecret(!showBinanceSecret)}
                      className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                    >
                      {showBinanceSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 font-sans">
                    Ensure &quot;Enable Futures&quot; permission is checked on Binance API management. Disable withdrawals.
                  </p>
                </div>
              </>
            ) : (
              /* BITGET FORM FIELDS (Key, Secret, Passphrase) */
              <>
                <div>
                  <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
                    BITGET API KEY
                  </label>
                  <input
                    type="text"
                    value={bitgetKey}
                    onChange={(e) => setBitgetKey(e.target.value)}
                    placeholder="Enter your Bitget V2 API Key"
                    className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-cyan-500 focus:outline-none transition-colors"
                  />
                </div>

                <div>
                  <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
                    BITGET SECRET KEY
                  </label>
                  <div className="relative">
                    <input
                      type={showBitgetSecret ? 'text' : 'password'}
                      value={bitgetSecret}
                      onChange={(e) => setBitgetSecret(e.target.value)}
                      placeholder="Enter your Bitget Secret Key"
                      className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 pr-10 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-cyan-500 focus:outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBitgetSecret(!showBitgetSecret)}
                      className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                    >
                      {showBitgetSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-slate-700 dark:text-slate-300 font-semibold block mb-1.5">
                    BITGET API PASSPHRASE (REQUIRED BY V2 API)
                  </label>
                  <div className="relative">
                    <input
                      type={showBitgetPassphrase ? 'text' : 'password'}
                      value={bitgetPassphrase}
                      onChange={(e) => setBitgetPassphrase(e.target.value)}
                      placeholder="Enter passphrase created during Bitget API key creation"
                      className="w-full bg-slate-50 dark:bg-zinc-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3.5 py-2.5 pr-10 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:bg-white dark:focus:bg-zinc-900 focus:border-cyan-500 focus:outline-none transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBitgetPassphrase(!showBitgetPassphrase)}
                      className="absolute right-3 top-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
                    >
                      {showBitgetPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 font-sans">
                    Bitget requires this custom passphrase alongside Key and Secret for ACCESS-PASSPHRASE signing.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Test Status Feedback */}
          {testStatus && (
            <div
              className={`p-3.5 rounded-2xl border flex flex-col gap-1 text-xs animate-in fade-in ${
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
                  <span className="text-[10px] opacity-80 font-mono">{testStatus.latencyMs}ms</span>
                )}
              </div>
              {testStatus.success && typeof testStatus.balance === 'number' && (
                <div className="text-[10px] text-emerald-700 dark:text-emerald-400 pt-1.5 border-t border-emerald-200/80 dark:border-emerald-800/60 flex items-center justify-between font-mono">
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
                <span>{isTesting ? 'Testing...' : `Test ${selectedExchange}`}</span>
              </button>

              <button
                type="button"
                onClick={handleClear}
                className="text-xs text-rose-600 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 hover:underline px-2 py-1 cursor-pointer"
              >
                Clear {selectedExchange}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeVaultModal}
                className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-zinc-700 text-xs font-semibold cursor-pointer transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                className={`px-5 py-2 rounded-xl text-white font-bold flex items-center gap-2 shadow-xs text-xs cursor-pointer transition-all ${
                  selectedExchange === 'BITGET'
                    ? 'bg-cyan-600 hover:bg-cyan-500 shadow-cyan-600/20'
                    : 'bg-[#0F172A] hover:bg-[#1E293B] dark:bg-amber-600 dark:hover:bg-amber-500 shadow-amber-600/20'
                }`}
              >
                {isSavedAlert ? (
                  <Check className="w-4 h-4 text-emerald-400 dark:text-white" />
                ) : (
                  <Save className="w-4 h-4 text-emerald-400 dark:text-white" />
                )}
                <span>
                  {isSavedAlert
                    ? 'Saved to Vault!'
                    : `Save & Connect ${selectedExchange === 'BITGET' ? 'Bitget' : 'Binance'}`}
                </span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

export const CryptoVaultModal = BinanceVaultModal;
export default BinanceVaultModal;
