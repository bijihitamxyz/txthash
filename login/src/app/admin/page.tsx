'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  ShieldAlert,
  Key,
  Lock,
  Unlock,
  Copy,
  Check,
  Plus,
  Trash2,
  RefreshCw,
  ArrowLeft,
  Calendar,
  Clock,
  User,
  Search,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Send,
  X,
} from 'lucide-react';
import { LicenseRecord, LicenseStats, LicenseDuration } from '@/lib/licenseDb';

const ADMIN_STORAGE_KEY = 'exness_admin_master_key';

export default function AdminPage() {
  const [adminKey, setAdminKey] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginInput, setLoginInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);

  // Data states
  const [licenses, setLicenses] = useState<LicenseRecord[]>([]);
  const [stats, setStats] = useState<LicenseStats>({
    totalKeys: 0,
    activeKeys: 0,
    expiredKeys: 0,
    revokedKeys: 0,
  });
  const [isFetchingData, setIsFetchingData] = useState(false);

  // Generator form states
  const [genUsername, setGenUsername] = useState('');
  const [genTelegram, setGenTelegram] = useState('');
  const [genEmail, setGenEmail] = useState('');
  const [genDuration, setGenDuration] = useState<LicenseDuration>('7d');
  const [isGenerating, setIsGenerating] = useState(false);
  const [createdLicense, setCreatedLicense] = useState<LicenseRecord | null>(null);

  // Copy feedback
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Table filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'EXPIRED' | 'REVOKED'>('ALL');
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Toast notification
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => {
      setToast(null);
    }, 4000);
  };

  // Fetch licenses data from API
  const fetchDashboardData = useCallback(async (keyToUse: string) => {
    setIsFetchingData(true);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'GET',
        headers: {
          'x-admin-key': keyToUse,
        },
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setLicenses(data.licenses || []);
        if (data.stats) {
          setStats(data.stats);
        }
        return true;
      } else {
        return false;
      }
    } catch (err) {
      console.error('Fetch admin data error:', err);
      return false;
    } finally {
      setIsFetchingData(false);
    }
  }, []);

  // Initial check on mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(ADMIN_STORAGE_KEY) || 'admin123';
    if (saved) {
      setLoginInput(saved);
      setIsLoadingAuth(true);
      fetchDashboardData(saved).then((success) => {
        setIsLoadingAuth(false);
        if (success) {
          setAdminKey(saved);
          setIsAuthenticated(true);
        }
      });
    }
  }, [fetchDashboardData]);

  // Handle Admin Auth Login
  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = loginInput.trim();
    if (!cleanKey) {
      setLoginError('Masukkan Admin Master Key.');
      return;
    }

    setIsLoadingAuth(true);
    setLoginError(null);

    const success = await fetchDashboardData(cleanKey);
    setIsLoadingAuth(false);

    if (success) {
      setAdminKey(cleanKey);
      setIsAuthenticated(true);
      if (typeof window !== 'undefined') {
        localStorage.setItem(ADMIN_STORAGE_KEY, cleanKey);
      }
    } else {
      setLoginError('Admin Master Key tidak valid. Silakan coba lagi.');
    }
  };

  const handleAdminLogout = () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(ADMIN_STORAGE_KEY);
    }
    setAdminKey('');
    setIsAuthenticated(false);
    setLoginInput('');
    setLicenses([]);
  };

  // Generate License Action
  const handleGenerateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genUsername.trim()) {
      showToast('error', 'Username wajib diisi.');
      return;
    }
    if (!genTelegram.trim()) {
      showToast('error', 'Telegram (@username) wajib diisi.');
      return;
    }

    setIsGenerating(true);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'CREATE',
          username: genUsername.trim(),
          telegram: genTelegram.trim(),
          email: genEmail.trim() || undefined,
          duration: genDuration,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setCreatedLicense(data.license);
        showToast('success', `Lisensi berhasil dibuat: ${data.license.licenseKey}`);
        setGenUsername('');
        setGenTelegram('');
        setGenEmail('');
        fetchDashboardData(adminKey);
      } else {
        showToast('error', data.error || 'Gagal membuat lisensi.');
      }
    } catch {
      showToast('error', 'Terjadi kesalahan jaringan saat membuat lisensi.');
    } finally {
      setIsGenerating(false);
    }
  };

  // Extend License Action
  const handleExtend = async (licenseKey: string, days: number) => {
    setActionLoadingId(`${licenseKey}_extend_${days}`);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'EXTEND',
          licenseKey,
          days,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showToast('success', `Lisensi ${licenseKey} diperpanjang +${days} Hari.`);
        fetchDashboardData(adminKey);
      } else {
        showToast('error', data.error || 'Gagal memperpanjang lisensi.');
      }
    } catch {
      showToast('error', 'Terjadi kesalahan saat memperpanjang lisensi.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Revoke / Activate Toggle Action
  const handleToggleRevoke = async (licenseKey: string, currentStatus: string) => {
    setActionLoadingId(`${licenseKey}_revoke`);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'REVOKE',
          licenseKey,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        const newStatus = data.license.status;
        showToast(
          'success',
          `Status lisensi ${licenseKey} diubah ke ${newStatus}.`
        );
        fetchDashboardData(adminKey);
      } else {
        showToast('error', data.error || 'Gagal mengubah status lisensi.');
      }
    } catch {
      showToast('error', 'Terjadi kesalahan saat mengubah status.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Delete Action
  const handleDelete = async (licenseKey: string) => {
    if (!window.confirm(`Yakin ingin MENGHAPUS lisensi ${licenseKey}? Tindakan ini permanen.`)) {
      return;
    }

    setActionLoadingId(`${licenseKey}_delete`);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'DELETE',
          licenseKey,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showToast('success', `Lisensi ${licenseKey} berhasil dihapus.`);
        if (createdLicense?.licenseKey === licenseKey) {
          setCreatedLicense(null);
        }
        fetchDashboardData(adminKey);
      } else {
        showToast('error', data.error || 'Gagal menghapus lisensi.');
      }
    } catch {
      showToast('error', 'Terjadi kesalahan saat menghapus lisensi.');
    } finally {
      setActionLoadingId(null);
    }
  };

  // Copy helper
  const copyToClipboard = (text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(text);
      setTimeout(() => setCopiedKey(null), 2500);
    }
  };

  // Remaining days calculation helper
  const getRemainingText = (expiresAt: string, status: string) => {
    if (status === 'REVOKED') return 'Revoked';
    const now = Date.now();
    const expTime = new Date(expiresAt).getTime();
    const diffMs = expTime - now;

    if (diffMs <= 0 || status === 'EXPIRED') {
      const pastDays = Math.ceil(Math.abs(diffMs) / (1000 * 60 * 60 * 24));
      return `Expired (${pastDays}d ago)`;
    }

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

    if (days > 0) {
      return `${days} Hari lagi`;
    }
    return `${hours} Jam lagi`;
  };

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('id-ID', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  // Filtered licenses for table
  const filteredLicenses = licenses.filter((lic) => {
    if (statusFilter !== 'ALL' && lic.status !== statusFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      const matchKey = lic.licenseKey.toLowerCase().includes(query);
      const matchUser = lic.username.toLowerCase().includes(query);
      const matchTele = lic.telegram.toLowerCase().includes(query);
      const matchEmail = (lic.email || '').toLowerCase().includes(query);
      return matchKey || matchUser || matchTele || matchEmail;
    }
    return true;
  });

  // 1. ADMIN AUTH SCREEN
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-indigo-500/30 selection:text-indigo-200">
        <header className="max-w-7xl mx-auto w-full px-4 py-6 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center gap-2 text-xs text-slate-400 hover:text-slate-200 bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 transition-colors font-mono"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Kembali ke Trading Terminal</span>
          </Link>
          <span className="font-mono text-xs text-slate-500">ADMIN AUTH GATEWAY</span>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-8">
          <div className="w-full max-w-md">
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl">
              <div className="flex flex-col items-center text-center mb-6">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400 mb-4 shadow-inner">
                  <Lock className="w-7 h-7" />
                </div>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white mb-1">
                  Admin Dashboard Access
                </h1>
                <p className="text-xs sm:text-sm text-slate-400">
                  Masukkan Master Key untuk mengelola lisensi pengguna.
                </p>
              </div>

              {loginError && (
                <div className="mb-5 p-3 rounded-xl bg-rose-950/60 border border-rose-800/80 flex items-center gap-2 text-rose-300 text-xs sm:text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                  <span>{loginError}</span>
                </div>
              )}

              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-mono font-medium text-slate-300 mb-2">
                    ADMIN MASTER KEY
                  </label>
                  <input
                    type="password"
                    value={loginInput}
                    onChange={(e) => setLoginInput(e.target.value)}
                    placeholder="Masukkan admin key (default: admin123)"
                    disabled={isLoadingAuth}
                    className="w-full bg-slate-950/90 border border-slate-700 rounded-xl px-4 py-3 font-mono text-center text-sm sm:text-base text-amber-300 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
                    autoFocus
                  />
                  <p className="mt-1.5 text-[11px] text-slate-500 font-mono text-center">
                    Default Master Key: <span className="text-amber-400 font-semibold">admin123</span>
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={isLoadingAuth}
                  className="w-full bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-500 hover:to-amber-400 text-white font-semibold text-sm py-3 px-4 rounded-xl shadow-lg shadow-amber-600/20 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {isLoadingAuth ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Memverifikasi...</span>
                    </>
                  ) : (
                    <>
                      <Unlock className="w-4 h-4" />
                      <span>Unlock Admin Dashboard</span>
                    </>
                  )}
                </button>
              </form>
            </div>
          </div>
        </main>

        <footer className="max-w-7xl mx-auto w-full px-4 py-5 text-center text-xs text-slate-600 font-mono">
          Exness Quant AI • Admin Management System
        </footer>
      </div>
    );
  }

  // 2. AUTHENTICATED ADMIN DASHBOARD
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30 selection:text-indigo-200">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 animate-in slide-in-from-top duration-200">
          <div
            className={`flex items-center gap-2 px-4 py-3 rounded-xl border shadow-xl text-xs sm:text-sm font-medium ${
              toast.type === 'success'
                ? 'bg-emerald-950/90 border-emerald-800 text-emerald-200'
                : 'bg-rose-950/90 border-rose-800 text-rose-200'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span>{toast.message}</span>
            <button
              onClick={() => setToast(null)}
              className="ml-2 text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Top Admin Navigation Bar */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 sticky top-0 z-40 shadow-md">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-sm sm:text-base text-white tracking-wide">
                  EXNESS QUANT // LICENSE ADMIN
                </h1>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  MASTER MODE
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-mono">
                Persistent Database: data/licenses_db.json
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-1.5 transition-colors font-mono"
            >
              <ArrowLeft className="w-3.5 h-3.5 text-indigo-400" />
              <span>Trading Terminal</span>
            </Link>

            <button
              onClick={() => fetchDashboardData(adminKey)}
              disabled={isFetchingData}
              title="Refresh Data"
              className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-1.5 transition-colors font-mono cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetchingData ? 'animate-spin text-indigo-400' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            <button
              onClick={handleAdminLogout}
              title="Logout Admin"
              className="flex items-center gap-1 text-xs text-rose-300 hover:text-rose-100 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/60 rounded-lg px-2.5 py-1.5 transition-colors font-mono cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Lock</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto w-full px-4 py-6 flex-1 space-y-6">
        {/* SUMMARY METRIC CARDS */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-slate-400 mb-2">
              <span className="text-xs font-mono font-medium">TOTAL LICENSES</span>
              <Key className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="text-2xl sm:text-3xl font-bold font-mono text-white">
              {stats.totalKeys}
            </div>
            <p className="text-[11px] text-slate-500 font-mono mt-1">Semua kunci terdaftar</p>
          </div>

          <div className="bg-slate-900/80 border border-emerald-900/40 rounded-xl p-4 sm:p-5 flex flex-col justify-between shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-xl pointer-events-none" />
            <div className="flex items-center justify-between text-emerald-400 mb-2">
              <span className="text-xs font-mono font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                ACTIVE USERS
              </span>
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl sm:text-3xl font-bold font-mono text-emerald-300">
              {stats.activeKeys}
            </div>
            <p className="text-[11px] text-emerald-500/70 font-mono mt-1">Lisensi aktif & valid</p>
          </div>

          <div className="bg-slate-900/80 border border-amber-900/40 rounded-xl p-4 sm:p-5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-amber-400 mb-2">
              <span className="text-xs font-mono font-medium">EXPIRED KEYS</span>
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl sm:text-3xl font-bold font-mono text-amber-300">
              {stats.expiredKeys}
            </div>
            <p className="text-[11px] text-amber-500/70 font-mono mt-1">Melewati batas waktu</p>
          </div>

          <div className="bg-slate-900/80 border border-rose-900/40 rounded-xl p-4 sm:p-5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-rose-400 mb-2">
              <span className="text-xs font-mono font-medium">REVOKED KEYS</span>
              <ShieldAlert className="w-4 h-4 text-rose-400" />
            </div>
            <div className="text-2xl sm:text-3xl font-bold font-mono text-rose-300">
              {stats.revokedKeys}
            </div>
            <p className="text-[11px] text-rose-500/70 font-mono mt-1">Dinonaktifkan admin</p>
          </div>
        </section>

        {/* 1-CLICK LICENSE GENERATOR CARD */}
        <section className="bg-slate-900/90 border border-indigo-500/30 rounded-2xl p-5 sm:p-6 shadow-xl relative overflow-hidden">
          <div className="flex items-center gap-2.5 mb-4">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-indigo-400">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">1-Click License Key Generator</h2>
              <p className="text-xs text-slate-400">
                Buat lisensi instan untuk pengguna baru dengan durasi 7 Hari atau 30 Hari.
              </p>
            </div>
          </div>

          <form onSubmit={handleGenerateLicense} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1.5 font-medium">
                  Username <span className="text-indigo-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={genUsername}
                    onChange={(e) => setGenUsername(e.target.value)}
                    placeholder="misal: john_doe"
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <User className="w-3.5 h-3.5 text-slate-600 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1.5 font-medium">
                  Telegram (@username) <span className="text-indigo-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={genTelegram}
                    onChange={(e) => setGenTelegram(e.target.value)}
                    placeholder="misal: @johndoe"
                    required
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <Send className="w-3.5 h-3.5 text-slate-600 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1.5 font-medium">
                  Email (Opsional)
                </label>
                <input
                  type="email"
                  value={genEmail}
                  onChange={(e) => setGenEmail(e.target.value)}
                  placeholder="john@example.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-300 mb-1.5 font-medium">
                  Durasi Paket Lisensi
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setGenDuration('7d')}
                    className={`px-3 py-2.5 rounded-xl text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center ${
                      genDuration === '7d'
                        ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span>7 Hari</span>
                    <span className="text-[10px] text-slate-500 font-normal">1 Minggu</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setGenDuration('30d')}
                    className={`px-3 py-2.5 rounded-xl text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center ${
                      genDuration === '30d'
                        ? 'bg-purple-600/30 border-purple-500 text-purple-200 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <span>30 Hari</span>
                    <span className="text-[10px] text-slate-500 font-normal">1 Bulan VIP</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isGenerating || !genUsername.trim() || !genTelegram.trim()}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs sm:text-sm px-6 py-2.5 rounded-xl shadow-lg shadow-indigo-600/20 transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Membuat Kunci...</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    <span>Generate License Key</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {createdLicense && (
            <div className="mt-5 p-4 rounded-xl bg-indigo-950/40 border border-indigo-500/40 animate-in fade-in slide-in-from-top-2 duration-200 relative">
              <button
                onClick={() => setCreatedLicense(null)}
                className="absolute top-3 right-3 text-slate-400 hover:text-white p-1"
                title="Tutup banner"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-2 text-indigo-300 text-xs font-semibold mb-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>LISENSI BARU SIAP DIGUNAKAN</span>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-950/80 p-3.5 rounded-lg border border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="font-mono text-base sm:text-lg font-bold text-indigo-300 tracking-wider">
                    {createdLicense.licenseKey}
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(createdLicense.licenseKey)}
                    className="p-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 transition-colors flex items-center gap-1.5 text-xs font-medium cursor-pointer"
                    title="Copy Key"
                  >
                    {copiedKey === createdLicense.licenseKey ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-emerald-300">Tersalin!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Key</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="flex items-center gap-3 text-xs text-slate-400 font-mono">
                  <span>User: <strong className="text-slate-200">{createdLicense.username}</strong></span>
                  <span>•</span>
                  <span>Telegram: <strong className="text-indigo-300">{createdLicense.telegram}</strong></span>
                  <span>•</span>
                  <span>Exp: <strong className="text-emerald-400">{formatDate(createdLicense.expiresAt)}</strong></span>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* LICENSE MANAGEMENT TABLE SECTION */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>Daftar Lisensi Aktif & Riwayat</span>
                <span className="text-xs font-mono font-normal text-slate-400">
                  ({filteredLicenses.length} ditampilkan)
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Kelola status lisensi, perpanjangan masa aktif (+7D/+30D), dan hapus lisensi.
              </p>
            </div>

            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs font-mono">
              {(['ALL', 'ACTIVE', 'EXPIRED', 'REVOKED'] as const).map((status) => (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 rounded-lg transition-colors cursor-pointer ${
                    statusFilter === status
                      ? 'bg-indigo-600 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari berdasarkan License Key, Username, Telegram, atau Email..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-4 py-2.5 text-xs sm:text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs sm:text-sm text-slate-300">
              <thead className="bg-slate-950/80 text-[11px] font-mono text-slate-400 uppercase tracking-wider border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">License Key</th>
                  <th className="py-3 px-4">User Details</th>
                  <th className="py-3 px-3 text-center">Plan</th>
                  <th className="py-3 px-3 text-center">Status</th>
                  <th className="py-3 px-4">Expires In</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-sans">
                {filteredLicenses.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500 font-mono text-xs">
                      Tidak ada lisensi yang cocok dengan filter.
                    </td>
                  </tr>
                ) : (
                  filteredLicenses.map((lic) => {
                    const isCopied = copiedKey === lic.licenseKey;
                    const remaining = getRemainingText(lic.expiresAt, lic.status);

                    return (
                      <tr
                        key={lic.id || lic.licenseKey}
                        className="hover:bg-slate-800/40 transition-colors"
                      >
                        <td className="py-3 px-4 font-mono">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-100 tracking-wider">
                              {lic.licenseKey}
                            </span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(lic.licenseKey)}
                              title="Salin Kunci"
                              className="text-slate-500 hover:text-indigo-400 p-1 rounded hover:bg-slate-800 transition-colors cursor-pointer"
                            >
                              {isCopied ? (
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </td>

                        <td className="py-3 px-4">
                          <div className="flex flex-col">
                            <span className="font-bold text-slate-200">{lic.username}</span>
                            <span className="text-xs text-indigo-400 font-mono">
                              {lic.telegram}
                            </span>
                            {lic.email && (
                              <span className="text-[11px] text-slate-500 truncate max-w-[160px]">
                                {lic.email}
                              </span>
                            )}
                          </div>
                        </td>

                        <td className="py-3 px-3 text-center">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                              lic.duration === '30d'
                                ? 'bg-purple-950/60 text-purple-300 border border-purple-800'
                                : 'bg-indigo-950/60 text-indigo-300 border border-indigo-800'
                            }`}
                          >
                            {lic.duration.toUpperCase()}
                          </span>
                        </td>

                        <td className="py-3 px-3 text-center">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold border ${
                              lic.status === 'ACTIVE'
                                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
                                : lic.status === 'EXPIRED'
                                ? 'bg-amber-950/60 text-amber-300 border-amber-800'
                                : 'bg-rose-950/60 text-rose-300 border-rose-800'
                            }`}
                          >
                            {lic.status === 'ACTIVE' && (
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            )}
                            {lic.status}
                          </span>
                        </td>

                        <td className="py-3 px-4 font-mono text-xs">
                          <div className="flex flex-col">
                            <span
                              className={`font-semibold ${
                                lic.status === 'ACTIVE'
                                  ? 'text-emerald-300'
                                  : lic.status === 'EXPIRED'
                                  ? 'text-amber-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              {remaining}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {formatDate(lic.expiresAt)}
                            </span>
                          </div>
                        </td>

                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1 font-mono text-xs">
                            <button
                              type="button"
                              onClick={() => handleExtend(lic.licenseKey, 7)}
                              disabled={actionLoadingId !== null}
                              title="Perpanjang 7 Hari"
                              className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded border border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
                            >
                              +7D
                            </button>

                            <button
                              type="button"
                              onClick={() => handleExtend(lic.licenseKey, 30)}
                              disabled={actionLoadingId !== null}
                              title="Perpanjang 30 Hari"
                              className="px-2 py-1 bg-indigo-950 hover:bg-indigo-900 text-indigo-300 hover:text-indigo-100 rounded border border-indigo-800 transition-colors cursor-pointer disabled:opacity-50"
                            >
                              +30D
                            </button>

                            <button
                              type="button"
                              onClick={() => handleToggleRevoke(lic.licenseKey, lic.status)}
                              disabled={actionLoadingId !== null}
                              title={lic.status === 'REVOKED' ? 'Aktifkan Kembali' : 'Cabut Lisensi (Revoke)'}
                              className={`px-2 py-1 rounded border transition-colors cursor-pointer disabled:opacity-50 ${
                                lic.status === 'REVOKED'
                                  ? 'bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border-emerald-800'
                                  : 'bg-amber-950/40 hover:bg-amber-900/60 text-amber-300 border-amber-800'
                              }`}
                            >
                              {lic.status === 'REVOKED' ? 'Unrevoke' : 'Revoke'}
                            </button>

                            <button
                              type="button"
                              onClick={() => handleDelete(lic.licenseKey)}
                              disabled={actionLoadingId !== null}
                              title="Hapus Lisensi"
                              className="p-1 text-slate-400 hover:text-rose-400 hover:bg-rose-950/50 rounded border border-transparent hover:border-rose-900 transition-colors cursor-pointer disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
