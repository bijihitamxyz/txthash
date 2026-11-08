'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useTradingStore } from '@/store/useTradingStore';
import { useBinanceStore } from '@/store/useBinanceStore';
import { InstitutionalFooter, ThemeToggle } from '@/components/InstitutionalChrome';
import {
  EngineSwitches,
  AiProviderSlot,
  DEFAULT_ENGINE_SWITCHES,
  DEFAULT_AI_PROVIDER_SLOTS,
} from '@/core/centralAiConfig';
import {
  Server,
  Cpu,
  ShieldCheck,
  Activity,
  Terminal,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Lock,
  Sliders,
  KeyRound,
  Users,
  Plus,
  Copy,
  Check,
  Trash2,
  Eye,
  EyeOff,
  LogOut,
  Search,
  BrainCircuit,
  Save,
  Loader2,
  ArrowUpRight,
  Ban,
  CalendarPlus,
  Zap,
} from 'lucide-react';

const ADMIN_SESSION_STORAGE_KEY = 'nmssx_admin_session_key';

type AdminTab = 'ALL' | 'AI_VPS' | 'LICENSES' | 'GOVERNANCE';

interface LicenseRow {
  id: string;
  licenseKey: string;
  username: string;
  telegram: string;
  email?: string;
  duration: '7d' | '30d';
  createdAt: string;
  expiresAt: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  lastVerifiedAt?: string;
}

interface LicenseStats {
  total: number;
  active: number;
  expired: number;
  revoked: number;
}

interface ProviderPingState {
  testing: boolean;
  ok?: boolean;
  statusText?: string;
  latencyMs?: number;
}

const PROVIDER_MODEL_HINTS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest'],
  openrouter: ['anthropic/claude-3.7-sonnet', 'deepseek/deepseek-chat-v3-0324', 'openai/gpt-4o'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  groq: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'qwen-qwq-32b'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  custom: ['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'local-consensus'],
};

const PROVIDER_META: Record<
  string,
  {
    shortName: string;
    brandColor: string;
    badgeBg: string;
    badgeBorder: string;
  }
> = {
  anthropic: {
    shortName: 'Anthropic',
    brandColor: 'text-[#D97706] dark:text-[#FBBF24]',
    badgeBg: 'bg-amber-500/10',
    badgeBorder: 'border-amber-500/30',
  },
  openrouter: {
    shortName: 'OpenRouter',
    brandColor: 'text-indigo-600 dark:text-indigo-400',
    badgeBg: 'bg-indigo-500/10',
    badgeBorder: 'border-indigo-500/30',
  },
  openai: {
    shortName: 'OpenAI',
    brandColor: 'text-emerald-600 dark:text-emerald-400',
    badgeBg: 'bg-emerald-500/10',
    badgeBorder: 'border-emerald-500/30',
  },
  groq: {
    shortName: 'Groq LPU',
    brandColor: 'text-orange-600 dark:text-orange-400',
    badgeBg: 'bg-orange-500/10',
    badgeBorder: 'border-orange-500/30',
  },
  deepseek: {
    shortName: 'DeepSeek',
    brandColor: 'text-sky-600 dark:text-sky-400',
    badgeBg: 'bg-sky-500/10',
    badgeBorder: 'border-sky-500/30',
  },
  gemini: {
    shortName: 'Google Gemini',
    brandColor: 'text-purple-600 dark:text-purple-400',
    badgeBg: 'bg-purple-500/10',
    badgeBorder: 'border-purple-500/30',
  },
  custom: {
    shortName: 'Custom / Local VPS',
    brandColor: 'text-teal-600 dark:text-teal-400',
    badgeBg: 'bg-teal-500/10',
    badgeBorder: 'border-teal-500/30',
  },
};

function AnthropicLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.83 3.5h3.64l6.53 17h-3.64l-1.35-3.5h-6.7l-1.35 3.5H7.32l6.51-17zm1.53 10.5-2.01-5.25-2.02 5.25h4.03zM3.65 20.5H0L6.53 3.5h3.64l-6.52 17z" />
    </svg>
  );
}

function OpenRouterLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 1.5L3 6.7v10.6l9 5.2 9-5.2V6.7L12 1.5zm0 2.4l6.9 4-6.9 4-6.9-4 6.9-4zM5 8.3l6 3.5v7l-6-3.5V8.3zm8 10.5v-7l6-3.5v7l-6 3.5z" />
    </svg>
  );
}

function OpenAiLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.28 9.37a5.98 5.98 0 0 0-.52-4.94 6.07 6.07 0 0 0-6.42-2.91 6.02 6.02 0 0 0-4.66-2.02 6.05 6.05 0 0 0-5.76 4.19 6.03 6.03 0 0 0-3.9 2.82 6.08 6.08 0 0 0 .74 7.06 6.04 6.04 0 0 0 .52 4.94 6.07 6.07 0 0 0 6.42 2.91 6.02 6.02 0 0 0 4.66 2.02 6.05 6.05 0 0 0 5.76-4.19 6.03 6.03 0 0 0 3.9-2.82 6.08 6.08 0 0 0-.74-7.06zm-8.86 12.3c-.63 0-1.25-.13-1.83-.37l3.83-2.21a.98.98 0 0 0 .5-.86v-5.41l1.63.94v4.47a4.07 4.07 0 0 1-4.13 3.43zm-7.66-3.8c-.35-.53-.55-1.15-.59-1.78l3.83-2.21c.27-.15.44-.45.44-.76V7.71l1.63.94v5.41a4.07 4.07 0 0 1-5.31 3.01zm-1.8-8.5c.28-.57.7-1.06 1.23-1.42l3.83 2.21c.27.15.6.15.87 0l4.69-2.71-1.63-.94-3.87 2.24a4.07 4.07 0 0 1-5.12.62zm13.1-2.04l-3.83 2.21a.98.98 0 0 0-.5.86v5.41l-1.63-.94V10.4a4.07 4.07 0 0 1 5.96-3.07zm1.8 8.5a4.04 4.04 0 0 1-1.23 1.42l-3.83-2.21a.98.98 0 0 0-.87 0l-4.69 2.71 1.63.94 3.87-2.24a4.07 4.07 0 0 1 5.12-.62zM9.46 13.5l2.54-1.47 2.54 1.47v2.93l-2.54 1.47-2.54-1.47v-2.93z" />
    </svg>
  );
}

function GroqLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5h-2.5l2-4.5H9.5l3.5-6v4.5h2.5l-2.5 6z" />
    </svg>
  );
}

function DeepSeekLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.8 12.4c-.4-.5-1.2-.8-2-.9-.8-.1-2 .1-3.2.7-1.4.7-2.8 1.8-4.3 2.5-1.5.7-3.1.9-4.5.4-1.2-.4-2.1-1.3-2.6-2.5C4.6 11.2 5 9.5 6.2 8.1c1.4-1.7 3.6-2.8 6.1-3 1.9-.1 3.8.4 5.4 1.4.5.3 1.1.2 1.4-.3.3-.5.2-1.1-.3-1.4-1.9-1.2-4.2-1.8-6.6-1.6-3 .2-5.7 1.5-7.4 3.6C3.3 8.6 2.8 10.8 3.5 13c.7 2.1 2.2 3.6 4.1 4.2 1.9.6 4.1.3 6-.6 1.3-.6 2.5-1.5 3.8-2.1 1-.5 1.9-.6 2.5-.5.4.1.7.2.9.4.2.2.3.4.3.4.1.5.6.8 1.1.7.5-.1.8-.6.7-1.1-.1-.3-.4-.8-1.1-1.3z" />
      <circle cx="8" cy="9.5" r="1.2" />
    </svg>
  );
}

function GeminiLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C12 7.52 7.52 12 2 12c5.48 0 10 4.48 10 10 0-5.52 4.48-10 10-10-5.52 0-10-4.48-10-10z" />
    </svg>
  );
}

function CustomVpsLogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="7" rx="2" />
      <rect x="2" y="14" width="20" height="7" rx="2" />
      <line x1="6" y1="6.5" x2="6.01" y2="6.5" strokeWidth="2" />
      <line x1="6" y1="17.5" x2="6.01" y2="17.5" strokeWidth="2" />
      <path d="M12 6.5h6" />
      <path d="M12 17.5h6" />
    </svg>
  );
}

function renderProviderLogo(id: string, className = 'w-4 h-4') {
  switch (id) {
    case 'anthropic':
      return <AnthropicLogo className={className} />;
    case 'openrouter':
      return <OpenRouterLogo className={className} />;
    case 'openai':
      return <OpenAiLogo className={className} />;
    case 'groq':
      return <GroqLogo className={className} />;
    case 'deepseek':
      return <DeepSeekLogo className={className} />;
    case 'gemini':
      return <GeminiLogo className={className} />;
    case 'custom':
    default:
      return <CustomVpsLogo className={className} />;
  }
}

function normalizeStatsPayload(raw: any, fallbackList: LicenseRow[]): LicenseStats {
  if (raw && typeof raw === 'object') {
    return {
      total: Number(raw.total ?? raw.totalKeys ?? fallbackList.length),
      active: Number(raw.active ?? raw.activeKeys ?? 0),
      expired: Number(raw.expired ?? raw.expiredKeys ?? 0),
      revoked: Number(raw.revoked ?? raw.revokedKeys ?? 0),
    };
  }
  return {
    total: fallbackList.length,
    active: fallbackList.filter((l) => l.status === 'ACTIVE').length,
    expired: fallbackList.filter((l) => l.status === 'EXPIRED').length,
    revoked: fallbackList.filter((l) => l.status === 'REVOKED').length,
  };
}

export default function SystemAdminPage() {
  // Admin Authentication State
  const [adminKey, setAdminKey] = useState('');
  const [loginInput, setLoginInput] = useState('');
  const [showLoginKey, setShowLoginKey] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Active Section Filter
  const [activeTab, setActiveTab] = useState<AdminTab>('ALL');

  // Trading & Health Store Snapshots
  const balance = useTradingStore((s) => s.balance);
  const equity = useTradingStore((s) => s.equity);
  const accountInfo = useTradingStore((s) => s.accountInfo);
  const isAutoTrading = useTradingStore((s) => s.isAutoTrading);
  const toggleAutoTrading = useTradingStore((s) => s.toggleAutoTrading);
  const fetchAccountInfo = useTradingStore((s) => s.fetchAccountInfo);
  const kronosHealth = useTradingStore((s) => s.kronosHealth);
  const checkKronosHealth = useTradingStore((s) => s.checkKronosHealth);

  const binanceWallet = useBinanceStore((s) => s.walletBalance);
  const binanceTestnet = useBinanceStore((s) => s.isTestnet);
  const binanceConfigured = useBinanceStore((s) => s.isVaultConfigured);

  // Central Multi-AI Provider Slots Configuration State
  const [providers, setProviders] = useState<AiProviderSlot[]>(() =>
    DEFAULT_AI_PROVIDER_SLOTS.map((s) => ({ ...s }))
  );
  const [selectedProviderId, setSelectedProviderId] = useState<string>('anthropic');
  const activeSlot = useMemo(() => {
    return providers.find((p) => p.id === selectedProviderId) || providers[0] || null;
  }, [providers, selectedProviderId]);
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({});
  const [providerPingMap, setProviderPingMap] = useState<Record<string, ProviderPingState>>({});
  const [providerModelsMap, setProviderModelsMap] = useState<Record<string, string[]>>({});
  const [fetchingModelsId, setFetchingModelsId] = useState<string | null>(null);
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(70);
  const [isSavingAi, setIsSavingAi] = useState(false);
  const [aiFeedback, setAiFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Oracle VPS Kronos Node State
  const [vpsUrl, setVpsUrl] = useState('http://127.0.0.1:8000');
  const [vpsApiKey, setVpsApiKey] = useState('nmssx-kronos-secret-2026');
  const [showVpsKey, setShowVpsKey] = useState(false);
  const [isPingingVps, setIsPingingVps] = useState(false);
  const [isSavingVps, setIsSavingVps] = useState(false);
  const [vpsPingBadge, setVpsPingBadge] = useState<{
    ok: boolean;
    statusText: string;
    engineStatus?: string;
    latencyMs?: number;
  } | null>(null);
  const [vpsFeedback, setVpsFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  // Master Engine Switches (Persisted in ai_config.json)
  const [switches, setSwitches] = useState<EngineSwitches>({ ...DEFAULT_ENGINE_SWITCHES });
  const [savingSwitchKey, setSavingSwitchKey] = useState<string | null>(null);

  // User & Access Key Management State
  const [licenses, setLicenses] = useState<LicenseRow[]>([]);
  const [licenseStats, setLicenseStats] = useState<LicenseStats>({
    total: 0,
    active: 0,
    expired: 0,
    revoked: 0,
  });
  const [isLoadingLicenses, setIsLoadingLicenses] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newTelegram, setNewTelegram] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newDuration, setNewDuration] = useState<'7d' | '30d'>('30d');
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [createdKeyBanner, setCreatedKeyBanner] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [licenseSearch, setLicenseSearch] = useState('');
  const [licenseStatusFilter, setLicenseStatusFilter] = useState<'ALL' | 'ACTIVE' | 'EXPIRED' | 'REVOKED'>('ALL');
  const [busyLicenseId, setBusyLicenseId] = useState<string | null>(null);
  const [licenseError, setLicenseError] = useState<string | null>(null);

  // Edge Node Telemetry Metrics
  const [cpuLoad, setCpuLoad] = useState(22);
  const [memLoad, setMemLoad] = useState(39);

  const activeConfiguredCount = useMemo(() => {
    return providers.filter((p) => {
      if (!p.enabled) return false;
      const cleanKey = (p.apiKey || '').trim();
      const isLoc =
        p.baseUrl.includes('localhost') ||
        p.baseUrl.includes('127.0.0.1') ||
        p.baseUrl.includes('0.0.0.0');
      return cleanKey.length >= 5 || (isLoc && p.lastTestOk === true);
    }).length;
  }, [providers]);

  // Load Central AI Config + Licenses with verified Admin Master Key
  const loadAdminData = useCallback(async (secretKey: string): Promise<boolean> => {
    if (!secretKey.trim()) return false;

    try {
      const licRes = await fetch('/api/license/admin', {
        method: 'GET',
        headers: { 'x-admin-key': secretKey },
        cache: 'no-store',
      });

      if (!licRes.ok) {
        return false;
      }

      const licData = await licRes.json();
      if (!licData.success) {
        return false;
      }

      const loadedLicenses: LicenseRow[] = Array.isArray(licData.licenses) ? licData.licenses : [];
      setLicenses(loadedLicenses);
      setLicenseStats(normalizeStatsPayload(licData.stats, loadedLicenses));

      // Fetch full Central Multi-AI & Oracle Kronos VPS config
      const aiRes = await fetch('/api/ai/judge', {
        method: 'GET',
        headers: { 'x-admin-key': secretKey },
        cache: 'no-store',
      });
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        if (aiData.success && aiData.config) {
          const cfg = aiData.config;
          if (Array.isArray(cfg.providers) && cfg.providers.length > 0) {
            setProviders(cfg.providers);
            const restoredPings: Record<string, ProviderPingState> = {};
            for (const slot of cfg.providers as AiProviderSlot[]) {
              if (typeof slot.lastTestOk === 'boolean') {
                restoredPings[slot.id] = {
                  testing: false,
                  ok: slot.lastTestOk,
                  latencyMs: slot.lastLatencyMs,
                  statusText: slot.lastTestOk
                    ? `CONNECTED (${slot.lastLatencyMs ?? 1}ms)`
                    : `FAILED (${slot.lastError || 'Verification error'})`,
                };
              }
            }
            setProviderPingMap(restoredPings);
          }
          if (typeof cfg.confidenceThreshold === 'number') {
            setConfidenceThreshold(cfg.confidenceThreshold);
          }
          if (cfg.kronosVpsUrl) setVpsUrl(cfg.kronosVpsUrl);
          if (cfg.kronosApiKey) setVpsApiKey(cfg.kronosApiKey);
          if (cfg.engineSwitches) {
            setSwitches({
              ...DEFAULT_ENGINE_SWITCHES,
              ...cfg.engineSwitches,
            });
          }
        }
      }

      await useTradingStore.getState().checkKronosHealth();
      return true;
    } catch {
      return false;
    }
  }, []);

  // Restore verified Admin session on mount
  useEffect(() => {
    let mounted = true;
    const initSession = async () => {
      try {
        if (typeof window === 'undefined') return;
        const savedKey = sessionStorage.getItem(ADMIN_SESSION_STORAGE_KEY);
        if (savedKey) {
          const ok = await loadAdminData(savedKey);
          if (ok && mounted) {
            setAdminKey(savedKey);
            setIsAuthenticated(true);
            useTradingStore
              .getState()
              .loadVaultOnStartup()
              .then(() => useTradingStore.getState().fetchAccountInfo());
            useBinanceStore.getState().loadSavedCredentials();
          } else if (mounted) {
            sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
          }
        }
      } finally {
        if (mounted) setIsCheckingSession(false);
      }
    };
    initSession();
    return () => {
      mounted = false;
    };
  }, [loadAdminData]);

  // Poll real-time Kronos / VPS health while Admin panel is unlocked
  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = setInterval(() => {
      useTradingStore.getState().checkKronosHealth();
      setCpuLoad((prev) => Math.max(14, Math.min(44, prev + (Math.random() > 0.5 ? 2 : -2))));
      setMemLoad((prev) => Math.max(33, Math.min(54, prev + (Math.random() > 0.5 ? 1 : -1))));
    }, 5000);
    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = loginInput.trim();
    if (!trimmed) {
      setLoginError('Enter the Admin Master Key.');
      return;
    }

    setIsLoggingIn(true);
    setLoginError(null);
    const ok = await loadAdminData(trimmed);
    if (ok) {
      setAdminKey(trimmed);
      setIsAuthenticated(true);
      setLoginInput('');
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(ADMIN_SESSION_STORAGE_KEY, trimmed);
      }
      useTradingStore
        .getState()
        .loadVaultOnStartup()
        .then(() => useTradingStore.getState().fetchAccountInfo());
      useBinanceStore.getState().loadSavedCredentials();
    } else {
      setLoginError('Invalid Admin Master Key. Access denied.');
    }
    setIsLoggingIn(false);
  };

  const handleAdminLogout = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
    }
    setAdminKey('');
    setIsAuthenticated(false);
    setAiFeedback(null);
    setVpsFeedback(null);
  };

  // --- Multi-AI Slot Updaters ---
  const updateProviderField = (
    id: string,
    patch: Partial<AiProviderSlot>
  ) => {
    setProviders((prev) =>
      prev.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot))
    );
  };

  const handleTestProviderSlot = async (slot: AiProviderSlot) => {
    setProviderPingMap((prev) => ({
      ...prev,
      [slot.id]: { testing: true },
    }));
    try {
      const res = await fetch('/api/ai/judge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'TEST_PROVIDER',
          providerId: slot.id,
          baseUrl: slot.baseUrl.trim(),
          model: slot.model.trim(),
          apiKey: slot.apiKey.trim(),
        }),
      });
      const data = await res.json();
      const ok = Boolean(data.success);
      const latencyMs = Number(data.latencyMs ?? 0);
      const statusText =
        data.statusText ||
        (ok
          ? `CONNECTED (${latencyMs}ms)`
          : `FAILED (${data.errorReason || data.message || 'Verification failed'})`);

      setProviderPingMap((prev) => ({
        ...prev,
        [slot.id]: {
          testing: false,
          ok,
          latencyMs,
          statusText,
        },
      }));

      updateProviderField(slot.id, {
        lastTestedAt: Date.now(),
        lastTestOk: ok,
        lastLatencyMs: latencyMs,
        lastError: ok ? '' : statusText,
      });

      await checkKronosHealth();
    } catch (err: any) {
      const reason = err?.message || 'Network error';
      setProviderPingMap((prev) => ({
        ...prev,
        [slot.id]: {
          testing: false,
          ok: false,
          statusText: `FAILED (${reason})`,
        },
      }));
    }
  };

  const handleFetchSlotModels = async (slot: AiProviderSlot) => {
    setFetchingModelsId(slot.id);
    try {
      const res = await fetch('/api/ai/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          providerId: slot.id,
          baseUrl: slot.baseUrl.trim(),
          apiKey: slot.apiKey.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.models) && data.models.length > 0) {
        setProviderModelsMap((prev) => ({ ...prev, [slot.id]: data.models }));
        if (!data.models.includes(slot.model)) {
          updateProviderField(slot.id, { model: data.models[0] });
        }
        setAiFeedback({
          ok: true,
          text: `Loaded ${data.models.length} models from ${slot.name}.`,
        });
      } else {
        setAiFeedback({
          ok: false,
          text: data.message || `Could not auto-fetch model list for ${slot.name}; enter Model ID directly.`,
        });
      }
    } catch (err: any) {
      setAiFeedback({
        ok: false,
        text: err?.message || 'Failed to fetch model list.',
      });
    } finally {
      setFetchingModelsId(null);
    }
  };

  const handleSaveAiConfig = async () => {
    setIsSavingAi(true);
    setAiFeedback(null);
    try {
      const res = await fetch('/api/ai/judge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'SAVE_CONFIG',
          providers,
          confidenceThreshold,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.config?.providers) {
          setProviders(data.config.providers);
        }
        setAiFeedback({
          ok: true,
          text:
            data.message ||
            'Central Multi-AI Provider Slots saved and routed to Forex & Crypto Risk Governance.',
        });
        await checkKronosHealth();
      } else {
        setAiFeedback({
          ok: false,
          text: data.error || data.message || 'Failed to save AI configuration.',
        });
      }
    } catch (err: any) {
      setAiFeedback({
        ok: false,
        text: err?.message || 'Error saving AI configuration.',
      });
    } finally {
      setIsSavingAi(false);
    }
  };

  // --- Oracle VPS Kronos Handlers ---
  const handlePingVps = async () => {
    setIsPingingVps(true);
    setVpsFeedback(null);
    try {
      const res = await fetch('/api/ai/judge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'TEST_VPS',
          kronosVpsUrl: vpsUrl.trim(),
          kronosApiKey: vpsApiKey.trim(),
        }),
      });
      const data = await res.json();
      const ok = Boolean(data.success && data.vpsReady);
      const latencyMs = Number(data.latencyMs ?? 0);
      const engineStatus = String(data.engineStatus || (ok ? 'kronos-neural-ready' : 'offline'));
      const statusText =
        data.statusText ||
        (ok
          ? `CONNECTED · ${engineStatus} (${latencyMs}ms)`
          : `FAILED (${data.message || 'Unreachable'})`);

      setVpsPingBadge({
        ok,
        statusText,
        engineStatus,
        latencyMs,
      });
      setVpsFeedback({
        ok,
        text: data.message || statusText,
      });
      await checkKronosHealth();
    } catch (err: any) {
      const reason = err?.message || 'Failed to probe Oracle Kronos VPS.';
      setVpsPingBadge({
        ok: false,
        statusText: `FAILED (${reason})`,
      });
      setVpsFeedback({
        ok: false,
        text: `FAILED (${reason})`,
      });
    } finally {
      setIsPingingVps(false);
    }
  };

  const handleSaveVpsConfig = async () => {
    setIsSavingVps(true);
    setVpsFeedback(null);
    try {
      const res = await fetch('/api/ai/judge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'SAVE_CONFIG',
          kronosVpsUrl: vpsUrl.trim(),
          kronosApiKey: vpsApiKey.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setVpsFeedback({
          ok: true,
          text: `Saved Oracle Kronos VPS endpoint (${vpsUrl.trim()}) & secret key.`,
        });
        await checkKronosHealth();
      } else {
        setVpsFeedback({
          ok: false,
          text: data.error || 'Failed to save VPS configuration.',
        });
      }
    } catch (err: any) {
      setVpsFeedback({
        ok: false,
        text: err?.message || 'Error saving VPS configuration.',
      });
    } finally {
      setIsSavingVps(false);
    }
  };

  // --- Master Engine Switch Handler ---
  const handleToggleSwitch = async (key: keyof EngineSwitches) => {
    const nextVal = !switches[key];
    const nextSwitches: EngineSwitches = {
      ...switches,
      [key]: nextVal,
    };
    setSwitches(nextSwitches);
    setSavingSwitchKey(key);

    try {
      await fetch('/api/ai/judge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'SAVE_CONFIG',
          engineSwitches: nextSwitches,
        }),
      });

      if (key === 'emergencyKillSwitch' && nextVal) {
        if (isAutoTrading) {
          await toggleAutoTrading(false);
        }
        useBinanceStore.getState().setIsAutoTrading(false);
      }
      if (key === 'localEaExecutor' && !nextVal && isAutoTrading) {
        await toggleAutoTrading(false);
      }
      await checkKronosHealth();
    } finally {
      setSavingSwitchKey(null);
    }
  };

  // --- User & Access Key Management Handlers ---
  const refreshLicenses = async () => {
    setIsLoadingLicenses(true);
    setLicenseError(null);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'GET',
        headers: { 'x-admin-key': adminKey },
        cache: 'no-store',
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const list: LicenseRow[] = Array.isArray(data.licenses) ? data.licenses : [];
        setLicenses(list);
        setLicenseStats(normalizeStatsPayload(data.stats, list));
      } else {
        setLicenseError(data.error || 'Failed to refresh licenses.');
      }
    } catch (err: any) {
      setLicenseError(err?.message || 'Network error loading licenses.');
    } finally {
      setIsLoadingLicenses(false);
    }
  };

  const handleCreateLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim() && !newTelegram.trim()) {
      setLicenseError('Username or Telegram handle is required.');
      return;
    }

    setIsCreatingKey(true);
    setLicenseError(null);
    setCreatedKeyBanner(null);

    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action: 'CREATE',
          username: newUsername.trim() || newTelegram.trim(),
          telegram: newTelegram.trim() || newUsername.trim(),
          email: newEmail.trim() || undefined,
          duration: newDuration,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.license) {
        setCreatedKeyBanner(data.license.licenseKey);
        setNewUsername('');
        setNewTelegram('');
        setNewEmail('');
        await refreshLicenses();
      } else {
        setLicenseError(data.error || 'Failed to issue access key.');
      }
    } catch (err: any) {
      setLicenseError(err?.message || 'Error issuing access key.');
    } finally {
      setIsCreatingKey(false);
    }
  };

  const handleLicenseAction = async (
    id: string,
    action: 'EXTEND' | 'REVOKE' | 'DELETE',
    days?: number
  ) => {
    setBusyLicenseId(id);
    setLicenseError(null);
    try {
      const res = await fetch('/api/license/admin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': adminKey,
        },
        body: JSON.stringify({
          action,
          id,
          days,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        await refreshLicenses();
      } else {
        setLicenseError(data.error || `Action ${action} failed.`);
      }
    } catch (err: any) {
      setLicenseError(err?.message || `Network error on ${action}.`);
    } finally {
      setBusyLicenseId(null);
    }
  };

  const handleCopyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {}
  };

  const filteredLicenses = useMemo(() => {
    return licenses.filter((item) => {
      if (licenseStatusFilter !== 'ALL' && item.status !== licenseStatusFilter) {
        return false;
      }
      if (licenseSearch.trim()) {
        const q = licenseSearch.trim().toLowerCase();
        return (
          item.licenseKey.toLowerCase().includes(q) ||
          item.username.toLowerCase().includes(q) ||
          item.telegram.toLowerCase().includes(q) ||
          (item.email || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [licenses, licenseStatusFilter, licenseSearch]);

  const masterSwitchItems: {
    key: keyof EngineSwitches;
    label: string;
    sub: string;
    danger?: boolean;
  }[] = [
    {
      key: 'kronosForecaster',
      label: 'Tier 1: Kronos K-Line Forecaster (Oracle VPS / Local Quant)',
      sub: 'Probabilistic OHLCV horizon & Volume Profile (POC / VAH / VAL) distribution',
    },
    {
      key: 'multiAiRiskJudge',
      label: 'Tier 2: Multi-AI Consensus / Risk Governance',
      sub: 'Parallel multi-provider LLM consensus + automatic quota failover',
    },
    {
      key: 'localEaExecutor',
      label: 'Tier 3: Autonomous EA Executor (3-Stage Trailing Stop)',
      sub: 'Partial profit lock + Breakeven guard + ATR trailing execution',
    },
    {
      key: 'exnessWebSocket',
      label: 'Exness Tick Stream (/ws/events & /ws/ticks)',
      sub: 'Low-latency real-time quote ingestion & order synchronization',
    },
    {
      key: 'restMutexQueue',
      label: 'Global REST Rate-Limit Mutex Queue (1200ms Guard)',
      sub: 'Prevents HTTP 429 burst throttling on trading access points',
    },
    {
      key: 'emergencyKillSwitch',
      label: 'Emergency Kill-Switch (Halt All Autonomous Entries)',
      sub: 'Immediately blocks new autonomous Forex & Crypto market entries',
      danger: true,
    },
  ];

  // Loading session splash
  if (isCheckingSession) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] dark:bg-slate-950 flex items-center justify-center p-4 text-[#0F172A] dark:text-slate-100 transition-colors">
        <div className="bg-white dark:bg-zinc-900 border border-slate-200/90 dark:border-zinc-800 rounded-2xl px-6 py-5 shadow-xs flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 animate-spin" />
          <span className="font-mono text-xs text-slate-600 dark:text-slate-300">
            Verifying Administrator clearance...
          </span>
        </div>
      </div>
    );
  }

  // Unauthenticated: Institutional Admin Login Screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col justify-between bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 transition-colors">
        <header className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-zinc-800 sticky top-0 z-40">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-sm">
                NX
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-sans font-bold text-[#0F172A] dark:text-slate-100 text-sm sm:text-base tracking-tight">
                    NEMESIS x Trade
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-900 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-zinc-700 font-semibold">
                    ADMINISTRATION
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono hidden sm:block">
                  Centralized Multi-AI Consensus, Oracle Kronos VPS &amp; Access Key Governance
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle showLabel />
              <Link
                href="/"
                className="bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white rounded-xl px-3.5 py-2 text-xs font-mono font-semibold transition-all flex items-center gap-1.5"
              >
                <Terminal className="w-3.5 h-3.5 text-emerald-400 dark:text-white" />
                <span>Client Terminal</span>
              </Link>
            </div>
          </div>
        </header>

        <main className="flex-1 flex items-center justify-center px-4 py-10">
          <div className="w-full max-w-md bg-white dark:bg-zinc-900/95 border border-slate-200/90 dark:border-zinc-800 rounded-2xl p-6 sm:p-7 shadow-[0_4px_24px_rgba(15,23,42,0.05)] dark:shadow-black/40 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 font-semibold">
                  <Lock className="w-3 h-3" />
                  <span>ROOT NODE CLEARANCE</span>
                </div>
                <h1 className="font-sans font-bold text-xl text-[#0F172A] dark:text-slate-100 tracking-tight">
                  Administrator Login
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Authenticate with your Admin Master Key to configure Multi-AI providers, Oracle Kronos VPS endpoints, and user access keys.
                </p>
              </div>
              <div className="w-11 h-11 rounded-2xl bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 flex items-center justify-center shrink-0">
                <Server className="w-5 h-5 text-[#0F172A] dark:text-emerald-400" />
              </div>
            </div>

            {loginError && (
              <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 flex items-center gap-2 text-rose-700 dark:text-rose-300 text-xs font-medium">
                <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label className="block font-mono text-[11px] uppercase tracking-wider font-semibold text-slate-600 dark:text-slate-300">
                  ADMIN MASTER KEY <span className="text-emerald-600 dark:text-emerald-400">*</span>
                </label>
                <div className="relative">
                  <input
                    type={showLoginKey ? 'text' : 'password'}
                    value={loginInput}
                    onChange={(e) => setLoginInput(e.target.value)}
                    placeholder="Enter Admin Master Key"
                    disabled={isLoggingIn}
                    className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-4 py-3 pr-10 font-mono text-sm text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginKey(!showLoginKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                  >
                    {showLoginKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoggingIn || !loginInput.trim()}
                className="w-full bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-sans font-bold text-xs sm:text-sm py-3.5 px-4 rounded-xl shadow-xs transition-all flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400 dark:text-white" />
                    <span>Authenticating Root Node...</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-4 h-4 text-emerald-400 dark:text-white" />
                    <span>Unlock Admin Dashboard</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </main>

        <InstitutionalFooter />
      </div>
    );
  }

  const liveAccountNumber = accountInfo?.accountNumber || '30000143146';
  const liveBalance = balance ?? accountInfo?.balance;
  const liveEquity = equity ?? accountInfo?.equity ?? liveBalance;
  const isVpsOnline = Boolean(kronosHealth?.vpsReady);
  const isKronosOnline = Boolean(kronosHealth?.kronosReady);
  const isAiOnline = Boolean(kronosHealth?.aiReady || activeConfiguredCount > 0);

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] dark:bg-slate-950 text-[#0F172A] dark:text-slate-100 transition-colors">
      {/* Sticky Top Header */}
      <header className="bg-white/95 dark:bg-slate-950/95 backdrop-blur-md border-b border-slate-200/90 dark:border-zinc-800 sticky top-0 z-40">
        <div className="max-w-[1920px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="w-9 h-9 rounded-xl bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-sm shrink-0"
            >
              NX
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm sm:text-base">
                  NMSSx Infrastructure &amp; Multi-AI Administration
                </h1>
                <span className="hidden sm:inline-flex items-center gap-1.5 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200/80 dark:border-emerald-500/30 px-2.5 py-0.5 rounded-full text-[11px] font-mono font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" />
                  ROOT UNLOCKED
                </span>
              </div>
              <p className="text-slate-500 dark:text-slate-400 text-xs font-mono hidden sm:block">
                Exclusive Multi-AI Consensus Control · Oracle Kronos VPS · Client Access Keys
              </p>
            </div>
          </div>

          {/* Live Health Badges + Theme Toggle + Navigation + Lock Button */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-50 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 font-mono text-[11px]">
              <span
                className={`px-2 py-0.5 rounded font-semibold border ${
                  isKronosOnline
                    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                    : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30'
                }`}
              >
                {isKronosOnline ? '● Kronos Ready' : '○ Kronos Offline'}
              </span>
              <span
                className={`px-2 py-0.5 rounded font-semibold border ${
                  isVpsOnline
                    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                    : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30'
                }`}
              >
                {isVpsOnline
                  ? `● VPS Ready (${kronosHealth?.latencyMs ?? 12}ms)`
                  : '○ VPS Offline'}
              </span>
              <span
                className={`px-2 py-0.5 rounded font-semibold border ${
                  isAiOnline
                    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                    : 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30'
                }`}
              >
                {isAiOnline
                  ? `● AI Ready (${activeConfiguredCount || kronosHealth?.activeAiCount || 1} Active)`
                  : '○ AI Unconfigured'}
              </span>
            </div>

            <ThemeToggle showLabel />

            <Link
              href="/"
              className="bg-[#0F172A] dark:bg-zinc-800 hover:bg-[#1E293B] dark:hover:bg-zinc-700 text-white font-medium rounded-xl px-3.5 py-2 text-xs shadow-xs transition-all flex items-center gap-1.5 border border-transparent dark:border-zinc-700"
            >
              <Terminal className="w-3.5 h-3.5 text-emerald-400" />
              <span>Client Terminal</span>
            </Link>

            <button
              type="button"
              onClick={handleAdminLogout}
              className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-200 dark:hover:border-rose-500/40 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-xl px-3 py-2 text-xs font-mono font-semibold transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Lock Admin</span>
            </button>
          </div>
        </div>
      </header>

      {/* Responsive Admin Shell */}
      <div className="flex-1 flex max-w-[1920px] w-full mx-auto">
        {/* Left Sidebar Navigation */}
        <aside className="hidden xl:flex w-64 border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 flex-col justify-between p-4 shrink-0 select-none">
          <div className="space-y-6">
            <div className="space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 px-2">
                ADMINISTRATION MODULES
              </div>
              <nav className="space-y-1 pt-1">
                {(
                  [
                    { id: 'ALL', label: 'All Control Modules', icon: Server },
                    { id: 'AI_VPS', label: 'Multi-AI & Kronos VPS', icon: BrainCircuit },
                    { id: 'LICENSES', label: 'Users & Access Keys', icon: Users },
                    { id: 'GOVERNANCE', label: 'Engine Switches & Nodes', icon: Sliders },
                  ] as const
                ).map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full px-3 py-2.5 rounded-xl text-xs font-medium flex items-center justify-between transition-all cursor-pointer ${
                        active
                          ? 'bg-[#0F172A] dark:bg-emerald-500/15 text-white dark:text-emerald-300 dark:border dark:border-emerald-500/30 shadow-2xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-zinc-800/70'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          className={`w-4 h-4 ${
                            active ? 'text-emerald-400' : 'text-slate-400 dark:text-zinc-500'
                          }`}
                        />
                        <span>{tab.label}</span>
                      </span>
                      {active && <span className="w-2 h-2 rounded-full bg-[#10B981]" />}
                    </button>
                  );
                })}

                <div className="pt-2 border-t border-slate-100 dark:border-zinc-800 mt-2">
                  <Link
                    href="/"
                    className="w-full px-3 py-2.5 rounded-xl text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-zinc-800/70 text-xs font-medium flex items-center justify-between transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-slate-400 dark:text-zinc-500" />
                      <span>Open Client Terminal</span>
                    </span>
                    <ArrowUpRight className="w-3.5 h-3.5 text-slate-400" />
                  </Link>
                </div>
              </nav>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 space-y-2 font-mono text-xs">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                EDGE RUNTIME TELEMETRY
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Node CPU:</span>
                <span className="font-bold text-[#0F172A] dark:text-slate-100">{cpuLoad}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500 dark:text-slate-400">Heap Guard:</span>
                <span className="font-bold text-emerald-700 dark:text-emerald-400">{memLoad}%</span>
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 space-y-1.5 font-mono text-[11px]">
            <div className="text-slate-400 dark:text-zinc-500 text-[10px] uppercase">CENTRAL CONFIG STORE</div>
            <div className="text-[#0F172A] dark:text-slate-200 font-semibold">data/ai_config.json</div>
            <div className="text-emerald-700 dark:text-emerald-400 text-[10px]">Admin-Only Zero-Leak Guard</div>
          </div>
        </aside>

        {/* Main Admin Workspace */}
        <main className="flex-1 p-4 sm:p-6 space-y-6 min-w-0">
          {/* Mobile / Tablet Module Switcher */}
          <div className="xl:hidden flex flex-wrap gap-1.5 bg-white dark:bg-zinc-900 p-1.5 rounded-2xl border border-slate-200/90 dark:border-zinc-800 font-mono text-xs">
            {(
              [
                { id: 'ALL', label: 'All' },
                { id: 'AI_VPS', label: 'Multi-AI & VPS' },
                { id: 'LICENSES', label: 'Access Keys' },
                { id: 'GOVERNANCE', label: 'Governance' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-xl font-semibold transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? 'bg-[#0F172A] dark:bg-emerald-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-zinc-800'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* SECTION 1: CENTRALIZED MULTI-AI PROVIDER SLOTS & ORACLE VPS KRONOS */}
          {(activeTab === 'ALL' || activeTab === 'AI_VPS') && (
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* 1A. Flexible Multi-AI Provider Slots + Live Test Connection (8 cols) */}
              <div className="lg:col-span-8 bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-zinc-800">
                  <div>
                    <div className="flex items-center gap-2">
                      <BrainCircuit className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm sm:text-base uppercase">
                        Multi-AI Consensus / Risk Governance Provider Slots
                      </h2>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Connect 1 or multiple AI providers simultaneously. Active connected models run in parallel (`Promise.allSettled`) with automatic quota/rate-limit failover to Kronos Quant Engine.
                    </p>
                  </div>

                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-mono font-semibold border ${
                      activeConfiguredCount > 0
                        ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                        : 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30'
                    }`}
                  >
                    {activeConfiguredCount > 0
                      ? `${activeConfiguredCount} PROVIDER${activeConfiguredCount > 1 ? 'S' : ''} ACTIVE`
                      : 'QUANT FALLBACK MODE'}
                  </span>
                </div>

                {/* 1. Interactive Provider Logo Grid / Dock + Quick Dropdown Header */}
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-500 dark:text-zinc-400">
                        Provider Selector Dock
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300 border border-slate-200/80 dark:border-zinc-700">
                        {providers.length} Available
                      </span>
                    </div>

                    {/* 2. Quick Provider Dropdown (Alternative Selector) */}
                    <div className="flex items-center gap-1.5">
                      <label htmlFor="quick-provider-dropdown" className="text-[11px] font-mono text-slate-400 dark:text-zinc-500 hidden sm:inline">
                        Quick Jump:
                      </label>
                      <select
                        id="quick-provider-dropdown"
                        value={activeSlot?.id || selectedProviderId}
                        onChange={(e) => setSelectedProviderId(e.target.value)}
                        className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg px-2.5 py-1 text-xs font-mono text-[#0F172A] dark:text-slate-200 cursor-pointer focus:outline-none focus:border-emerald-500 shadow-xs"
                      >
                        {providers.map((p) => {
                          const meta = PROVIDER_META[p.id] || { shortName: p.name };
                          const isReady = p.enabled && (p.apiKey || '').trim().length >= 5;
                          return (
                            <option key={p.id} value={p.id}>
                              {meta.shortName} {isReady ? '● (Active)' : '○ (Inactive)'}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                  </div>

                  {/* Horizontal / Grid Logo Dock */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
                    {providers.map((slot) => {
                      const isSelected = (activeSlot?.id || selectedProviderId) === slot.id;
                      const hasKey = (slot.apiKey || '').trim().length >= 5;
                      const isReady = slot.enabled && hasKey;
                      const meta = PROVIDER_META[slot.id] || {
                        shortName: slot.name,
                        brandColor: 'text-emerald-500',
                      };

                      return (
                        <button
                          key={slot.id}
                          type="button"
                          onClick={() => setSelectedProviderId(slot.id)}
                          className={`flex flex-col items-center justify-center p-2.5 rounded-xl border text-center transition-all cursor-pointer relative group ${
                            isSelected
                              ? 'bg-emerald-50/70 dark:bg-emerald-950/25 border-emerald-500 dark:border-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.22)] ring-1 ring-emerald-500/40 text-[#0F172A] dark:text-slate-100'
                              : 'bg-[#F8FAFC]/80 dark:bg-zinc-950/50 border-slate-200/90 dark:border-zinc-800 hover:border-slate-300 dark:hover:border-zinc-700 hover:bg-slate-100/70 dark:hover:bg-zinc-800/40 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          {/* Top-Right Status Dot (Emerald if active/ready, slate if inactive) */}
                          <span className="absolute top-2 right-2 flex items-center justify-center">
                            <span
                              className={`w-2 h-2 rounded-full transition-all ${
                                isReady
                                  ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.8)]'
                                  : 'bg-slate-300 dark:bg-zinc-600'
                              }`}
                              title={isReady ? 'Active & Key Configured' : 'Inactive or Missing Key'}
                            />
                          </span>

                          {/* Distinct Crisp Inline SVG Brand Logo */}
                          <div
                            className={`p-2 rounded-lg transition-transform group-hover:scale-105 ${
                              isSelected
                                ? 'bg-white dark:bg-zinc-900 shadow-xs ' + meta.brandColor
                                : 'text-slate-500 dark:text-zinc-400 group-hover:text-slate-800 dark:group-hover:text-slate-200'
                            }`}
                          >
                            {renderProviderLogo(slot.id, 'w-5 h-5')}
                          </div>

                          {/* Short Name */}
                          <span className="font-sans font-bold text-xs tracking-tight mt-1.5 truncate max-w-full">
                            {meta.shortName}
                          </span>

                          {/* State subtitle */}
                          <span className="font-mono text-[9px] uppercase tracking-wider text-slate-400 dark:text-zinc-500 mt-0.5">
                            {slot.enabled ? 'Enabled' : 'Disabled'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* 3. Single Dynamic Configuration Card (Currently Selected Provider) */}
                {activeSlot && (() => {
                  const slot = activeSlot;
                  const pingState = providerPingMap[slot.id];
                  const showKey = Boolean(visibleProviderKeys[slot.id]);
                  const hints = PROVIDER_MODEL_HINTS[slot.id] || [];
                  const fetchedModels = providerModelsMap[slot.id] || [];
                  const hasKey = (slot.apiKey || '').trim().length >= 5;
                  const meta = PROVIDER_META[slot.id] || {
                    shortName: slot.name,
                    brandColor: 'text-emerald-500',
                  };

                  return (
                    <div
                      className={`p-4 sm:p-5 rounded-2xl border transition-all space-y-4 shadow-xs ${
                        slot.enabled && hasKey
                          ? 'bg-emerald-50/20 dark:bg-emerald-500/[0.03] border-emerald-300/80 dark:border-emerald-500/40'
                          : 'bg-[#F8FAFC] dark:bg-slate-950/70 border-slate-200/90 dark:border-zinc-800'
                      }`}
                    >
                      {/* Active Slot Header */}
                      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200/70 dark:border-zinc-800">
                        <div className="flex items-center gap-3">
                          <div
                            className={`p-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xs ${meta.brandColor}`}
                          >
                            {renderProviderLogo(slot.id, 'w-6 h-6')}
                          </div>
                          <div>
                            <div className="flex items-center gap-2.5">
                              <span className="font-sans font-bold text-sm sm:text-base text-[#0F172A] dark:text-slate-100">
                                {slot.name}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  updateProviderField(slot.id, { enabled: !slot.enabled })
                                }
                                className={`px-2.5 py-0.5 rounded-md font-mono text-[10px] font-bold border transition-all cursor-pointer ${
                                  slot.enabled
                                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs'
                                    : 'bg-slate-200 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-300 dark:border-zinc-700'
                                }`}
                              >
                                {slot.enabled ? 'ENABLED' : 'DISABLED'}
                              </button>
                            </div>
                            <p className="text-[11px] font-mono text-slate-400 dark:text-zinc-500 mt-0.5">
                              Provider Slot: <span className="font-semibold text-slate-600 dark:text-zinc-400">{slot.id}</span>
                              {slot.lastTestedAt && (
                                <span className="ml-2">
                                  • Last verified: {new Date(slot.lastTestedAt).toLocaleTimeString()}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {pingState?.statusText && (
                            <span
                              className={`px-2.5 py-1 rounded-lg font-mono text-[11px] font-semibold border ${
                                pingState.ok
                                  ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                                  : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
                              }`}
                            >
                              {pingState.statusText}
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={() => handleTestProviderSlot(slot)}
                            disabled={pingState?.testing}
                            className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 hover:bg-slate-100 dark:hover:bg-zinc-800 text-[#0F172A] dark:text-slate-200 font-mono font-semibold rounded-lg px-3 py-1.5 text-xs transition-all inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-xs"
                          >
                            {pingState?.testing ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-500" />
                            ) : (
                              <Zap className="w-3.5 h-3.5 text-emerald-500" />
                            )}
                            <span>{pingState?.testing ? 'Pinging Provider...' : 'Test Connection'}</span>
                          </button>
                        </div>
                      </div>

                      {/* Inputs Grid */}
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 font-mono text-xs">
                        {/* API Key Input */}
                        <div className="md:col-span-5 space-y-1.5">
                          <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                            API Key
                          </label>
                          <div className="relative">
                            <input
                              type={showKey ? 'text' : 'password'}
                              value={slot.apiKey}
                              onChange={(e) =>
                                updateProviderField(slot.id, { apiKey: e.target.value })
                              }
                              placeholder={`Enter ${slot.name.split(' ')[0]} API Key`}
                              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 pr-9 text-xs text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-[#0F172A] dark:focus:border-emerald-500"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setVisibleProviderKeys((prev) => ({
                                  ...prev,
                                  [slot.id]: !prev[slot.id],
                                }))
                              }
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                            >
                              {showKey ? (
                                <EyeOff className="w-3.5 h-3.5" />
                              ) : (
                                <Eye className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Custom Model ID Input */}
                        <div className="md:col-span-4 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <label className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                              Model ID
                            </label>
                            <button
                              type="button"
                              onClick={() => handleFetchSlotModels(slot)}
                              disabled={fetchingModelsId === slot.id}
                              className="text-[10px] text-emerald-700 dark:text-emerald-400 hover:underline font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            >
                              <RefreshCw
                                className={`w-2.5 h-2.5 ${
                                  fetchingModelsId === slot.id ? 'animate-spin' : ''
                                }`}
                              />
                              <span>Fetch</span>
                            </button>
                          </div>
                          <input
                            type="text"
                            value={slot.model}
                            onChange={(e) =>
                              updateProviderField(slot.id, { model: e.target.value })
                            }
                            placeholder="Custom Model ID"
                            className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs text-[#0F172A] dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-[#0F172A] dark:focus:border-emerald-500"
                          />
                          {fetchedModels.length > 0 ? (
                            <select
                              value={slot.model}
                              onChange={(e) =>
                                updateProviderField(slot.id, { model: e.target.value })
                              }
                              className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-2 py-1 text-[11px] text-[#0F172A] dark:text-slate-200"
                            >
                              {fetchedModels.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          ) : (
                            hints.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-0.5">
                                {hints.map((h) => (
                                  <button
                                    key={h}
                                    type="button"
                                    onClick={() => updateProviderField(slot.id, { model: h })}
                                    className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors cursor-pointer ${
                                      slot.model === h
                                        ? 'bg-[#0F172A] dark:bg-emerald-600 text-white border-transparent'
                                        : 'bg-white dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 border-slate-200 dark:border-zinc-800 hover:text-[#0F172A] dark:hover:text-slate-200'
                                    }`}
                                  >
                                    {h}
                                  </button>
                                ))}
                              </div>
                            )
                          )}
                        </div>

                        {/* Provider Base URL */}
                        <div className="md:col-span-3 space-y-1.5">
                          <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                            Endpoint Base URL
                          </label>
                          <input
                            type="text"
                            value={slot.baseUrl}
                            onChange={(e) =>
                              updateProviderField(slot.id, { baseUrl: e.target.value })
                            }
                            placeholder="https://api..."
                            className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300 focus:outline-none focus:border-[#0F172A] dark:focus:border-emerald-500"
                          />
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Compact Ensemble Summary Bar */}
                <div className="p-3 rounded-xl bg-slate-50 dark:bg-zinc-950/60 border border-slate-200/80 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-bold">
                      Active Consensus Ensemble:
                    </span>
                    {activeConfiguredCount > 0 ? (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-bold border border-emerald-500/20">
                        {activeConfiguredCount} OF {providers.length} ROUTED
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 font-bold border border-amber-500/20">
                        QUANT FALLBACK (NO ACTIVE LLMS)
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {providers.map((p) => {
                      const isReady =
                        p.enabled &&
                        ((p.apiKey || '').trim().length >= 5 ||
                          p.baseUrl.includes('127.0.0.1') ||
                          p.baseUrl.includes('localhost'));
                      const meta = PROVIDER_META[p.id] || {
                        shortName: p.name,
                        brandColor: 'text-slate-400',
                      };
                      const isSelected = (activeSlot?.id || selectedProviderId) === p.id;

                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedProviderId(p.id)}
                          title={`Click to configure ${meta.shortName}`}
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono font-medium border transition-all cursor-pointer ${
                            isReady
                              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
                              : 'bg-slate-100/70 dark:bg-zinc-900 border-slate-200 dark:border-zinc-800 text-slate-400 dark:text-zinc-500 opacity-60'
                          } ${isSelected ? 'ring-1 ring-emerald-500 font-bold shadow-xs' : ''}`}
                        >
                          <span
                            className={
                              isReady ? meta.brandColor : 'text-slate-400 dark:text-zinc-600'
                            }
                          >
                            {renderProviderLogo(p.id, 'w-3 h-3')}
                          </span>
                          <span>{meta.shortName}</span>
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              isReady ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-zinc-700'
                            }`}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Confidence Threshold + Save Action */}
                <div className="pt-3 border-t border-slate-100 dark:border-zinc-800 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 min-w-[220px] max-w-sm font-mono text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                          Multi-AI Minimum Confidence Threshold
                        </label>
                        <span className="font-bold text-[#0F172A] dark:text-emerald-400">
                          {confidenceThreshold}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="50"
                        max="95"
                        step="1"
                        value={confidenceThreshold}
                        onChange={(e) => setConfidenceThreshold(parseInt(e.target.value, 10))}
                        className="w-full accent-emerald-600 cursor-pointer"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleSaveAiConfig}
                      disabled={isSavingAi}
                      className="bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-semibold rounded-xl px-5 py-2.5 text-xs shadow-xs transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5 text-emerald-400 dark:text-white" />
                      <span>{isSavingAi ? 'Saving Providers...' : 'Save Multi-AI Configuration'}</span>
                    </button>
                  </div>

                  {aiFeedback && (
                    <div
                      className={`p-2.5 rounded-xl border text-xs font-mono flex items-start gap-2 ${
                        aiFeedback.ok
                          ? 'bg-emerald-50/80 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                          : 'bg-rose-50 dark:bg-rose-500/15 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {aiFeedback.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <span>{aiFeedback.text}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* 1B. Oracle VPS Kronos Node Configuration + Live Test Connection (4 cols) */}
              <div className="lg:col-span-4 bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 sm:p-6 flex flex-col justify-between space-y-4">
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-zinc-800">
                    <span className="font-sans font-bold text-sm sm:text-base uppercase tracking-tight text-[#0F172A] dark:text-slate-100 flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      Oracle VPS Kronos Node
                    </span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold flex items-center gap-1.5 border ${
                        isVpsOnline
                          ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                          : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30'
                      }`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isVpsOnline ? 'bg-[#10B981] animate-pulse' : 'bg-rose-500'
                        }`}
                      />
                      {isVpsOnline
                        ? `${kronosHealth?.engineStatus || 'kronos-neural-ready'} (${kronosHealth?.latencyMs ?? 12}ms)`
                        : 'VPS OFFLINE'}
                    </span>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    Centralized FastAPI Kronos Neural K-Line Forecasting engine (`GET /health` &amp; `POST /v1/predict`) computing Volume Profile (`POC`, `VAH`, `VAL`), `RSI`, `Z-Score`, and `Regime`.
                  </p>

                  <div className="space-y-3 font-mono text-xs">
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                        Oracle VPS Kronos URL
                      </label>
                      <input
                        type="text"
                        value={vpsUrl}
                        onChange={(e) => setVpsUrl(e.target.value)}
                        placeholder="http://127.0.0.1:8000"
                        className="w-full rounded-xl bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs text-[#0F172A] dark:text-slate-100 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                        Kronos Secret Key (`X-API-Key`)
                      </label>
                      <div className="relative">
                        <input
                          type={showVpsKey ? 'text' : 'password'}
                          value={vpsApiKey}
                          onChange={(e) => setVpsApiKey(e.target.value)}
                          placeholder="nmssx-kronos-secret-2026"
                          className="w-full rounded-xl bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 px-3 py-2 pr-9 text-xs text-[#0F172A] dark:text-slate-100 focus:outline-none focus:bg-white dark:focus:bg-slate-950 focus:border-[#0F172A] dark:focus:border-emerald-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowVpsKey(!showVpsKey)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                        >
                          {showVpsKey ? (
                            <EyeOff className="w-3.5 h-3.5" />
                          ) : (
                            <Eye className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  {vpsPingBadge && (
                    <div
                      className={`px-3 py-2 rounded-xl border font-mono text-xs font-semibold flex items-center justify-between gap-2 ${
                        vpsPingBadge.ok
                          ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                          : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-200 dark:border-rose-500/30'
                      }`}
                    >
                      <span className="truncate">{vpsPingBadge.statusText}</span>
                      {vpsPingBadge.latencyMs !== undefined && (
                        <span className="shrink-0">{vpsPingBadge.latencyMs}ms</span>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2.5 pt-2 border-t border-slate-100 dark:border-zinc-800">
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={handlePingVps}
                      disabled={isPingingVps || isSavingVps}
                      className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-[#0F172A] dark:text-slate-100 font-semibold rounded-xl px-3 py-2.5 text-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Zap
                        className={`w-3.5 h-3.5 text-emerald-500 ${
                          isPingingVps ? 'animate-pulse' : ''
                        }`}
                      />
                      <span>{isPingingVps ? 'Testing...' : 'Test Connection'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleSaveVpsConfig}
                      disabled={isSavingVps || isPingingVps}
                      className="bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-semibold rounded-xl px-3 py-2.5 text-xs shadow-xs transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5 text-emerald-400 dark:text-white" />
                      <span>{isSavingVps ? 'Saving...' : 'Save VPS Config'}</span>
                    </button>
                  </div>

                  {vpsFeedback && (
                    <div
                      className={`p-2.5 rounded-xl border text-xs font-mono flex items-start gap-2 ${
                        vpsFeedback.ok
                          ? 'bg-emerald-50/80 dark:bg-emerald-500/15 border-emerald-200 dark:border-emerald-500/30 text-emerald-800 dark:text-emerald-300'
                          : 'bg-rose-50 dark:bg-rose-500/15 border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {vpsFeedback.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <span>{vpsFeedback.text}</span>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* SECTION 2: USER & ACCESS KEY MANAGEMENT */}
          {(activeTab === 'ALL' || activeTab === 'LICENSES') && (
            <section className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 sm:p-6 space-y-5">
              {/* Header + KPI Stats */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-zinc-800">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  <div>
                    <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm sm:text-base uppercase">
                      Client Access Key &amp; User Registry
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Issue, extend, revoke, or delete client license keys (`EQ-7D` / `EQ-30D`)
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                  <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 font-semibold">
                    Total: {licenseStats.total}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 font-semibold">
                    Active: {licenseStats.active}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30 font-semibold">
                    Expired: {licenseStats.expired}
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-500/30 font-semibold">
                    Revoked: {licenseStats.revoked}
                  </span>
                  <button
                    type="button"
                    onClick={refreshLicenses}
                    disabled={isLoadingLicenses}
                    className="p-2 rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-slate-300 cursor-pointer"
                    title="Refresh License Registry"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${isLoadingLicenses ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
              </div>

              {/* Issue New Key Form */}
              <form
                onSubmit={handleCreateLicense}
                className="p-4 rounded-xl bg-[#F8FAFC] dark:bg-slate-950/70 border border-slate-200/90 dark:border-zinc-800 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end font-mono text-xs"
              >
                <div className="sm:col-span-3 space-y-1">
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                    Username *
                  </label>
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="trader_handle"
                    className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs text-[#0F172A] dark:text-slate-100"
                  />
                </div>

                <div className="sm:col-span-3 space-y-1">
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                    Telegram
                  </label>
                  <input
                    type="text"
                    value={newTelegram}
                    onChange={(e) => setNewTelegram(e.target.value)}
                    placeholder="@telegram"
                    className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs text-[#0F172A] dark:text-slate-100"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                    Email
                  </label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="optional@mail.com"
                    className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs text-[#0F172A] dark:text-slate-100"
                  />
                </div>

                <div className="sm:col-span-2 space-y-1">
                  <label className="block text-[10px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 font-semibold">
                    Duration
                  </label>
                  <select
                    value={newDuration}
                    onChange={(e) => setNewDuration(e.target.value === '7d' ? '7d' : '30d')}
                    className="w-full rounded-xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 px-3 py-2 text-xs font-semibold text-[#0F172A] dark:text-slate-100"
                  >
                    <option value="30d">30 Days (EQ-30D)</option>
                    <option value="7d">7 Days (EQ-7D)</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={isCreatingKey}
                    className="w-full bg-[#0F172A] dark:bg-emerald-600 hover:bg-[#1E293B] dark:hover:bg-emerald-500 text-white font-sans font-semibold rounded-xl px-3 py-2 text-xs flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5 text-emerald-400 dark:text-white" />
                    <span>{isCreatingKey ? 'Issuing...' : 'Issue Key'}</span>
                  </button>
                </div>
              </form>

              {/* Newly Generated Key Banner */}
              {createdKeyBanner && (
                <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                  <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>New Access Key Provisioned:</span>
                    <strong className="text-[#0F172A] dark:text-white tracking-wider select-all">
                      {createdKeyBanner}
                    </strong>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopyText('banner', createdKeyBanner)}
                    className="px-3 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-emerald-200 dark:border-emerald-500/40 text-[#0F172A] dark:text-slate-100 font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    {copiedId === 'banner' ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Key</span>
                      </>
                    )}
                  </button>
                </div>
              )}

              {licenseError && (
                <div className="p-3 rounded-xl bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-700 dark:text-rose-300 text-xs font-mono flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{licenseError}</span>
                </div>
              )}

              {/* Search + Filter Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
                <div className="relative flex-1 min-w-[220px] max-w-md">
                  <input
                    type="text"
                    value={licenseSearch}
                    onChange={(e) => setLicenseSearch(e.target.value)}
                    placeholder="Search key, username, @telegram, email..."
                    className="w-full bg-[#F8FAFC] dark:bg-slate-950 border border-slate-200 dark:border-zinc-700 rounded-xl px-3 py-2 pl-9 text-xs text-[#0F172A] dark:text-slate-100"
                  />
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                </div>

                <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-950 p-1 rounded-xl border border-slate-200 dark:border-zinc-800">
                  {(['ALL', 'ACTIVE', 'EXPIRED', 'REVOKED'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setLicenseStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
                        licenseStatusFilter === st
                          ? 'bg-[#0F172A] dark:bg-emerald-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-100'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              {/* Licenses Table */}
              <div className="overflow-x-auto border border-slate-200/80 dark:border-zinc-800 rounded-xl">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="bg-slate-50/90 dark:bg-slate-950/90 text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 border-b border-slate-200/80 dark:border-zinc-800">
                    <tr>
                      <th className="px-4 py-3">ACCESS KEY</th>
                      <th className="px-4 py-3">TRADER / TELEGRAM</th>
                      <th className="px-4 py-3">TIER</th>
                      <th className="px-4 py-3">EXPIRES</th>
                      <th className="px-4 py-3">STATUS</th>
                      <th className="px-4 py-3 text-right">ACTIONS</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                    {filteredLicenses.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-slate-400 dark:text-zinc-500">
                          No access keys match the current filter.
                        </td>
                      </tr>
                    ) : (
                      filteredLicenses.map((lic) => {
                        const isBusy = busyLicenseId === lic.id;
                        return (
                          <tr key={lic.id} className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors">
                            <td className="px-4 py-3 font-bold text-[#0F172A] dark:text-slate-100">
                              <div className="flex items-center gap-2">
                                <span>{lic.licenseKey}</span>
                                <button
                                  type="button"
                                  onClick={() => handleCopyText(lic.id, lic.licenseKey)}
                                  className="text-slate-400 hover:text-[#0F172A] dark:hover:text-slate-200 cursor-pointer"
                                  title="Copy Key"
                                >
                                  {copiedId === lic.id ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-semibold text-[#0F172A] dark:text-slate-200">{lic.username}</div>
                              <div className="text-[10px] text-slate-400 dark:text-zinc-400">
                                {lic.telegram}
                                {lic.email ? ` · ${lic.email}` : ''}
                              </div>
                            </td>
                            <td className="px-4 py-3 uppercase font-semibold text-slate-600 dark:text-slate-300">
                              {lic.duration}
                            </td>
                            <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                              {new Date(lic.expiresAt).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                  lic.status === 'ACTIVE'
                                    ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                                    : lic.status === 'EXPIRED'
                                    ? 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30'
                                    : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30'
                                }`}
                              >
                                {lic.status}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleLicenseAction(lic.id, 'EXTEND', 7)}
                                  className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-[#0F172A] dark:text-slate-200 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                                  title="Extend +7 Days"
                                >
                                  <CalendarPlus className="w-3 h-3" />
                                  <span>+7D</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleLicenseAction(lic.id, 'EXTEND', 30)}
                                  className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 dark:hover:bg-zinc-700 text-[#0F172A] dark:text-slate-200 text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                                  title="Extend +30 Days"
                                >
                                  +30D
                                </button>

                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleLicenseAction(lic.id, 'REVOKE')}
                                  className={`px-2 py-1 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50 ${
                                    lic.status === 'REVOKED'
                                      ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30 hover:bg-emerald-100'
                                      : 'bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30 hover:bg-amber-100'
                                  }`}
                                >
                                  <Ban className="w-3 h-3" />
                                  <span>{lic.status === 'REVOKED' ? 'Activate' : 'Revoke'}</span>
                                </button>

                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleLicenseAction(lic.id, 'DELETE')}
                                  className="p-1.5 rounded-lg bg-rose-50 dark:bg-rose-500/15 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 cursor-pointer disabled:opacity-50"
                                  title="Delete Key"
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
          )}

          {/* SECTION 3: MASTER ENGINE SWITCHES & TRADING NODE MONITOR */}
          {(activeTab === 'ALL' || activeTab === 'GOVERNANCE') && (
            <section className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Master Engine Governance Switches (5 cols) */}
              <div className="lg:col-span-5 bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between border-b border-slate-100 dark:border-zinc-800 pb-3.5">
                  <div className="flex items-center gap-2">
                    <Sliders className="w-4 h-4 text-[#0F172A] dark:text-emerald-400" />
                    <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm uppercase">
                      Master Engine Governance Switches
                    </h2>
                  </div>
                  <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 px-2 py-0.5 rounded-full font-semibold">
                    PERSISTENT
                  </span>
                </div>

                <div className="space-y-2.5">
                  {masterSwitchItems.map((item) => {
                    const isOn = switches[item.key];
                    const isSavingThis = savingSwitchKey === item.key;
                    return (
                      <div
                        key={item.key}
                        className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                          item.danger && isOn
                            ? 'bg-rose-50/70 dark:bg-rose-500/15 border-rose-200 dark:border-rose-500/30'
                            : 'bg-[#F8FAFC] dark:bg-slate-950/70 border-slate-200/90 dark:border-zinc-800'
                        }`}
                      >
                        <div className="space-y-0.5 min-w-0">
                          <div className="font-sans font-bold text-[#0F172A] dark:text-slate-100 text-xs leading-snug">
                            {item.label}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">
                            {item.sub}
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={isSavingThis}
                          onClick={() => handleToggleSwitch(item.key)}
                          className={`px-3 py-1 rounded-full font-mono text-xs font-semibold border transition-all shrink-0 cursor-pointer ${
                            item.danger
                              ? isOn
                                ? 'bg-rose-600 text-white border-rose-600'
                                : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-zinc-700 hover:bg-slate-100'
                              : isOn
                              ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200/80 dark:border-emerald-500/30'
                              : 'bg-slate-200/70 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400 border-slate-300 dark:border-zinc-700'
                          }`}
                        >
                          {isSavingThis ? '...' : isOn ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Connected Exchange Gateways & Node Telemetry (7 cols) */}
              <div className="lg:col-span-7 bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200/80 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm uppercase">
                      Connected Trading Gateways &amp; Node Monitor
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      fetchAccountInfo();
                      useBinanceStore.getState().fetchAccountInfo();
                      checkKronosHealth();
                    }}
                    className="bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-zinc-800 rounded-xl px-3 py-1.5 text-xs font-mono font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Sync Gateways</span>
                  </button>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead className="bg-slate-50/90 dark:bg-slate-950/90 text-[11px] uppercase tracking-wider text-slate-500 dark:text-zinc-400 border-b border-slate-200/80 dark:border-zinc-800">
                      <tr>
                        <th className="px-5 py-3">MARKET GATEWAY</th>
                        <th className="px-5 py-3">ENDPOINT</th>
                        <th className="px-5 py-3">BALANCE / STATUS</th>
                        <th className="px-5 py-3">SIGNING</th>
                        <th className="px-5 py-3 text-right">TERMINAL</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                      <tr className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="px-5 py-4">
                          <div className="font-bold text-[#0F172A] dark:text-slate-100">Exness Forex</div>
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500">#{liveAccountNumber}</div>
                        </td>
                        <td className="px-5 py-4 text-slate-600 dark:text-slate-300">ap-6756732d.exness-api.com</td>
                        <td className="px-5 py-4 font-bold text-[#0F172A] dark:text-slate-100">
                          {liveBalance !== null && liveBalance !== undefined
                            ? `$${Number(liveBalance).toFixed(2)} / $${Number(
                                liveEquity ?? liveBalance
                              ).toFixed(2)}`
                            : 'Client Vault Scoped'}
                        </td>
                        <td className="px-5 py-4">
                          <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 border border-slate-200 dark:border-zinc-700 font-semibold">
                            Ed25519
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Link
                            href="/"
                            className="inline-flex items-center gap-1 bg-[#0F172A] dark:bg-zinc-800 hover:bg-[#1E293B] dark:hover:bg-zinc-700 text-white font-medium rounded-xl px-3 py-1.5 text-xs"
                          >
                            <span>Forex</span>
                            <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
                          </Link>
                        </td>
                      </tr>

                      <tr className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="px-5 py-4">
                          <div className="font-bold text-[#0F172A] dark:text-slate-100">Binance USDⓈ-M</div>
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500">
                            {binanceTestnet ? 'Testnet' : 'Mainnet'}
                          </div>
                        </td>
                        <td className="px-5 py-4 text-slate-600 dark:text-slate-300">
                          {binanceTestnet ? 'testnet.binancefuture.com' : 'fapi.binance.com'}
                        </td>
                        <td className="px-5 py-4 font-bold text-[#0F172A] dark:text-slate-100">
                          ${Number(binanceWallet).toFixed(2)} USDT (
                          {binanceConfigured ? 'Bound' : 'Public Feed'})
                        </td>
                        <td className="px-5 py-4">
                          <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 border border-slate-200 dark:border-zinc-700 font-semibold">
                            HMAC-SHA256
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Link
                            href="/"
                            className="inline-flex items-center gap-1 bg-[#0F172A] dark:bg-zinc-800 hover:bg-[#1E293B] dark:hover:bg-zinc-700 text-white font-medium rounded-xl px-3 py-1.5 text-xs"
                          >
                            <span>Crypto</span>
                            <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
                          </Link>
                        </td>
                      </tr>

                      <tr className="hover:bg-slate-50/80 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="px-5 py-4">
                          <div className="font-bold text-[#0F172A] dark:text-slate-100">Kronos FastAPI Bridge</div>
                          <div className="text-[10px] text-slate-400 dark:text-zinc-500">/api/kronos</div>
                        </td>
                        <td className="px-5 py-4 text-slate-600 dark:text-slate-300 truncate max-w-[200px]">
                          {vpsUrl}
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                              isVpsOnline
                                ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-500/30'
                                : 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/30'
                            }`}
                          >
                            {isVpsOnline
                              ? `${kronosHealth?.engineStatus || 'kronos-neural-ready'} (${kronosHealth?.latencyMs ?? 12}ms)`
                              : 'LOCAL QUANT FALLBACK'}
                          </span>
                        </td>
                        <td className="px-5 py-4">
                          <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-zinc-800 text-[#0F172A] dark:text-slate-200 border border-slate-200 dark:border-zinc-700 font-semibold">
                            X-API-Key
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            onClick={handlePingVps}
                            disabled={isPingingVps}
                            className="inline-flex items-center gap-1 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 text-[#0F172A] dark:text-slate-200 font-medium rounded-xl px-3 py-1.5 text-xs cursor-pointer"
                          >
                            <RefreshCw
                              className={`w-3 h-3 ${isPingingVps ? 'animate-spin' : ''}`}
                            />
                            <span>Test Connection</span>
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      <InstitutionalFooter />
    </div>
  );
}
