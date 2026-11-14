import os from 'os';
import { NextResponse } from 'next/server';
import {
  readCentralAiConfig,
  getActiveAiProviders,
  AiProviderSlot,
} from '@/core/centralAiConfig';
import { DEFAULT_KRONOS_API_KEY } from '@/core/kronosService';
import { pingRedis } from '@/lib/queue';

export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 3000;

interface ProbeResult {
  online: boolean;
  configured: boolean;
  latencyMs: number;
  statusCode?: number;
  endpoint?: string;
  label?: string;
  error?: string;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
    return { ok: res.ok, status: res.status, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

async function probeKronosVps(
  kronosVpsUrl: string,
  kronosApiKey: string
): Promise<ProbeResult> {
  const cleanUrl = (kronosVpsUrl || '').trim().replace(/\/+$/, '');
  if (!cleanUrl || (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://'))) {
    return {
      online: false,
      configured: false,
      latencyMs: 0,
      label: 'Kronos VPS',
      error: 'URL not configured',
    };
  }

  const target = `${cleanUrl}/health`;
  const startedAt = performance.now();
  try {
    const res = await fetchWithTimeout(target, {
      'X-API-Key': (kronosApiKey || DEFAULT_KRONOS_API_KEY).trim(),
    });
    return {
      online: res.ok,
      configured: true,
      latencyMs: res.latencyMs,
      statusCode: res.status,
      endpoint: cleanUrl,
      label: 'Kronos VPS',
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err: any) {
    return {
      online: false,
      configured: true,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      endpoint: cleanUrl,
      label: 'Kronos VPS',
      error: err?.name === 'AbortError' ? 'Timeout (>3000ms)' : err?.message || 'Unreachable',
    };
  }
}

function selectMultiAiProbeTarget(providers: AiProviderSlot[], fallbackBaseUrl?: string, fallbackApiKey?: string, fallbackModel?: string): {
  baseUrl: string;
  apiKey: string;
  id: string;
  label: string;
} | null {
  if (providers.length > 0) {
    // Prioritize Qwen / custom VPS engine if configured, otherwise first active provider
    const qwenOrCustom =
      providers.find((p) => p.model.toLowerCase().includes('qwen') || p.id === 'custom') ||
      providers[0];
    return {
      baseUrl: qwenOrCustom.baseUrl,
      apiKey: qwenOrCustom.apiKey,
      id: qwenOrCustom.id,
      label: `${qwenOrCustom.name.split(' ')[0]} (${qwenOrCustom.model})`,
    };
  }
  if (fallbackBaseUrl && fallbackApiKey) {
    return {
      baseUrl: fallbackBaseUrl,
      apiKey: fallbackApiKey,
      id: 'custom',
      label: fallbackModel || 'Multi-AI Engine',
    };
  }
  return null;
}

async function probeMultiAiEngine(
  providers: AiProviderSlot[],
  fallbackBaseUrl?: string,
  fallbackApiKey?: string,
  fallbackModel?: string
): Promise<ProbeResult> {
  const target = selectMultiAiProbeTarget(providers, fallbackBaseUrl, fallbackApiKey, fallbackModel);
  if (!target) {
    return {
      online: false,
      configured: false,
      latencyMs: 0,
      label: 'Multi-AI / Qwen',
      error: 'No active AI provider configured',
    };
  }

  const cleanBase = target.baseUrl.trim().replace(/\/+$/, '');
  const probeUrl = `${cleanBase}/models`;
  const headers: Record<string, string> =
    target.id === 'anthropic'
      ? {
          'x-api-key': target.apiKey.trim(),
          'anthropic-version': '2023-06-01',
        }
      : {
          Authorization: `Bearer ${target.apiKey.trim()}`,
        };

  const startedAt = performance.now();
  try {
    const res = await fetchWithTimeout(probeUrl, headers);
    return {
      online: res.ok,
      configured: true,
      latencyMs: res.latencyMs,
      statusCode: res.status,
      endpoint: cleanBase,
      label: target.label,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err: any) {
    return {
      online: false,
      configured: true,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      endpoint: cleanBase,
      label: target.label,
      error: err?.name === 'AbortError' ? 'Timeout (>3000ms)' : err?.message || 'Unreachable',
    };
  }
}

export async function GET() {
  const reqStartedAt = performance.now();

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const usedMemBytes = Math.max(0, totalMemBytes - freeMemBytes);
  const ramUsedPct = totalMemBytes > 0 ? Number(((usedMemBytes / totalMemBytes) * 100).toFixed(1)) : 0;

  const cpus = os.cpus();
  const cpuCores = Math.max(1, cpus?.length || 1);
  const loadAvg1m = os.loadavg()[0] || 0;
  const cpuLoadPct = Number(Math.min(100, Math.max(0, (loadAvg1m / cpuCores) * 100)).toFixed(1));

  const centralConfig = await readCentralAiConfig();
  const activeProviders = getActiveAiProviders(centralConfig);

  const [redisRes, kronosRes, multiAiRes] = await Promise.allSettled([
    pingRedis(PROBE_TIMEOUT_MS),
    probeKronosVps(centralConfig.kronosVpsUrl, centralConfig.kronosApiKey),
    probeMultiAiEngine(
      activeProviders,
      centralConfig.baseUrl,
      centralConfig.apiKey,
      centralConfig.model
    ),
  ]);

  const redis =
    redisRes.status === 'fulfilled'
      ? redisRes.value
      : { online: false, latencyMs: 0, error: 'Redis check failed' };

  const kronos: ProbeResult =
    kronosRes.status === 'fulfilled'
      ? kronosRes.value
      : { online: false, configured: false, latencyMs: 0, error: 'Kronos probe failed' };

  const multiAi: ProbeResult =
    multiAiRes.status === 'fulfilled'
      ? multiAiRes.value
      : { online: false, configured: false, latencyMs: 0, error: 'Multi-AI probe failed' };

  const serverLatencyMs = Math.max(1, Math.round(performance.now() - reqStartedAt));

  return NextResponse.json(
    {
      timestamp: Date.now(),
      server: {
        online: true,
        latencyMs: serverLatencyMs,
        ramUsedPct,
        totalMemMb: Math.round(totalMemBytes / (1024 * 1024)),
        usedMemMb: Math.round(usedMemBytes / (1024 * 1024)),
        freeMemMb: Math.round(freeMemBytes / (1024 * 1024)),
        cpuLoad1m: Number(loadAvg1m.toFixed(2)),
        cpuLoadPct,
        cpuCores,
        uptimeSeconds: Math.floor(os.uptime()),
        processUptimeSeconds: Math.floor(process.uptime()),
        platform: `${os.platform()} ${os.arch()}`,
      },
      redis: {
        online: redis.online,
        latencyMs: redis.latencyMs,
        error: redis.error,
      },
      kronos,
      multiAi,
    },
    { status: 200 }
  );
}
