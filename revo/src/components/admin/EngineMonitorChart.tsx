'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Server, Database, Cpu, BrainCircuit, Activity, RefreshCw } from 'lucide-react';

interface EngineMetricsResponse {
  timestamp: number;
  server: {
    online: boolean;
    latencyMs: number;
    ramUsedPct: number;
    totalMemMb: number;
    usedMemMb: number;
    freeMemMb: number;
    cpuLoad1m: number;
    cpuLoadPct: number;
    cpuCores: number;
    uptimeSeconds: number;
    processUptimeSeconds: number;
    platform: string;
  };
  redis: {
    online: boolean;
    latencyMs: number;
    error?: string;
  };
  kronos: {
    online: boolean;
    configured: boolean;
    latencyMs: number;
    statusCode?: number;
    endpoint?: string;
    label?: string;
    error?: string;
  };
  multiAi: {
    online: boolean;
    configured: boolean;
    latencyMs: number;
    statusCode?: number;
    endpoint?: string;
    label?: string;
    error?: string;
  };
}

interface LatencyPoint {
  time: string;
  timestamp: number;
  serverMs: number;
  kronosMs: number;
  multiAiMs: number;
}

const POLL_INTERVAL_MS = 5000;
const MAX_POINTS = 20;

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatTimeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function EngineMonitorChart() {
  const [latest, setLatest] = useState<EngineMetricsResponse | null>(null);
  const [history, setHistory] = useState<LatencyPoint[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/server-metrics', {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: EngineMetricsResponse = await res.json();
      setLatest(data);
      setFetchError(null);

      const point: LatencyPoint = {
        time: formatTimeLabel(data.timestamp),
        timestamp: data.timestamp,
        serverMs: data.server?.latencyMs ?? 0,
        kronosMs: data.kronos?.online ? data.kronos.latencyMs : 0,
        multiAiMs: data.multiAi?.online ? data.multiAi.latencyMs : 0,
      };

      setHistory((prev) => [...prev, point].slice(-MAX_POINTS));
    } catch (err: any) {
      setFetchError(err?.message || 'Gagal memuat metrik server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const timer = setInterval(fetchMetrics, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchMetrics]);

  const cards = [
    {
      id: 'server',
      title: 'Server Utama',
      online: latest ? latest.server.online : false,
      latencyMs: latest?.server.latencyMs ?? 0,
      subtitle: latest
        ? `CPU ${latest.server.cpuLoadPct}% • RAM ${latest.server.ramUsedPct}% • Up ${formatUptime(latest.server.uptimeSeconds)}`
        : 'Memuat Node.js OS...',
      icon: Server,
    },
    {
      id: 'redis',
      title: 'Redis Queue',
      online: latest ? latest.redis.online : false,
      latencyMs: latest?.redis.latencyMs ?? 0,
      subtitle: latest?.redis.online
        ? 'BullMQ Ready (127.0.0.1:6379)'
        : latest?.redis.error || 'Redis Offline',
      icon: Database,
    },
    {
      id: 'kronos',
      title: 'Kronos AI',
      online: latest ? latest.kronos.online : false,
      latencyMs: latest?.kronos.latencyMs ?? 0,
      subtitle: latest?.kronos.online
        ? latest.kronos.endpoint || 'VPS Healthy'
        : latest?.kronos.error || 'Kronos Offline',
      icon: Cpu,
    },
    {
      id: 'multiAi',
      title: 'Multi-AI Agent',
      online: latest ? latest.multiAi.online : false,
      latencyMs: latest?.multiAi.latencyMs ?? 0,
      subtitle: latest?.multiAi.label || latest?.multiAi.error || 'Menunggu konfigurasi',
      icon: BrainCircuit,
    },
  ];

  return (
    <section className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-sm sm:text-base uppercase">
              Server & Engine Performance Monitor
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Real-time polling setiap 5 detik • 20 titik terakhir • Deteksi bottleneck latency (ms)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {fetchError && (
            <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
              {fetchError}
            </span>
          )}
          <button
            type="button"
            onClick={fetchMetrics}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* 4 Compact Status Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.id}
              className="rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-3.5 flex flex-col justify-between gap-2 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 text-slate-500 dark:text-zinc-400 shrink-0" />
                  <span className="text-xs font-sans font-semibold text-slate-700 dark:text-slate-200 truncate">
                    {card.title}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 text-[11px] font-mono font-bold shrink-0">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      card.online
                        ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
                        : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]'
                    }`}
                  />
                  <span
                    className={
                      card.online
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'
                    }
                  >
                    {card.online ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xl font-mono font-bold text-slate-900 dark:text-white">
                  {card.online ? `${card.latencyMs} ms` : '-- ms'}
                </span>
              </div>

              <p className="text-[11px] font-mono text-slate-500 dark:text-zinc-400 truncate" title={card.subtitle}>
                {card.subtitle}
              </p>
            </div>
          );
        })}
      </div>

      {/* Recharts AreaChart comparing Latency (ms) */}
      <div className="rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/40 dark:bg-zinc-950/50 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-600 dark:text-zinc-300">
            Perbandingan Tren Latency Engine (ms)
          </span>
          <span className="text-[11px] font-mono text-slate-400 dark:text-zinc-500">
            {history.length}/{MAX_POINTS} Samples
          </span>
        </div>

        <div className="w-full h-64 sm:h-72 min-h-[240px]">
          {mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={history}
                margin={{ top: 8, right: 12, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="gradServer" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradKronos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradMultiAi" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  className="text-slate-200 dark:text-zinc-800"
                />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  unit="ms"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                    borderColor: 'rgba(51, 65, 85, 0.8)',
                    borderRadius: '0.75rem',
                    fontSize: '12px',
                    color: '#f8fafc',
                  }}
                  itemStyle={{ fontFamily: 'monospace' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                />
                <Area
                  type="monotone"
                  dataKey="serverMs"
                  name="Server Utama (ms)"
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#gradServer)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="kronosMs"
                  name="Kronos VPS (ms)"
                  stroke="#0ea5e9"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#gradKronos)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="multiAiMs"
                  name="Multi-AI (ms)"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#gradMultiAi)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs font-mono text-slate-400">
              Memuat grafik monitoring...
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
