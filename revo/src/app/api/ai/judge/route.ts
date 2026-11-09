import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSecret } from '@/lib/licenseDb';
import { testAiPing, normalizeAiEndpoint, isReasoningModel } from '@/core/aiJudge';
import {
  DEFAULT_CENTRAL_AI_CONFIG,
  AiProviderSlot,
  readCentralAiConfig,
  writeCentralAiConfig,
  getActiveAiProviders,
  formatActiveAiSummaryLabel,
  calculateDynamicThreshold,
  formatAutoGovernanceTelemetry,
} from '@/core/centralAiConfig';
import { dualRoomProtections } from '@/core/riskGuard';
import { DEFAULT_KRONOS_API_KEY } from '@/core/kronosService';

export const dynamic = 'force-dynamic';

export interface AiJudgeVerdict {
  decision: 'EXECUTE' | 'REJECT';
  confidence_score: number;
  recommended_sl_pips?: number;
  recommended_tp_pips?: number;
  recommended_sl_price?: number;
  recommended_tp_price?: number;
  reasoning: string;
  source: 'LLM' | 'HEURISTIC_QUANT_FALLBACK';
  modelUsed: string;
  modelsUsed?: string[];
  latencyMs: number;
}

const judgeProviderCooldown = new Map<string, { until: number; status: number }>();

async function querySingleSetupProvider(
  slot: AiProviderSlot,
  systemPrompt: string,
  userPrompt: string
): Promise<{ decision: 'EXECUTE' | 'REJECT'; confidence_score: number; reasoning: string; label: string }> {
  const { chatEndpoint, isAnthropic, isLocal } = normalizeAiEndpoint(slot.baseUrl);
  const effectiveKey = (slot.apiKey || '').trim() || (isLocal ? 'sk-local-9router' : '');
  const model = (slot.model || '').trim() || 'gpt-4o-mini';
  const label = `${slot.name.split(' ')[0]}:${model}`;
  const cacheKey = `${slot.id}_${slot.baseUrl}_${model}`;

  const cooldown = judgeProviderCooldown.get(cacheKey);
  if (cooldown && Date.now() < cooldown.until) {
    throw new Error(`Cooldown HTTP ${cooldown.status}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 6500);

  const reasoning = isReasoningModel(model);

  try {
    let content = '';
    if (isAnthropic) {
      const res = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': effectiveKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        const ttl = res.status === 429 || res.status === 402 ? 60000 : 20000;
        judgeProviderCooldown.set(cacheKey, { until: Date.now() + ttl, status: res.status });
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      content = data.content?.[0]?.text || '';
    } else {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveKey}`,
        'HTTP-Referer': 'https://nmssx.xyz',
        'X-Title': 'NEMESIS x Trade Multi-AI Consensus',
      };
      const payloadBody: any = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      };
      if (reasoning) {
        payloadBody.max_completion_tokens = 512;
      } else {
        payloadBody.max_tokens = 512;
        payloadBody.temperature = 0.1;
      }

      let res = await fetch(chatEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloadBody),
        signal: controller.signal,
      });

      if (!res.ok && res.status === 400) {
        try {
          const fallbackBody = {
            model,
            messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
          };
          res = await fetch(chatEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(fallbackBody),
            signal: controller.signal,
          });
        } catch {}
      }

      clearTimeout(timeoutId);
      if (!res.ok) {
        const ttl = res.status === 429 || res.status === 402 ? 60000 : 20000;
        judgeProviderCooldown.set(cacheKey, { until: Date.now() + ttl, status: res.status });
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const choice = data?.choices?.[0];
      content = choice?.message?.content || choice?.message?.reasoning_content || '';
    }

    content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Non-JSON output');
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const confidence_score =
      typeof parsed.confidence_score === 'number'
        ? Math.min(100, Math.max(0, parsed.confidence_score))
        : 80;
    const decision: 'EXECUTE' | 'REJECT' = parsed.decision === 'EXECUTE' ? 'EXECUTE' : 'REJECT';
    return {
      decision,
      confidence_score,
      reasoning: parsed.reasoning || 'Multi-AI Consensus verified setup.',
      label,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (!judgeProviderCooldown.has(cacheKey)) {
      judgeProviderCooldown.set(cacheKey, { until: Date.now() + 20000, status: 500 });
    }
    throw err;
  }
}

/**
 * Dynamic "Use What Is Connected" Multi-AI Consensus Engine + Kronos Quant Metrics
 * Queries all active Admin AI providers in parallel via Promise.allSettled;
 * automatically fails over on quota/rate-limits or zero connected LLMs so 24/7 execution never halts.
 */
async function evaluateSetupWithCentralAi(payload: {
  symbol: string;
  side: 'BUY' | 'SELL';
  timeframe?: string;
  price: number;
  confluenceScore: number;
  bbWickSweepPct?: number;
  volumeRatio?: number;
  rsi?: number;
  pocPrice?: number;
  vahPrice?: number;
  valPrice?: number;
  zScore?: number;
  regime?: string;
  vwapDistancePct?: number;
  fundingRate?: number;
  emaTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  divergence?: string;
  room?: 'EXNESS' | 'BINANCE';
  marketType?: 'FOREX' | 'CRYPTO';
  efficiencyRatio?: number;
  pocMagnetAligned?: boolean;
  btcGuardStatus?: string;
}): Promise<AiJudgeVerdict> {
  const startTime = Date.now();
  const config = await readCentralAiConfig();

  if (config.engineSwitches?.emergencyKillSwitch) {
    return {
      decision: 'REJECT',
      confidence_score: 0,
      reasoning: '[ADMIN EMERGENCY KILL-SWITCH] Order execution halted globally by Administrator.',
      source: 'HEURISTIC_QUANT_FALLBACK',
      modelUsed: 'Admin-Risk-Governance',
      latencyMs: Math.max(1, Date.now() - startTime),
    };
  }

  const activeProviders = getActiveAiProviders(config);
  const marketType: 'FOREX' | 'CRYPTO' =
    payload.marketType || (payload.room === 'BINANCE' || payload.symbol.endsWith('USDT') ? 'CRYPTO' : 'FOREX');

  // Pure Quantitative Autonomous Dynamic Confidence Threshold Engine (58% - 82%)
  const recentSl = dualRoomProtections.hasRecentStopLoss(payload.symbol, marketType.toLowerCase() as any);
  const dynamicResult = calculateDynamicThreshold({
    efficiencyRatio: payload.efficiencyRatio,
    pocMagnetAligned: payload.pocMagnetAligned,
    kronosProbability: 60,
    bbwExpandingRapidly: (payload.bbWickSweepPct || 0) > 0.15,
    recentStopLoss: recentSl,
    symbol: payload.symbol,
    marketType,
  });

  const threshold = config.autoAdaptiveThreshold !== false
    ? dynamicResult.threshold
    : Math.max(55, config.confidenceThreshold || 65);

  const buildQuantFallback = (prefix: string): AiJudgeVerdict => {
    const latencyMs = Math.max(1, Date.now() - startTime);
    let baseScore = payload.confluenceScore;

    // Apply RD-Agent Kaufman ER factor
    if (typeof payload.efficiencyRatio === 'number') {
      if (payload.efficiencyRatio > 0.68 && payload.regime === 'COUNTER_TREND') {
        baseScore -= 15;
      } else if (payload.efficiencyRatio <= 0.50) {
        baseScore += 6;
      }
    }

    // Apply POC Magnet Alignment boost
    if (payload.pocMagnetAligned) {
      baseScore += 6;
    }

    // Apply BTC Guard penalty for Crypto
    if (marketType === 'CRYPTO' && payload.btcGuardStatus) {
      if (payload.btcGuardStatus.includes('VETO') || payload.btcGuardStatus.includes('DUMP')) {
        baseScore -= 30;
      }
    }

    const isApproved = baseScore >= threshold;
    return {
      decision: isApproved ? 'EXECUTE' : 'REJECT',
      confidence_score: isApproved
        ? Math.min(
            96,
            Math.max(
              threshold,
              Math.round(baseScore * 0.95 + (payload.bbWickSweepPct || 0) * 0.1)
            )
          )
        : Math.round(baseScore * 0.7),
      reasoning: isApproved
        ? `${prefix} Confluence Score ${baseScore}/100 meets ${threshold}% threshold (ER-10 ${payload.efficiencyRatio?.toFixed(2) ?? '-'}, POC Magnet ${payload.pocMagnetAligned ? 'Yes' : 'No'}).`
        : `${prefix} Confluence Score ${baseScore}/100 below ${threshold}% threshold.`,
      source: 'HEURISTIC_QUANT_FALLBACK',
      modelUsed: 'Kronos-Quant-Governance',
      modelsUsed: ['Kronos-Quant-Governance'],
      latencyMs,
    };
  };

  if (activeProviders.length === 0) {
    return buildQuantFallback('[KRONOS QUANT GOVERNANCE]');
  }

  const systemPrompt = `You are an elite Institutional Quantitative AI-Hedge-Fund Risk Officer and Confluence Judge for ${
    marketType === 'CRYPTO' ? 'Binance Crypto Futures' : 'Exness Forex & Gold'
  }.
Evaluate the setup across our 3-Pillar Institutional Quantitative Framework:
1. Pillar 1: Mean-Reversion Exhaustion (Bollinger Band penetration + RSI extreme/divergence + Wick Rejection conviction).
2. Pillar 2: Volume Profile Gravity (Kronos POC alignment, VAH/VAL boundaries, pocMagnetAligned status).
3. Pillar 3: Market Regime & Cross-Asset Safety (Kaufman Efficiency Ratio ER-10: ER > 0.68 denotes strong runaway cascade where counter-trend entries must be REJECTED; ER <= 0.50 denotes optimal mean-reversion. ${
    marketType === 'CRYPTO'
      ? 'BTC Guard: strictly VETO long setups if BTC is in high-efficiency dump.'
      : 'Forex Safety: ensure outside Exness low-liquidity rollover window.'
  })

Respond with ONLY a strict JSON object:
{
  "decision": "EXECUTE" or "REJECT",
  "confidence_score": 0 to 100,
  "reasoning": "Concise 1-sentence analytical rationale addressing the 3 pillars"
}`;

  const userPrompt = `Asset: ${payload.symbol} (${marketType})
Proposed Side: ${payload.side}
Timeframe: ${payload.timeframe || 'M5'}
Current Price: ${payload.price}
Confluence Score: ${payload.confluenceScore}/100
Kaufman Efficiency Ratio (ER-10): ${payload.efficiencyRatio?.toFixed(3) ?? 'N/A'}
POC Magnet Aligned: ${payload.pocMagnetAligned !== undefined ? (payload.pocMagnetAligned ? 'YES (POC between price & Mid-BB)' : 'NO') : 'N/A'}
Volume Profile POC: ${payload.pocPrice ?? payload.price} | VAH: ${payload.vahPrice ?? 'N/A'} | VAL: ${payload.valPrice ?? 'N/A'}
RSI(14): ${payload.rsi ? payload.rsi.toFixed(1) : 'N/A'} | Z-Score: ${payload.zScore ?? 'N/A'} | Regime: ${payload.regime || payload.emaTrend || 'NEUTRAL'}
Bollinger Wick Sweep: ${payload.bbWickSweepPct ? (payload.bbWickSweepPct * 100).toFixed(1) + '%' : 'N/A'}
Volume vs SMA20: ${payload.volumeRatio ? payload.volumeRatio.toFixed(2) + 'x' : 'N/A'}
Divergence: ${payload.divergence || 'NONE'}
VWAP Fair Value Distance: ${payload.vwapDistancePct ? (payload.vwapDistancePct * 100).toFixed(2) + '%' : 'N/A'}
Funding Rate: ${payload.fundingRate !== undefined ? (payload.fundingRate * 100).toFixed(4) + '%' : 'N/A'}
Trend: ${payload.emaTrend || 'NEUTRAL'}
${marketType === 'CRYPTO' ? `BTC Guard Status: ${payload.btcGuardStatus || 'NORMAL'}` : ''}`;

  const settled = await Promise.allSettled(
    activeProviders.map((slot) => querySingleSetupProvider(slot, systemPrompt, userPrompt))
  );

  const succeeded = settled
    .filter(
      (
        r
      ): r is PromiseFulfilledResult<{
        decision: 'EXECUTE' | 'REJECT';
        confidence_score: number;
        reasoning: string;
        label: string;
      }> => r.status === 'fulfilled'
    )
    .map((r) => r.value);

  if (succeeded.length === 0) {
    return buildQuantFallback('[AUTO-FAILOVER -> KRONOS QUANT]');
  }

  const latencyMs = Math.max(1, Date.now() - startTime);
  const executeVotes = succeeded.filter((s) => s.decision === 'EXECUTE').length;
  const rejectVotes = succeeded.length - executeVotes;
  const avgScore = Math.round(
    succeeded.reduce((acc, s) => acc + s.confidence_score, 0) / succeeded.length
  );

  let rawDecision: 'EXECUTE' | 'REJECT';
  if (executeVotes > rejectVotes) rawDecision = 'EXECUTE';
  else if (rejectVotes > executeVotes) {
    // For Crypto setups where qwen2.5:3b outputs 56-62%, allow execution if score meets dynamic threshold (>= 56)
    rawDecision = marketType === 'CRYPTO' && avgScore >= threshold ? 'EXECUTE' : 'REJECT';
  } else rawDecision = payload.confluenceScore >= threshold ? 'EXECUTE' : 'REJECT';

  const finalDecision: 'EXECUTE' | 'REJECT' =
    (rawDecision === 'EXECUTE' && avgScore >= threshold) ||
    (marketType === 'CRYPTO' && avgScore >= threshold && payload.confluenceScore >= threshold)
      ? 'EXECUTE'
      : 'REJECT';
  const modelsUsed = succeeded.map((s) => s.label);
  const modelUsedLabel =
    succeeded.length === 1
      ? succeeded[0].label
      : `Multi-AI Consensus (${succeeded.length} Active)`;

  const autoGovLog = formatAutoGovernanceTelemetry(avgScore, dynamicResult, finalDecision);
  const baseReasoning =
    succeeded.length === 1
      ? `[${succeeded[0].label}] ${succeeded[0].reasoning}`
      : `[Multi-AI Consensus ${executeVotes}/${succeeded.length} (${modelsUsed.join(', ')})] ${succeeded[0].reasoning}`;

  return {
    decision: finalDecision,
    confidence_score: avgScore,
    reasoning: `${baseReasoning} | ${autoGovLog}`,
    source: 'LLM',
    modelUsed: modelUsedLabel,
    modelsUsed,
    latencyMs,
  };
}

// GET: Returns full Multi-AI Provider Slots & Kronos VPS config to authenticated Admin ONLY; sanitized summary to clients
export async function GET(req: NextRequest) {
  try {
    const config = await readCentralAiConfig();
    const isAdmin = verifyAdminSecret(req);
    const activeProviders = getActiveAiProviders(config);
    const isConfigured = activeProviders.length > 0;
    const summaryLabel = formatActiveAiSummaryLabel(config);

    if (isAdmin) {
      return NextResponse.json({
        success: true,
        config: {
          baseUrl: config.baseUrl,
          model: summaryLabel,
          apiKey: config.apiKey,
          providers: config.providers,
          activeProviderCount: activeProviders.length,
          activeModels: activeProviders.map((p) => `${p.name.split(' ')[0]}:${p.model}`),
          confidenceThreshold: config.confidenceThreshold,
          autoAdaptiveThreshold: config.autoAdaptiveThreshold !== false,
          kronosVpsUrl: config.kronosVpsUrl,
          kronosApiKey: config.kronosApiKey,
          engineSwitches: config.engineSwitches,
          updatedAt: config.updatedAt,
          isConfigured,
        },
      });
    }

    // Non-admin callers NEVER receive API keys, VPS URLs, or Kronos secrets
    return NextResponse.json({
      success: true,
      config: {
        model: summaryLabel,
        activeProviderCount: activeProviders.length,
        activeModels: activeProviders.map((p) => `${p.name.split(' ')[0]}:${p.model}`),
        confidenceThreshold: config.confidenceThreshold,
        autoAdaptiveThreshold: config.autoAdaptiveThreshold !== false,
        engineSwitches: config.engineSwitches,
        isConfigured,
        updatedAt: config.updatedAt,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to read AI config' },
      { status: 500 }
    );
  }
}

// POST: Admin-only Save/Test Multi-AI & Kronos VPS config, or Judge evaluation
export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const action = body.action || 'JUDGE';

    // Admin-only actions
    if (
      action === 'SAVE_CONFIG' ||
      action === 'TEST_PROVIDER' ||
      action === 'TEST_CONNECTION' ||
      action === 'TEST_CONFIG' ||
      action === 'TEST_VPS'
    ) {
      if (!verifyAdminSecret(req)) {
        return NextResponse.json(
          {
            success: false,
            error: 'Unauthorized: AI & Kronos VPS configuration is restricted to Administrators.',
          },
          { status: 401 }
        );
      }
    }

    // 1. SAVE CONFIG (Admin Only)
    if (action === 'SAVE_CONFIG') {
      const {
        baseUrl,
        model,
        apiKey,
        providers,
        confidenceThreshold,
        autoAdaptiveThreshold,
        kronosVpsUrl,
        kronosApiKey,
        engineSwitches,
      } = body;
      const updated = await writeCentralAiConfig({
        baseUrl: baseUrl !== undefined ? baseUrl : undefined,
        model: model !== undefined ? model : undefined,
        apiKey: apiKey !== undefined ? apiKey : undefined,
        providers: Array.isArray(providers) ? providers : undefined,
        confidenceThreshold:
          typeof confidenceThreshold === 'number' ? confidenceThreshold : undefined,
        autoAdaptiveThreshold:
          typeof autoAdaptiveThreshold === 'boolean' ? autoAdaptiveThreshold : undefined,
        kronosVpsUrl: kronosVpsUrl !== undefined ? kronosVpsUrl : undefined,
        kronosApiKey: kronosApiKey !== undefined ? kronosApiKey : undefined,
        engineSwitches: engineSwitches !== undefined ? engineSwitches : undefined,
      });

      judgeProviderCooldown.clear();
      const activeProviders = getActiveAiProviders(updated);

      return NextResponse.json({
        success: true,
        message: `Central Multi-AI (${activeProviders.length} active) & Oracle Kronos VPS configuration saved.`,
        config: {
          baseUrl: updated.baseUrl,
          model: formatActiveAiSummaryLabel(updated),
          apiKey: updated.apiKey,
          providers: updated.providers,
          activeProviderCount: activeProviders.length,
          activeModels: activeProviders.map((p) => `${p.name.split(' ')[0]}:${p.model}`),
          confidenceThreshold: updated.confidenceThreshold,
          autoAdaptiveThreshold: updated.autoAdaptiveThreshold !== false,
          kronosVpsUrl: updated.kronosVpsUrl,
          kronosApiKey: updated.kronosApiKey,
          engineSwitches: updated.engineSwitches,
          updatedAt: updated.updatedAt,
          isConfigured: activeProviders.length > 0,
        },
      });
    }

    // 2. TEST AI PROVIDER CONNECTION (Admin Only)
    if (action === 'TEST_PROVIDER' || action === 'TEST_CONNECTION' || action === 'TEST_CONFIG') {
      const savedConfig = await readCentralAiConfig();
      const providerId = body.providerId ? String(body.providerId).trim() : '';
      const matchedSlot = providerId
        ? savedConfig.providers.find((p) => p.id === providerId)
        : undefined;

      const baseUrl = String(
        body.baseUrl || matchedSlot?.baseUrl || savedConfig.baseUrl || 'https://api.openai.com/v1'
      ).trim();
      const model = String(
        body.model || matchedSlot?.model || savedConfig.model || 'gpt-4o'
      ).trim();
      const rawKey =
        body.apiKey !== undefined
          ? String(body.apiKey).trim()
          : (matchedSlot?.apiKey ?? savedConfig.apiKey).trim();
      const apiKey = rawKey.includes('••••••••')
        ? matchedSlot?.apiKey || savedConfig.apiKey
        : rawKey;

      const { isLocal } = normalizeAiEndpoint(baseUrl);
      if (!apiKey && !isLocal) {
        return NextResponse.json({
          success: false,
          statusText: 'FAILED (API Key is empty)',
          message: 'FAILED (API Key is empty)',
        });
      }

      const pingResult = await testAiPing({ baseUrl, apiKey, model });

      // Persist test result onto the provider slot if providerId was specified
      if (providerId && matchedSlot) {
        const nextProviders = savedConfig.providers.map((slot) =>
          slot.id === providerId
            ? {
                ...slot,
                baseUrl,
                model,
                ...(apiKey ? { apiKey } : {}),
                lastTestedAt: Date.now(),
                lastTestOk: pingResult.success,
                lastLatencyMs: pingResult.latencyMs,
                lastError: pingResult.success ? '' : pingResult.errorReason || pingResult.message,
              }
            : slot
        );
        await writeCentralAiConfig({ providers: nextProviders });
      }

      return NextResponse.json(pingResult);
    }

    // 3. TEST ORACLE VPS KRONOS ENDPOINT (Admin Only)
    if (action === 'TEST_VPS') {
      const savedConfig = await readCentralAiConfig();
      const vpsUrl = String(body.kronosVpsUrl || savedConfig.kronosVpsUrl || 'http://127.0.0.1:8000')
        .trim()
        .replace(/\/+$/, '');
      const rawSecret =
        body.kronosApiKey !== undefined ? String(body.kronosApiKey).trim() : savedConfig.kronosApiKey;
      const kronosSecret =
        rawSecret && !rawSecret.includes('••••••••')
          ? rawSecret
          : savedConfig.kronosApiKey || DEFAULT_KRONOS_API_KEY;

      if (!vpsUrl.startsWith('http://') && !vpsUrl.startsWith('https://')) {
        return NextResponse.json({
          success: false,
          vpsReady: false,
          kronosReady: false,
          engineStatus: 'invalid-url',
          statusText: 'FAILED (Invalid VPS URL)',
          message: 'FAILED (Invalid VPS URL — must start with http:// or https://)',
        });
      }

      const start = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        try {
          controller.abort();
        } catch {}
      }, 3500);

      try {
        const res = await fetch(`${vpsUrl}/health`, {
          method: 'GET',
          headers: {
            'X-API-Key': kronosSecret,
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const latencyMs = Math.max(1, Date.now() - start);

        if (!res.ok) {
          return NextResponse.json({
            success: false,
            vpsReady: false,
            kronosReady: false,
            engineStatus: `http-${res.status}`,
            statusText: `FAILED (HTTP ${res.status})`,
            latencyMs,
            message: `FAILED (HTTP ${res.status} ${res.statusText} at ${vpsUrl}/health)`,
          });
        }

        let healthData: any = {};
        try {
          healthData = await res.json();
        } catch {}

        const engineStatus = String(
          healthData?.engine || healthData?.engine_status || 'kronos-neural-ready'
        );

        return NextResponse.json({
          success: true,
          vpsReady: true,
          kronosReady: healthData?.kronos_ready !== false,
          engineStatus,
          statusText: `CONNECTED · ${engineStatus} (${latencyMs}ms)`,
          latencyMs,
          healthData,
          message: `CONNECTED · ${engineStatus} (${latencyMs}ms)`,
        });
      } catch (err: any) {
        clearTimeout(timeoutId);
        const latencyMs = Math.max(1, Date.now() - start);
        const reason =
          err?.name === 'AbortError'
            ? 'Timeout > 3.5s'
            : err?.message || 'Connection refused';
        return NextResponse.json({
          success: false,
          vpsReady: false,
          kronosReady: false,
          engineStatus: 'offline',
          statusText: `FAILED (${reason})`,
          latencyMs,
          message: `FAILED (${reason}) — Local Quant Engine fallback remains active.`,
        });
      }
    }

    // 4. JUDGE EVALUATION (Called by Forex or Crypto Execution Engine)
    const verdict = await evaluateSetupWithCentralAi({
      symbol: body.symbol || 'BTCUSDT',
      side: body.side || 'BUY',
      timeframe: body.timeframe || 'M5',
      price: Number(body.price || 0),
      confluenceScore: Number(body.confluenceScore || 0),
      bbWickSweepPct: body.bbWickSweepPct,
      volumeRatio: body.volumeRatio,
      rsi: body.rsi,
      pocPrice: body.pocPrice,
      vahPrice: body.vahPrice,
      valPrice: body.valPrice,
      zScore: body.zScore,
      regime: body.regime,
      vwapDistancePct: body.vwapDistancePct,
      fundingRate: body.fundingRate,
      emaTrend: body.emaTrend,
      divergence: body.divergence,
      room: body.room,
      marketType: body.marketType,
      efficiencyRatio: body.efficiencyRatio,
      pocMagnetAligned: body.pocMagnetAligned,
      btcGuardStatus: body.btcGuardStatus,
    });

    return NextResponse.json({
      success: true,
      verdict,
    });
  } catch (err: any) {
    console.error('[API /api/ai/judge ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'AI Judge processing error.' },
      { status: 500 }
    );
  }
}
