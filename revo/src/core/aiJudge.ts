/**
 * AI Confluence Judge (src/core/aiJudge.ts)
 * Evaluates technical snapshots via OpenAI-compatible endpoints with a strict 6.0-second timeout.
 * Zero-Downtime Quantitative Fallback:
 * If the AI endpoint times out or has no key configured, automatically compute an adaptive
 * quantitative confidence score with dynamic trend alignment and divergence confirmation weights.
 */

import { TechnicalSnapshotPayload } from './signalGate';

export interface AiJudgeVerdict {
  decision: 'EXECUTE' | 'REJECT';
  confidence_score: number; // 0 - 100
  recommended_sl_pips: number;
  recommended_tp_pips: number;
  reasoning: string;
  source: 'LLM' | 'HEURISTIC_QUANT_FALLBACK';
  executionAllowed: boolean;
  modelsUsed?: string[];
}

export interface KronosQuantContext {
  pocPrice?: number;
  vahPrice?: number;
  valPrice?: number;
  rsi?: number;
  zScore?: number;
  regime?: string;
  bullishPct?: number;
  vpsStatus?: string;
}

export interface AiProviderInput {
  id?: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled?: boolean;
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  confidenceThreshold: number; // default 70
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  confidenceThreshold: 70,
};

export interface AiTestPingResult {
  success: boolean;
  message: string;
  statusText?: string;
  errorReason?: string;
  modelResponse?: string;
  model?: string;
  latencyMs?: number;
  providerType?: '9router' | 'openrouter' | 'anthropic' | 'openai' | 'groq' | 'deepseek' | 'gemini' | 'custom';
}

/**
 * Normalizes any AI Base URL into standardized chat & model endpoints.
 * Handles 9Router (localhost:20128/v1), OpenRouter, Anthropic, Ollama, Gemini, OpenAI, etc.
 */
export function normalizeAiEndpoint(rawBaseUrl: string): {
  chatEndpoint: string;
  modelsEndpoint: string;
  baseUrl: string;
  isAnthropic: boolean;
  isLocal: boolean;
} {
  let trimmed = (rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    trimmed = 'http://localhost:20128/v1';
  }

  const isLocal = trimmed.includes('localhost') || trimmed.includes('127.0.0.1') || trimmed.includes('0.0.0.0');
  const isAnthropic = trimmed.includes('api.anthropic.com');

  if (isAnthropic) {
    let base = trimmed;
    if (base.endsWith('/messages')) {
      base = base.replace(/\/messages$/, '');
    }
    return {
      baseUrl: base,
      chatEndpoint: `${base}/messages`,
      modelsEndpoint: `${base}/models`,
      isAnthropic: true,
      isLocal: false,
    };
  }

  let base = trimmed;
  if (base.endsWith('/chat/completions')) {
    base = base.replace(/\/chat\/completions$/, '');
  }

  return {
    baseUrl: base,
    chatEndpoint: `${base}/chat/completions`,
    modelsEndpoint: `${base}/models`,
    isAnthropic: false,
    isLocal,
  };
}

/**
 * Determines whether a model is a reasoning-focused model (o1, o3, DeepSeek-R1, thinking models)
 * which require special parameter adaptations (no temperature, max_completion_tokens).
 */
export function isReasoningModel(model: string): boolean {
  const m = (model || '').toLowerCase();
  return (
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.includes('reasoner') ||
    m.includes('deepseek-r1') ||
    m.includes('thinking') ||
    m.includes('nemotron-3.5')
  );
}

/**
 * Detects if a provider ID or base URL represents a commercial cloud LLM provider
 * (Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Google Gemini).
 */
export function isCloudProvider(slotId: string, baseUrl: string): boolean {
  const id = (slotId || '').toLowerCase().trim();
  const url = (baseUrl || '').toLowerCase().trim();
  const cloudIds = ['anthropic', 'openai', 'openrouter', 'groq', 'deepseek', 'gemini'];
  if (cloudIds.includes(id)) return true;
  if (
    url.includes('api.anthropic.com') ||
    url.includes('api.openai.com') ||
    url.includes('openrouter.ai') ||
    url.includes('api.groq.com') ||
    url.includes('api.deepseek.com') ||
    url.includes('googleapis.com')
  ) {
    return true;
  }
  return false;
}

/**
 * Smart Active-Only AI Consensus Filter:
 * Automatically prunes unconfigured cloud providers with empty keys,
 * ensuring only genuinely configured/reachable nodes (e.g. VPS Ollama qwen2.5:3b or valid cloud keys)
 * participate in Multi-AI Consensus.
 */
export function isProviderGenuinelyConfigured(slot: {
  id?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
  lastTestOk?: boolean;
}): boolean {
  if (!slot || slot.enabled === false) return false;
  const cleanUrl = (slot.baseUrl || '').trim();
  if (!cleanUrl) return false;
  const cleanKey = (slot.apiKey || '').trim();

  // 1. Cloud Providers MUST have a real, non-empty, non-masked API key (>= 5 chars)
  if (isCloudProvider(slot.id || '', cleanUrl)) {
    if (!cleanKey || cleanKey.length < 5 || cleanKey.includes('••••••••')) {
      return false;
    }
    return true;
  }

  // 2. Local / VPS / Custom Ollama Gateway (e.g. http://172.235.254.157:11434/v1)
  const { isLocal } = normalizeAiEndpoint(cleanUrl);
  if (isLocal) {
    return cleanKey.length > 0 || slot.lastTestOk === true || cleanUrl.length > 0;
  }

  // Custom / Self-hosted endpoint: active if key is set, or test passed, or explicit custom endpoint is populated
  return cleanKey.length > 0 || slot.lastTestOk === true || (slot.id === 'custom' && cleanUrl.length > 0);
}

export interface DynamicThresholdContext {
  efficiencyRatio?: number;
  pocMagnetAligned?: boolean;
  kronosProbability?: number; // 0 to 100 or 0.0 to 1.0
  bbwExpandingRapidly?: boolean;
  bbwExpansionPct?: number;
  isFundingWindow?: boolean;
  recentStopLoss?: boolean;
  symbol?: string;
  marketType?: 'FOREX' | 'CRYPTO';
}

export interface DynamicThresholdResult {
  threshold: number;
  baseThreshold: number;
  breakdown: {
    regimeDelta: number;
    regimeLabel: string;
    pocDelta: number;
    volatilityDelta: number;
    recoveryDelta: number;
  };
  reasons: string[];
  telemetryLog: string;
}

/**
 * Pure Quantitative Autonomous Dynamic Confidence Threshold Engine (Zero Manual Tuning):
 * - Base Institutional Threshold: 65%
 * - Regime Adjustment (Kaufman Efficiency Ratio ER):
 *   - ER <= 0.42 (Ideal Mean-Reverting / Ranging Regime): -5% (Threshold lowers to 60%)
 *   - 0.42 < ER <= 0.58 (Normal Regime): +0% (65%)
 *   - 0.58 < ER <= 0.68 (Trending / High Momentum): +7% (72%)
 *   - ER > 0.68 (Runaway Institutional Cascade): +13% (78%)
 * - Kronos Volume Profile Alignment:
 *   - pocMagnetAligned === true && Kronos directional probability >= 58%: -3% bonus discount
 * - Volatility & Session Guard Adjustment:
 *   - Rapid BBW expansion OR Crypto near funding window: +4% stricter requirement
 *   - Recent Stop Loss within last 2 hours (Sniper Recovery Mode): +5%
 * - Clamped strictly between 58% (minimum floor) and 82% (maximum ceiling)
 */
export function calculateDynamicThreshold(context: DynamicThresholdContext): DynamicThresholdResult {
  const baseThreshold = 65;
  let delta = 0;
  const reasons: string[] = [];

  // 1. Regime Adjustment (Kaufman Efficiency Ratio ER)
  const er = typeof context.efficiencyRatio === 'number' && !isNaN(context.efficiencyRatio)
    ? context.efficiencyRatio
    : 0.50;

  let regimeDelta = 0;
  let regimeLabel = 'Normal Regime';
  if (er <= 0.42) {
    regimeDelta = -5;
    regimeLabel = 'Ideal Mean-Reversion';
    reasons.push(`Regime ER=${er.toFixed(2)} <= 0.42 (-5%)`);
  } else if (er <= 0.58) {
    regimeDelta = 0;
    regimeLabel = 'Normal Regime';
    reasons.push(`Regime ER=${er.toFixed(2)} (+0%)`);
  } else if (er <= 0.68) {
    regimeDelta = 7;
    regimeLabel = 'Trending/Momentum';
    reasons.push(`Regime ER=${er.toFixed(2)} trending (+7%)`);
  } else {
    regimeDelta = 13;
    regimeLabel = 'Runaway Cascade';
    reasons.push(`Regime ER=${er.toFixed(2)} runaway cascade (+13%)`);
  }
  delta += regimeDelta;

  // 2. Kronos Volume Profile Alignment
  let pocDelta = 0;
  const rawProb = typeof context.kronosProbability === 'number' ? context.kronosProbability : 50;
  const prob = rawProb <= 1.0 ? rawProb * 100 : rawProb;
  if (context.pocMagnetAligned === true && prob >= 58) {
    pocDelta = -3;
    delta += pocDelta;
    reasons.push(`Kronos POC Aligned & Prob ${prob.toFixed(0)}% >= 58% (-3%)`);
  }

  // 3. Volatility & Session Guard Adjustment
  let volatilityDelta = 0;
  const isRapidBbw = context.bbwExpandingRapidly === true || (typeof context.bbwExpansionPct === 'number' && context.bbwExpansionPct > 15);
  if (isRapidBbw || context.isFundingWindow === true) {
    volatilityDelta = 4;
    delta += volatilityDelta;
    const volReason = isRapidBbw ? 'Rapid BBW Expansion' : 'Funding Settlement Window';
    reasons.push(`${volReason} (+4%)`);
  }

  // 4. Sniper Recovery Mode (recent Stop Loss within last 2 hours)
  let recoveryDelta = 0;
  if (context.recentStopLoss === true) {
    recoveryDelta = 5;
    delta += recoveryDelta;
    reasons.push(`Recent Stop Loss < 2h Sniper Recovery (+5%)`);
  }

  // 5. Clamp between 58% (minimum floor) and 82% (maximum ceiling)
  const rawThreshold = baseThreshold + delta;
  const threshold = Math.min(82, Math.max(58, Math.round(rawThreshold)));

  const telemetryLog = `[AUTO-GOVERNANCE] Dynamic Threshold: ${threshold}% (Base 65% | ${reasons.join(', ')})`;

  return {
    threshold,
    baseThreshold,
    breakdown: {
      regimeDelta,
      regimeLabel,
      pocDelta,
      volatilityDelta,
      recoveryDelta,
    },
    reasons,
    telemetryLog,
  };
}

export function formatAutoGovernanceTelemetry(
  score: number,
  dynamicResult: DynamicThresholdResult,
  decision: 'EXECUTE' | 'REJECT'
): string {
  return `[AUTO-GOVERNANCE] AI Score: ${score}% vs Dynamic Threshold: ${dynamicResult.threshold}% (${dynamicResult.reasons.join(', ')}) -> ${decision}`;
}

/**
 * Sends a lightweight test ping ("Ping" / "Say OK") to the configured AI API Base URL
 * using universal 9Router / OpenAI / Anthropic compatibility.
 */
export async function testAiPing(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<AiTestPingResult> {
  const apiKey = (config.apiKey || '').trim();
  const rawBaseUrl = (config.baseUrl || '').trim() || 'http://localhost:20128/v1';
  const model = (config.model || '').trim() || 'gpt-4o-mini';

  const { chatEndpoint, isAnthropic, isLocal, baseUrl } = normalizeAiEndpoint(rawBaseUrl);

  // Allow empty or placeholder API key for local instances (9Router or Ollama)
  const effectiveApiKey = apiKey || (isLocal ? 'sk-local-9router' : '');

  if (!effectiveApiKey && !isLocal) {
    return {
      success: false,
      statusText: 'FAILED (Missing API Key)',
      errorReason: 'Missing API Key',
      message: 'FAILED (Missing API Key)',
    };
  }

  const reasoning = isReasoningModel(model);
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 10000);

  try {
    let response: Response;

    if (isAnthropic) {
      // Native Anthropic format (1-token lightweight ping)
      response = await fetch(chatEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': effectiveApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'OK' }],
        }),
        signal: controller.signal,
      });
    } else {
      // Universal OpenAI-compatible format (OpenRouter, OpenAI, Groq, DeepSeek, Gemini, 9Router, Custom)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveApiKey}`,
        'HTTP-Referer': 'https://nmssx.xyz',
        'X-Title': 'NEMESIS x Trade Multi-AI Governance',
      };

      const requestPayload: any = {
        model,
        messages: [{ role: 'user', content: 'OK' }],
      };

      if (reasoning) {
        requestPayload.max_completion_tokens = 64;
      } else {
        requestPayload.max_tokens = 8;
        requestPayload.temperature = 0;
      }

      response = await fetch(chatEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal,
      });

      // Adaptive retry: If endpoint returned 400 due to temperature or max_tokens, retry with minimal payload
      if (!response.ok && response.status === 400) {
        try {
          const errText = await response.clone().text();
          if (
            errText.includes('temperature') ||
            errText.includes('max_tokens') ||
            errText.includes('max_completion_tokens') ||
            errText.includes('response_format')
          ) {
            const fallbackPayload = {
              model,
              messages: [{ role: 'user', content: 'OK' }],
            };
            response = await fetch(chatEndpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(fallbackPayload),
              signal: controller.signal,
            });
          }
        } catch {}
      }
    }

    clearTimeout(timeoutId);
    const latencyMs = Math.max(1, Date.now() - startTime);

    if (!response.ok) {
      let errDetail = '';
      try {
        const errJson = await response.json();
        errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
      } catch {
        errDetail = response.statusText || `HTTP ${response.status}`;
      }
      const shortErr = String(errDetail).slice(0, 120);
      return {
        success: false,
        statusText: `FAILED (HTTP ${response.status}: ${shortErr})`,
        errorReason: `HTTP ${response.status}: ${shortErr}`,
        message: `FAILED (HTTP ${response.status}: ${shortErr})`,
        latencyMs,
      };
    }

    const data = await response.json();
    let reply = 'OK';

    if (isAnthropic) {
      reply = data?.content?.[0]?.text?.trim() || reply;
    } else {
      const choice = data?.choices?.[0];
      const rawReply = choice?.message?.content || choice?.message?.reasoning_content;
      if (typeof rawReply === 'string' && rawReply.trim()) {
        reply = rawReply.trim();
      }
    }

    reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || 'OK';

    const lowerBase = baseUrl.toLowerCase();
    const providerType: AiTestPingResult['providerType'] = isLocal
      ? '9router'
      : lowerBase.includes('openrouter.ai')
      ? 'openrouter'
      : isAnthropic
      ? 'anthropic'
      : lowerBase.includes('groq.com')
      ? 'groq'
      : lowerBase.includes('deepseek.com')
      ? 'deepseek'
      : lowerBase.includes('generativelanguage.googleapis.com')
      ? 'gemini'
      : lowerBase.includes('openai.com')
      ? 'openai'
      : 'custom';

    return {
      success: true,
      statusText: `CONNECTED (${latencyMs}ms)`,
      message: `CONNECTED (${latencyMs}ms) · ${model}`,
      modelResponse: reply,
      model,
      latencyMs,
      providerType,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const latencyMs = Math.max(1, Date.now() - startTime);
    if (err.name === 'AbortError') {
      return {
        success: false,
        statusText: 'FAILED (Timeout >10s)',
        errorReason: 'Timeout >10s',
        message: 'FAILED (Timeout >10s)',
        latencyMs,
      };
    }
    const reason = String(err.message || 'Network unreachable').slice(0, 100);
    return {
      success: false,
      statusText: `FAILED (${reason})`,
      errorReason: reason,
      message: `FAILED (${reason})`,
      latencyMs,
    };
  }
}

/**
 * Builds system prompt for institutional quantitative confluence (Dual-Room 3-Pillar Framework)
 */
export function buildAiSystemPrompt(marketType: 'FOREX' | 'CRYPTO' = 'FOREX'): string {
  return `You are an elite Institutional Quantitative AI-Hedge-Fund Risk Officer and Confluence Judge for ${
    marketType === 'CRYPTO' ? 'Binance Crypto Futures' : 'Forex & Gold'
  } algorithmic trading.
Evaluate the qualified setup across our 3-Pillar Quantitative Confluence Framework:
1. Pillar 1: Mean-Reversion Exhaustion (Bollinger Band penetration + RSI extreme/divergence + Wick Rejection conviction >= 35%).
2. Pillar 2: Volume Profile Gravity (Kronos POC alignment, VAH/VAL value areas, pocMagnetAligned status, and directional probability).
3. Pillar 3: Market Regime & Cross-Asset Safety (Kaufman Efficiency Ratio ER-10: ER > 0.68 denotes one-way runaway trend cascade where counter-trend entries MUST BE REJECTED; ER <= 0.50 denotes optimal mean-reversion. ${
    marketType === 'CRYPTO'
      ? 'BTC Guard Status: strictly VETO long altcoin setups if BTC is in a high-efficiency dump or velocity dump.'
      : 'Forex Safety: ensure outside Exness low-liquidity rollover blackout window (21:00-22:15 UTC).'
  })

Scale recommended SL/TP pips and tick distances appropriately for the asset's volatility and ATR.

You must respond with ONLY a strict JSON object matching this schema without markdown fences or other text:
{
  "decision": "EXECUTE" | "REJECT",
  "confidence_score": <number 0-100>,
  "recommended_sl_pips": <number>,
  "recommended_tp_pips": <number>,
  "reasoning": "<concise 1-sentence analytical rationale addressing the 3 pillars>"
}`;
}

/**
 * Builds user prompt containing structured technical snapshot and 3-pillar context
 */
export function buildAiUserPrompt(
  snapshot: TechnicalSnapshotPayload,
  kronosContext?: KronosQuantContext
): string {
  const marketType = snapshot.marketType || (snapshot.symbol.endsWith('USDT') ? 'CRYPTO' : 'FOREX');
  const erDisplay = typeof snapshot.efficiencyRatio === 'number'
    ? `${snapshot.efficiencyRatio.toFixed(3)} (${snapshot.efficiencyRatio > 0.68 ? 'STRONG_ONE_WAY_TREND_CASCADE' : snapshot.efficiencyRatio <= 0.50 ? 'OPTIMAL_MEAN_REVERTING' : 'MODERATE'})`
    : 'N/A';
  const pocAlignedDisplay = snapshot.pocMagnetAligned !== undefined
    ? (snapshot.pocMagnetAligned ? 'ALIGNED (POC sits between entry and target Mid-BB)' : 'UNALIGNED')
    : 'N/A';

  const kronosLines = kronosContext
    ? `\nKRONOS VPS QUANT METRICS:
- Volume Profile POC: ${kronosContext.pocPrice ?? 'N/A'} | VAH: ${kronosContext.vahPrice ?? 'N/A'} | VAL: ${kronosContext.valPrice ?? 'N/A'}
- Price Z-Score (20): ${kronosContext.zScore ?? snapshot.zScore ?? 0} | Quant Regime: ${kronosContext.regime || snapshot.regime}
- Kronos Directional Probability: Bullish ${kronosContext.bullishPct ?? 50}% / Bearish ${100 - (kronosContext.bullishPct ?? 50)}%`
    : '';

  const cryptoSafetyLines = marketType === 'CRYPTO' && snapshot.btcGuardStatus
    ? `\nCRYPTO CROSS-ASSET SAFETY:
- BTC Guard Status: ${snapshot.btcGuardStatus}`
    : '';

  return `TECHNICAL SNAPSHOT (${marketType}):
- Symbol: ${snapshot.symbol} (${snapshot.timeframe}) | Market Type: ${marketType}
- Proposed Action: ${snapshot.side}
- Setup Type: ${snapshot.setupName || snapshot.signalType} (Regime: ${snapshot.regime}, Gate Confluence Score: ${snapshot.confluence_score ?? 65}/100)
- Trigger Price: ${snapshot.triggerPrice}
- Kaufman Efficiency Ratio (ER-10): ${erDisplay}
- Volume Profile POC Magnet: ${pocAlignedDisplay}
- RSI (14): ${snapshot.rsi} (Reversal Slope: ${snapshot.rsi_slope > 0 ? '+' : ''}${snapshot.rsi_slope})
- BB Position: ${snapshot.bb_position_pct ?? 50}%
- Wick Rejection Strength: ${snapshot.wick_rejection_strength} (Wick Ratio: ${snapshot.wick_ratio})
- Volatility Metrics: ATR(14) ${snapshot.atr_pips} pips, Candle/ATR Ratio: ${snapshot.atr_ratio}x (${snapshot.volatility_regime})
- Bollinger Band Width Expansion: ${snapshot.bbw_expansion_pct}%
- S/R Distance: Support ${snapshot.distance_to_support_pips} pips (${snapshot.support_price}), Resistance ${snapshot.distance_to_resistance_pips} pips (${snapshot.resistance_price})
- 15-Candle Divergence: ${snapshot.divergence_detected ? `DETECTED (${snapshot.divergence_type})` : 'NONE'}
- Distance from EMA 200: ${snapshot.ema200Distance} pips
- Initial SL: ${snapshot.proposedSlPips} pips (${snapshot.proposedSlPrice})
- Target TP: ${snapshot.proposedTpPips} pips (${snapshot.proposedTpPrice})
- Risk-Reward: ${snapshot.riskRewardRatio}:1${kronosLines}${cryptoSafetyLines}

Evaluate the 3 Pillars (1. Mean-Reversion Exhaustion, 2. Volume Profile Gravity, 3. Market Regime & Cross-Asset Safety). Return strict JSON only.`;
}

export interface QuantFallbackBreakdown {
  baseScore: number;
  trendWeight: number;
  setupWeight: number;
  divergenceWeight: number;
  wickWeight: number;
  volatilityWeight: number;
  rrWeight: number;
  finalScore: number;
  reasoningBreakdown: string;
}

/**
 * Zero-Downtime Adaptive Deterministic Quantitative Scoring Engine:
 * Dynamically weighs setup confluence, trend alignment, divergence confirmation,
 * wick conviction, and multi-timeframe volatility harmony.
 */
export function computeAdaptiveQuantFallback(snapshot: TechnicalSnapshotPayload): QuantFallbackBreakdown {
  const baseScore = Math.max(65, Math.min(74, Math.round((snapshot.confluence_score || 65) * 0.98)));
  let trendWeight = 0;
  let setupWeight = 0;
  let divergenceWeight = 0;
  let wickWeight = 0;
  let volatilityWeight = 0;
  let rrWeight = 0;

  // 1. Dynamic Trend Alignment (up to +12)
  if (snapshot.regime === 'WITH_TREND') {
    trendWeight = 10;
    if (snapshot.ema200Distance >= 2 && snapshot.ema200Distance <= 90) {
      trendWeight += 2;
    }
  } else {
    // In counter-trend setups, require sharp RSI momentum velocity
    if (Math.abs(snapshot.rsi_slope) >= 2.0) {
      trendWeight += 4;
    }
  }

  // 2. Setup-Specific Confluence (up to +12)
  if (snapshot.setupName === 'SETUP_A_TREND_PULLBACK') {
    setupWeight = 10;
  } else if (snapshot.setupName === 'SETUP_B_BB_EXTREME_SNAPBACK') {
    setupWeight = 9;
  } else if (snapshot.setupName === 'SETUP_C_MOMENTUM_BREAKOUT') {
    setupWeight = 10;
  } else {
    setupWeight = 6;
  }

  // 3. Dynamic Divergence Confirmation (up to +10)
  if (snapshot.divergence_detected) {
    if (snapshot.divergence_type.includes('HIDDEN') && snapshot.regime === 'WITH_TREND') {
      divergenceWeight = 10;
    } else if (snapshot.divergence_type.includes('REGULAR') && snapshot.regime === 'COUNTER_TREND') {
      divergenceWeight = 10;
    } else {
      divergenceWeight = 6;
    }
  }

  // 4. Wick Rejection Strength (up to +8)
  if (snapshot.wick_ratio >= 0.35) {
    wickWeight = 8;
  } else if (snapshot.wick_ratio >= 0.20) {
    wickWeight = 5;
  }

  // 5. Multi-Timeframe Volatility / ATR Ratio Harmony (up to +5)
  const atrRatio = typeof snapshot.atr_ratio === 'number' ? snapshot.atr_ratio : 1.0;
  if (atrRatio >= 0.6 && atrRatio <= 2.0) {
    volatilityWeight = 5;
  }

  // 6. Risk-to-Reward Expectancy (up to +5)
  if (snapshot.riskRewardRatio >= 1.4) {
    rrWeight = 5;
  } else if (snapshot.riskRewardRatio >= 1.1) {
    rrWeight = 3;
  }

  // 7. Pillar 3: Kaufman Efficiency Ratio (ER-10) Microstructure (up to +6 / -15)
  let erWeight = 0;
  if (typeof snapshot.efficiencyRatio === 'number') {
    if (snapshot.efficiencyRatio > 0.68 && snapshot.regime === 'COUNTER_TREND') {
      erWeight = -15; // Runaway one-way trend makes counter-trend dangerous
    } else if (snapshot.efficiencyRatio <= 0.50) {
      erWeight = 6; // Optimal mean-reverting regime
    }
  }

  // 8. Pillar 2: Kronos Volume Profile Gravity (POC Magnet Aligned) (+5)
  let pocWeight = 0;
  if (snapshot.pocMagnetAligned) {
    pocWeight = 5;
  }

  // 9. Pillar 3: Crypto Cross-Asset BTC Guard Safety (-30)
  let btcWeight = 0;
  if (snapshot.marketType === 'CRYPTO' && snapshot.btcGuardStatus) {
    if (snapshot.btcGuardStatus.includes('VETO') || snapshot.btcGuardStatus.includes('DUMP')) {
      btcWeight = -30;
    }
  }

  const rawSum =
    baseScore +
    trendWeight +
    setupWeight +
    divergenceWeight +
    wickWeight +
    volatilityWeight +
    rrWeight +
    erWeight +
    pocWeight +
    btcWeight;
  const finalScore = Math.min(100, Math.max(0, rawSum));

  const parts: string[] = [`Base ${baseScore}`];
  if (trendWeight > 0) parts.push(`Trend +${trendWeight}`);
  if (setupWeight > 0) parts.push(`Setup +${setupWeight}`);
  if (divergenceWeight > 0) parts.push(`Div +${divergenceWeight}`);
  if (wickWeight > 0) parts.push(`Wick +${wickWeight}`);
  if (volatilityWeight > 0) parts.push(`Vol +${volatilityWeight}`);
  if (rrWeight > 0) parts.push(`R:R +${rrWeight}`);
  if (erWeight !== 0) parts.push(`ER-10 ${erWeight > 0 ? '+' : ''}${erWeight}`);
  if (pocWeight > 0) parts.push(`POC Magnet +${pocWeight}`);
  if (btcWeight < 0) parts.push(`BTC VETO ${btcWeight}`);

  const reasoningBreakdown = `[ADAPTIVE QUANT FALLBACK] Score ${finalScore}% (${parts.join(', ')})`;

  return {
    baseScore,
    trendWeight,
    setupWeight,
    divergenceWeight,
    wickWeight,
    volatilityWeight,
    rrWeight,
    finalScore,
    reasoningBreakdown,
  };
}

/**
 * Computes deterministic quantitative fallback score
 */
export function computeQuantFallbackScore(snapshot: TechnicalSnapshotPayload): number {
  return computeAdaptiveQuantFallback(snapshot).finalScore;
}

/**
 * Computes deterministic fallback verdict
 */
export function computeQuantHeuristicVerdict(
  snapshot: TechnicalSnapshotPayload,
  confidenceThreshold: number = 70,
  kronosContext?: KronosQuantContext
): AiJudgeVerdict {
  const breakdown = computeAdaptiveQuantFallback(snapshot);
  let score = breakdown.finalScore;

  // Blend Kronos VPS Directional Confluence if aligned
  if (kronosContext && typeof kronosContext.bullishPct === 'number') {
    if (snapshot.side === 'BUY' && kronosContext.bullishPct >= 58) {
      score = Math.min(100, score + 3);
    } else if (snapshot.side === 'SELL' && kronosContext.bullishPct <= 42) {
      score = Math.min(100, score + 3);
    }
  }

  const decision: 'EXECUTE' | 'REJECT' = score >= confidenceThreshold ? 'EXECUTE' : 'REJECT';
  const kronosTag = kronosContext?.pocPrice
    ? ` | Kronos POC=${kronosContext.pocPrice}, VAH=${kronosContext.vahPrice ?? '-'}, VAL=${kronosContext.valPrice ?? '-'}, Z=${kronosContext.zScore ?? 0}, Regime=${kronosContext.regime || snapshot.regime}`
    : '';

  return {
    decision,
    confidence_score: score,
    recommended_sl_pips: snapshot.proposedSlPips,
    recommended_tp_pips: snapshot.proposedTpPips,
    reasoning: `${breakdown.reasoningBreakdown}${kronosTag}`,
    source: 'HEURISTIC_QUANT_FALLBACK',
    executionAllowed: decision === 'EXECUTE',
    modelsUsed: ['Kronos-Quant-Engine'],
  };
}

/**
 * Parses JSON response from LLM, stripping reasoning model <think>...</think> blocks
 */
export function parseAiJsonResponse(
  rawText: string,
  snapshot: TechnicalSnapshotPayload,
  confidenceThreshold: number = 70
): AiJudgeVerdict {
  try {
    let cleaned = rawText.trim();
    // Strip <think>...</think> reasoning blocks from reasoning models before parsing JSON
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    }
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    const parsed = JSON.parse(cleaned);

    const decision: 'EXECUTE' | 'REJECT' = parsed.decision === 'EXECUTE' ? 'EXECUTE' : 'REJECT';
    const confidence_score = typeof parsed.confidence_score === 'number'
      ? Math.max(0, Math.min(100, parsed.confidence_score))
      : 50;

    const recommended_sl_pips = typeof parsed.recommended_sl_pips === 'number' && parsed.recommended_sl_pips > 0
      ? parsed.recommended_sl_pips
      : snapshot.proposedSlPips;

    const recommended_tp_pips = typeof parsed.recommended_tp_pips === 'number' && parsed.recommended_tp_pips > 0
      ? parsed.recommended_tp_pips
      : snapshot.proposedTpPips;

    const reasoning = parsed.reasoning || 'AI confluence validation complete.';
    const executionAllowed = decision === 'EXECUTE' && confidence_score >= confidenceThreshold;

    return {
      decision,
      confidence_score,
      recommended_sl_pips,
      recommended_tp_pips,
      reasoning,
      source: 'LLM',
      executionAllowed,
    };
  } catch (err) {
    console.warn('[AI Judge] Non-JSON LLM response. Reverting to Quantitative Fallback.');
    return computeQuantHeuristicVerdict(snapshot, confidenceThreshold);
  }
}

interface AiEndpointFailureEntry {
  status: number;
  timestamp: number;
  ttlMs: number;
  warned: boolean;
}

const aiEndpointFailureCache = new Map<string, AiEndpointFailureEntry>();
const AI_FAILURE_CACHE_TTL_MS = 20 * 1000; // 20s server error cache
const AI_RATE_LIMIT_CACHE_TTL_MS = 60 * 1000; // 60s cooldown on HTTP 429 / 402 quota exhaustion

export function resetAiEndpointFailureCache(): void {
  aiEndpointFailureCache.clear();
}

function getFailureTtlForStatus(status: number): number {
  if (status === 429 || status === 402 || status === 401 || status === 403) {
    return AI_RATE_LIMIT_CACHE_TTL_MS;
  }
  return AI_FAILURE_CACHE_TTL_MS;
}

export function isAiEndpointInFallback(config: AiConfig): boolean {
  const cleanKey = (config.apiKey || '').trim();
  const { isLocal } = normalizeAiEndpoint(config.baseUrl || '');

  // For local gateways (9Router, Ollama), an empty API key is allowed only if baseUrl is explicitly set
  if (!isLocal && (!cleanKey || cleanKey.length < 5 || cleanKey.includes('••••••••'))) {
    return true;
  }
  if (!config.baseUrl || !config.baseUrl.trim()) {
    return true;
  }
  const cacheKey = `${config.baseUrl || ''}_${cleanKey}_${config.model || ''}`;
  const entry = aiEndpointFailureCache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp < (entry.ttlMs || AI_FAILURE_CACHE_TTL_MS)) {
    return true;
  }
  return false;
}

/**
 * Evaluates a single provider strictly (throws on HTTP / network / quota error so Promise.allSettled can failover cleanly)
 */
async function evaluateSingleProviderStrict(
  snapshot: TechnicalSnapshotPayload,
  provider: AiProviderInput,
  confidenceThreshold: number,
  kronosContext?: KronosQuantContext
): Promise<AiJudgeVerdict & { providerLabel: string }> {
  const cleanKey = (provider.apiKey || '').trim();
  const rawBaseUrl = (provider.baseUrl || '').trim();
  const model = (provider.model || '').trim() || 'gpt-4o-mini';
  const providerLabel = provider.name ? `${provider.name.split(' ')[0]}:${model}` : model;

  if (!rawBaseUrl) {
    throw new Error('Missing baseUrl');
  }

  const { chatEndpoint, isAnthropic, isLocal } = normalizeAiEndpoint(rawBaseUrl);
  if (!isLocal && (!cleanKey || cleanKey.length < 5 || cleanKey.includes('••••••••'))) {
    throw new Error('Missing API key');
  }

  const effectiveKey = cleanKey || (isLocal ? 'sk-local-9router' : '');
  const cacheKey = `${rawBaseUrl}_${effectiveKey}_${model}`;
  const failureEntry = aiEndpointFailureCache.get(cacheKey);
  if (failureEntry && Date.now() - failureEntry.timestamp < failureEntry.ttlMs) {
    throw new Error(`Provider in failover cooldown (HTTP ${failureEntry.status})`);
  }

  const marketType = snapshot.marketType || (snapshot.symbol.endsWith('USDT') ? 'CRYPTO' : 'FOREX');
  const systemPrompt = buildAiSystemPrompt(marketType);
  const userPrompt = buildAiUserPrompt(snapshot, kronosContext);
  const reasoning = isReasoningModel(model);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 6500);

  try {
    let rawContent = '';

    if (isAnthropic) {
      const response = await fetch(chatEndpoint, {
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

      if (!response.ok) {
        aiEndpointFailureCache.set(cacheKey, {
          status: response.status,
          timestamp: Date.now(),
          ttlMs: getFailureTtlForStatus(response.status),
          warned: true,
        });
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      rawContent = json.content?.[0]?.text || '';
    } else {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${effectiveKey}`,
        'HTTP-Referer': 'https://nmssx.xyz',
        'X-Title': 'NEMESIS x Trade Multi-AI Consensus',
      };

      const basePayload: any = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      };

      if (reasoning) {
        basePayload.max_completion_tokens = 1024;
      } else {
        basePayload.temperature = 0.1;
        basePayload.max_tokens = 512;
      }

      let response = await fetch(chatEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(basePayload),
        signal: controller.signal,
      });

      if (!response.ok && response.status === 400) {
        try {
          const errText = await response.clone().text();
          if (
            errText.includes('system') ||
            errText.includes('temperature') ||
            errText.includes('max_tokens') ||
            errText.includes('max_completion_tokens') ||
            errText.includes('response_format')
          ) {
            const adaptivePayload = {
              model,
              messages: [{ role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }],
            };
            response = await fetch(chatEndpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify(adaptivePayload),
              signal: controller.signal,
            });
          }
        } catch {}
      }

      clearTimeout(timeoutId);

      if (!response.ok) {
        aiEndpointFailureCache.set(cacheKey, {
          status: response.status,
          timestamp: Date.now(),
          ttlMs: getFailureTtlForStatus(response.status),
          warned: true,
        });
        throw new Error(`HTTP ${response.status}`);
      }

      const json = await response.json();
      const choice = json.choices?.[0];
      rawContent = choice?.message?.content || choice?.message?.reasoning_content || '';
    }

    const parsed = parseAiJsonResponse(rawContent, snapshot, confidenceThreshold);
    if (parsed.source !== 'LLM') {
      throw new Error('Invalid JSON output');
    }

    return {
      ...parsed,
      modelsUsed: [providerLabel],
      providerLabel,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (!aiEndpointFailureCache.has(cacheKey)) {
      const status = err.name === 'AbortError' ? 408 : 500;
      aiEndpointFailureCache.set(cacheKey, {
        status,
        timestamp: Date.now(),
        ttlMs: getFailureTtlForStatus(status),
        warned: true,
      });
    }
    throw err;
  }
}

/**
 * Dynamic "Use What Is Connected" Multi-AI Consensus Engine:
 * - Queries all active/enabled AI providers in parallel via Promise.allSettled.
 * - If 1 LLM responds -> uses it as Risk Judge alongside Kronos quant metrics.
 * - If multiple LLMs respond -> aggregates Multi-AI Consensus + Kronos quant metrics (POC, VAH, VAL, RSI, Z-Score, Regime).
 * - Automatic Failover: if a key hits quota/rate limit or all fail/none connected, seamlessly fails over to Kronos Quant Engine.
 */
export async function evaluateMultiAiConsensus(
  snapshot: TechnicalSnapshotPayload,
  providers: AiProviderInput[],
  confidenceThreshold?: number,
  kronosContext?: KronosQuantContext
): Promise<AiJudgeVerdict> {
  const isCrypto = snapshot.marketType === 'CRYPTO' || (snapshot as any).room === 'BINANCE' || Boolean(snapshot.symbol && snapshot.symbol.endsWith('USDT'));
  
  // Calculate Pure Quantitative Autonomous Dynamic Confidence Threshold (58% - 82%)
  const dynamicThresholdResult = calculateDynamicThreshold({
    efficiencyRatio: snapshot.efficiencyRatio,
    pocMagnetAligned: snapshot.pocMagnetAligned,
    kronosProbability: kronosContext?.bullishPct || 50,
    symbol: snapshot.symbol,
    marketType: isCrypto ? 'CRYPTO' : 'FOREX',
  });

  const effectiveThreshold = typeof confidenceThreshold === 'number' && confidenceThreshold > 0 && confidenceThreshold !== 65 && confidenceThreshold !== 56
    ? confidenceThreshold
    : dynamicThresholdResult.threshold;

  // Smart Active-Only Filter: Automatically prune unconfigured cloud providers with empty keys
  const active = Array.isArray(providers)
    ? providers.filter((p) => isProviderGenuinelyConfigured(p as any))
    : [];

  if (active.length === 0) {
    return computeQuantHeuristicVerdict(snapshot, effectiveThreshold, kronosContext);
  }

  const settled = await Promise.allSettled(
    active.map((provider) =>
      evaluateSingleProviderStrict(snapshot, provider, effectiveThreshold, kronosContext)
    )
  );

  const succeeded = settled
    .filter((r): r is PromiseFulfilledResult<AiJudgeVerdict & { providerLabel: string }> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (succeeded.length === 0) {
    // Every connected key timed out or hit rate-limit/quota -> Zero-downtime failover to Kronos Quant Engine
    const fallback = computeQuantHeuristicVerdict(snapshot, effectiveThreshold, kronosContext);
    return {
      ...fallback,
      reasoning: `[AUTO-FAILOVER -> KRONOS QUANT] ${fallback.reasoning}`,
    };
  }

  if (succeeded.length === 1) {
    const single = succeeded[0];
    const kronosNote = kronosContext?.pocPrice
      ? ` [Kronos POC=${kronosContext.pocPrice}, RSI=${kronosContext.rsi ?? snapshot.rsi}, Z=${kronosContext.zScore ?? 0}, ${kronosContext.regime || snapshot.regime}]`
      : '';
    const singleExecutionAllowed = Boolean(
      (single.decision === 'EXECUTE' && single.confidence_score >= effectiveThreshold) ||
      (isCrypto && single.confidence_score >= effectiveThreshold)
    );

    return {
      ...single,
      executionAllowed: singleExecutionAllowed,
      reasoning: `[${single.providerLabel}] ${single.reasoning}${kronosNote}`,
      modelsUsed: [single.providerLabel],
    };
  }

  // Multi-AI Consensus across 2+ active LLMs + Kronos Quant Vote
  const executeVotes = succeeded.filter((v) => v.decision === 'EXECUTE').length;
  const rejectVotes = succeeded.length - executeVotes;
  const avgConfidence = Math.round(
    succeeded.reduce((acc, v) => acc + v.confidence_score, 0) / succeeded.length
  );
  const avgSl = Number(
    (succeeded.reduce((acc, v) => acc + v.recommended_sl_pips, 0) / succeeded.length).toFixed(1)
  );
  const avgTp = Number(
    (succeeded.reduce((acc, v) => acc + v.recommended_tp_pips, 0) / succeeded.length).toFixed(1)
  );

  let consensusDecision: 'EXECUTE' | 'REJECT';
  if (executeVotes > rejectVotes) {
    consensusDecision = 'EXECUTE';
  } else if (rejectVotes > executeVotes) {
    // For Crypto setups where qwen2.5:3b outputs 56-62%, allow execution if score meets dynamic threshold (>= 56)
    consensusDecision = isCrypto && avgConfidence >= effectiveThreshold ? 'EXECUTE' : 'REJECT';
  } else {
    // Tie-breaker via Kronos VPS + Quant Fallback score
    const quantTieBreaker = computeAdaptiveQuantFallback(snapshot).finalScore;
    consensusDecision = quantTieBreaker >= effectiveThreshold ? 'EXECUTE' : 'REJECT';
  }

  const executionAllowed = Boolean(
    (consensusDecision === 'EXECUTE' && avgConfidence >= effectiveThreshold) ||
    (isCrypto && avgConfidence >= effectiveThreshold && (snapshot.confluence_score ?? 0) >= effectiveThreshold)
  );
  const modelsUsed = succeeded.map((s) => s.providerLabel);
  const kronosSuffix = kronosContext?.pocPrice
    ? ` | Kronos POC=${kronosContext.pocPrice}, VAH=${kronosContext.vahPrice ?? '-'}, VAL=${kronosContext.valPrice ?? '-'}, Z=${kronosContext.zScore ?? 0}`
    : '';

  return {
    decision: consensusDecision,
    confidence_score: avgConfidence,
    recommended_sl_pips: avgSl > 0 ? avgSl : snapshot.proposedSlPips,
    recommended_tp_pips: avgTp > 0 ? avgTp : snapshot.proposedTpPips,
    reasoning: `[Multi-AI Consensus ${executeVotes}/${succeeded.length} (${modelsUsed.join(', ')})] ${succeeded[0].reasoning}${kronosSuffix}`,
    source: 'LLM',
    executionAllowed,
    modelsUsed,
  };
}

/**
 * Dispatches technical snapshot to OpenAI-compatible or Anthropic endpoint with strict 6.5s timeout.
 */
export async function evaluateWithAi(
  snapshot: TechnicalSnapshotPayload,
  config: AiConfig,
  kronosContext?: KronosQuantContext
): Promise<AiJudgeVerdict> {
  const confidenceThreshold = config.confidenceThreshold || 70;
  return evaluateMultiAiConsensus(
    snapshot,
    [
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        enabled: true,
      },
    ],
    confidenceThreshold,
    kronosContext
  );
}
