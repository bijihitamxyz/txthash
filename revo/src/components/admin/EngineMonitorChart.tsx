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
} from 'recharts';
import { RefreshCw } from 'lucide-react';

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

const SERIES = [
  { key: 'serverMs', label: 'Server', color: '#10b981', gradId: 'gradServer' },
  { key: 'kronosMs', label: 'Kronos', color: '#0ea5e9', gradId: 'gradKronos' },
  { key: 'multiAiMs', label: 'Multi-AI', color: '#f59e0b', gradId: 'gradMultiAi' },
] as const;

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
        ? `CPU ${latest.server.cpuLoadPct}% • RAM ${latest.server.ramUsedPct}%`
        : 'Memuat OS...',
    },
    {
      id: 'redis',
      title: 'Redis Queue',
      online: latest ? latest.redis.online : false,
      latencyMs: latest?.redis.latencyMs ?? 0,
      subtitle: latest?.redis.online
        ? 'BullMQ Ready'
        : latest?.redis.error || 'Offline',
    },
    {
      id: 'kronos',
      title: 'Kronos AI',
      online: latest ? latest.kronos.online : false,
      latencyMs: latest?.kronos.latencyMs ?? 0,
      subtitle: latest?.kronos.online
        ? latest.kronos.label || latest.kronos.endpoint || 'VPS Healthy'
        : latest?.kronos.error || 'Offline',
    },
    {
      id: 'multiAi',
      title: 'Multi-AI Agent',
      online: latest ? latest.multiAi.online : false,
      latencyMs: latest?.multiAi.latencyMs ?? 0,
      subtitle: latest?.multiAi.label || latest?.multiAi.error || 'Menunggu config',
    },
  ];

  return (
    <section className="bg-white dark:bg-zinc-900/90 rounded-2xl border border-slate-200/90 dark:border-zinc-800 shadow-[0_2px_12px_rgba(15,23,42,0.03)] p-3 sm:p-4 space-y-2.5">
      {/* Header Ringkas (1 Baris) */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-xs sm:text-sm uppercase truncate">
          ENGINE MONITOR
        </h2>

        <div className="flex items-center gap-2 shrink-0">
          {fetchError && (
            <span
              className="text-[10px] font-mono text-rose-600 dark:text-rose-400 truncate max-w-[120px]"
              title={fetchError}
            >
              {fetchError}
            </span>
          )}
          <button
            type="button"
            onClick={fetchMetrics}
            aria-label="Refresh engine metrics"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-mono font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-600 dark:text-slate-300 transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
            <span>5s</span>
          </button>
        </div>
      </div>

      {/* Grid 2x2 Ultra-Compact untuk 4 Kartu Status */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {cards.map((card) => (
          <div
            key={card.id}
            className="relative rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/70 dark:bg-zinc-950/60 p-2.5 flex flex-col justify-between gap-0.5"
          >
            <div className="flex items-center justify-between gap-1.5">
              <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">
                {card.title}
              </span>
              <span
                aria-label={card.online ? 'Online' : 'Offline'}
                className={`w-2 h-2 rounded-full shrink-0 ${
                  card.online
                    ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.7)]'
                    : 'bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.6)]'
                }`}
              />
            </div>

            <div className="text-lg font-mono font-bold leading-tight text-slate-900 dark:text-white">
              {card.online ? `${card.latencyMs} ms` : '-- ms'}
            </div>

            <p
              className="text-[10px] font-mono text-slate-600 dark:text-zinc-300 opacity-60 truncate"
              title={card.subtitle}
            >
              {card.subtitle}
            </p>
          </div>
        ))}
      </div>

      {/* Grafik Minimalis */}
      <div className="rounded-xl border border-slate-200/80 dark:border-zinc-800 bg-slate-50/40 dark:bg-zinc-950/50 p-2.5">
        <div className="flex items-center justify-between gap-2 mb-1.5 px-1">
          <div className="flex items-center gap-3 flex-wrap">
            {SERIES.map((s) => (
              <span
                key={s.key}
                className="inline-flex items-center gap-1 text-[10px] font-mono text-slate-500 dark:text-zinc-400"
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </span>
            ))}
          </div>
          <span className="text-[10px] font-mono text-slate-400 dark:text-zinc-500 shrink-0">
            {history.length}/{MAX_POINTS}
          </span>
        </div>

        <div className="w-full h-[165px]">
          {mounted ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={history}
                margin={{ top: 4, right: 6, left: -18, bottom: 0 }}
              >
                <defs>
                  {SERIES.map((s) => (
                    <linearGradient key={s.gradId} id={s.gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={s.color} stopOpacity={0.32} />
                      <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  className="text-slate-200 dark:text-zinc-800"
                />
                <XAxis
                  dataKey="time"
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  unit="ms"
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(15, 23, 42, 0.92)',
                    borderColor: 'rgba(51, 65, 85, 0.8)',
                    borderRadius: '0.625rem',
                    fontSize: '11px',
                    color: '#f8fafc',
                  }}
                  itemStyle={{ fontFamily: 'monospace' }}
                />
                {SERIES.map((s) => (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={`${s.label} (ms)`}
                    stroke={s.color}
                    strokeWidth={1.75}
                    fillOpacity={1}
                    fill={`url(#${s.gradId})`}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[11px] font-mono text-slate-400">
              Memuat grafik...
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
