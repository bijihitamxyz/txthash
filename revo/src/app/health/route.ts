import { NextRequest, NextResponse } from 'next/server';
import {
  readCentralAiConfig,
  getActiveAiProviders,
  formatActiveAiSummaryLabel,
} from '@/core/centralAiConfig';
import { DEFAULT_KRONOS_API_KEY } from '@/core/kronosService';
import { verifyAdminSecret } from '@/lib/licenseDb';

export const dynamic = 'force-dynamic';

function isValidFastApiVpsUrl(url: string): boolean {
  if (!url) return false;
  const clean = url.trim().toLowerCase();
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) return false;
  if (
    clean.includes('<oracle_vps_ip>') ||
    clean.includes('localhost:3000') ||
    clean.includes('127.0.0.1:3000')
  ) {
    return false;
  }
  return true;
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  try {
    const centralConfig = await readCentralAiConfig();
    const isAdmin = verifyAdminSecret(req);
    const expectedKey = (centralConfig.kronosApiKey || DEFAULT_KRONOS_API_KEY).trim();

    const { searchParams } = new URL(req.url);
    const adminOverrideUrl = isAdmin ? (searchParams.get('vpsUrl') || '').trim() : '';
    const targetVpsUrl = (adminOverrideUrl || centralConfig.kronosVpsUrl || 'http://127.0.0.1:8000')
      .trim()
      .replace(/\/+$/, '');

    let vpsReady = false;
    let kronosReady = false;
    let remotePayload: any = null;
    let probeLatencyMs = 0;

    if (isValidFastApiVpsUrl(targetVpsUrl)) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, 2000);
      const probeStart = Date.now();
      try {
        const res = await fetch(`${targetVpsUrl}/health`, {
          method: 'GET',
          headers: {
            'X-API-Key': expectedKey || DEFAULT_KRONOS_API_KEY,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        probeLatencyMs = Math.max(1, Date.now() - probeStart);
        if (res.ok) {
          vpsReady = true;
          try {
            remotePayload = await res.json();
          } catch {}
          const remoteKronosOk =
            remotePayload == null ||
            (remotePayload.kronos_ready !== false &&
              remotePayload.ok !== false &&
              remotePayload.status !== 'error');
          kronosReady =
            remoteKronosOk && centralConfig.engineSwitches?.kronosForecaster !== false;
        }
      } catch {
        clearTimeout(timeoutId);
        probeLatencyMs = Math.max(1, Date.now() - probeStart);
      }
    }

    const activeProviders = getActiveAiProviders(centralConfig);
    const aiReady =
      activeProviders.length > 0 && centralConfig.engineSwitches?.multiAiRiskJudge !== false;
    const activeAiModels = activeProviders.map((p) => `${p.name.split(' ')[0]}:${p.model}`);
    const aiSummaryLabel = formatActiveAiSummaryLabel(centralConfig);
    const engineStatus = vpsReady
      ? String(remotePayload?.engine || remotePayload?.status || 'kronos-neural-ready')
      : 'local-quant-fallback';

    const latencyMs = probeLatencyMs || Math.max(1, Date.now() - startTime);
    const status =
      vpsReady && kronosReady
        ? 'healthy'
        : vpsReady || aiReady
        ? 'degraded'
        : 'offline';

    return NextResponse.json(
      {
        ok: vpsReady && kronosReady,
        success: true,
        status,
        kronosReady,
        vpsReady,
        aiReady,
        activeAiCount: activeProviders.length,
        activeAiModels,
        engineStatus,
        vpsStatus: vpsReady ? 'ONLINE' : 'OFFLINE',
        remoteBridge: vpsReady ? 'CONNECTED' : 'OFFLINE',
        engine: vpsReady ? 'kronos-neural-ready' : 'NMSSx-Kronos-MultiAI',
        architecture: 'MULTI-AI CONSENSUS + KRONOS VPS',
        aiModel: aiSummaryLabel,
        model: aiSummaryLabel,
        ...(isAdmin ? { vpsUrl: targetVpsUrl } : {}),
        engineSwitches: centralConfig.engineSwitches,
        authenticated: Boolean(expectedKey),
        latencyMs,
        timestamp: Date.now(),
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        status: 'offline',
        kronosReady: false,
        vpsReady: false,
        aiReady: false,
        vpsStatus: 'OFFLINE',
        remoteBridge: 'OFFLINE',
        engine: 'NMSSx-Kronos-MultiAI',
        architecture: 'MULTI-AI CONSENSUS + KRONOS VPS',
        latencyMs: Math.max(1, Date.now() - startTime),
        error: err?.message || 'Health probe failed',
        timestamp: Date.now(),
      },
      { status: 200 }
    );
  }
}
