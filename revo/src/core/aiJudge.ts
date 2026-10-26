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
}

export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  confidenceThreshold: number; // default 70
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  confidenceThreshold: 70,
};

export interface AiTestPingResult {
  success: boolean;
  message: string;
  modelResponse?: string;
  model?: string;
  latencyMs?: number;
}

/**
 * Sends a lightweight test ping ("Hi") to the configured custom API Base URL
 * using the provided API Key and Model.
 * Automatically fetches, validates, and returns the exact model response or a success indicator.
 */
export async function testAiPing(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<AiTestPingResult> {
  const apiKey = (config.apiKey || '').trim();
  const baseUrl = (config.baseUrl || '').trim();
  const model = (config.model || '').trim() || 'gpt-4o-mini';

  if (!apiKey) {
    return {
      success: false,
      message: 'Invalid AI Configuration: API Key is required to test endpoint',
    };
  }

  if (!baseUrl) {
    return {
      success: false,
      message: 'Invalid AI Configuration: Base URL is required',
    };
  }

  let endpoint = baseUrl.replace(/\/+$/, '');
  if (!endpoint.endsWith('/chat/completions')) {
    endpoint = `${endpoint}/chat/completions`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 8000);

  const startTime = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 256,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errDetail = '';
      try {
        const errJson = await response.json();
        errDetail = errJson.error?.message || JSON.stringify(errJson);
      } catch {
        errDetail = response.statusText || `HTTP ${response.status}`;
      }
      return {
        success: false,
        message: `AI Endpoint returned HTTP ${response.status}: ${errDetail}`,
        latencyMs,
      };
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const rawReply = choice?.message?.content || choice?.message?.reasoning_content || 'OK — Engine Ready';
    const reply = typeof rawReply === 'string' ? rawReply.trim() : 'OK — Engine Ready';

    return {
      success: true,
      message: '✅ Connected: Model responded successfully',
      modelResponse: reply || 'OK — Engine Ready',
      model,
      latencyMs,
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    if (err.name === 'AbortError') {
      return {
        success: false,
        message: 'AI Endpoint timed out (>8000ms). Check your Base URL or network connection.',
        latencyMs,
      };
    }
    return {
      success: false,
      message: `AI Test Ping failed: ${err.message || 'Unknown network error'}`,
      latencyMs,
    };
  }
}

/**
 * Builds system prompt for institutional quantitative confluence
 */
export function buildAiSystemPrompt(): string {
  return `You are an elite Institutional Quantitative Risk Officer and Confluence Judge for Forex & Gold algorithmic trading.
Evaluate the technical setup qualified by our 3-Regime Multi-Strategy Engine:
- SETUP_A_TREND_PULLBACK: Trend continuation bounce off Middle BB (SMA 20) with RSI momentum curl aligned with EMA 200.
- SETUP_B_BB_EXTREME_SNAPBACK: Relaxed Bollinger Band extreme breach/touch with RSI mean-reversion, wick absorption, or divergence.
- SETUP_C_MOMENTUM_BREAKOUT: Bollinger Band Width expansion with large impulse candle body (>1.2x avg) and RSI directional surge.

Scrutinize:
1. Setup Type (SETUP_A_TREND_PULLBACK, SETUP_B_BB_EXTREME_SNAPBACK, or SETUP_C_MOMENTUM_BREAKOUT) & Confluence Score.
2. Market Regime & Trend Alignment (Price relative to EMA 200).
3. Volatility & Multi-Timeframe ATR Ratio ('atr_ratio' expansion relative to baseline ATR).
4. Wick Rejection Strength ('HIGH_CONVICTION' >= 0.35, 'MODERATE' >= 0.20, or 'WEAK').
5. Support / Resistance Proximity: Distance to key S/R boundaries and room to run.
6. RSI Reversal Velocity / Slope and 15-candle Divergence confluence.
7. Risk-to-Reward ratio expectancy.

You must respond with ONLY a strict JSON object matching this schema without markdown fences or other text:
{
  "decision": "EXECUTE" | "REJECT",
  "confidence_score": <number 0-100>,
  "recommended_sl_pips": <number>,
  "recommended_tp_pips": <number>,
  "reasoning": "<concise 1-sentence explanation>"
}`;
}

/**
 * Builds user prompt containing structured technical snapshot
 */
export function buildAiUserPrompt(snapshot: TechnicalSnapshotPayload): string {
  return `TECHNICAL SNAPSHOT:
- Symbol: ${snapshot.symbol} (${snapshot.timeframe})
- Proposed Action: ${snapshot.side}
- Setup Type: ${snapshot.setupName || snapshot.signalType} (Regime: ${snapshot.regime}, Gate Confluence Score: ${snapshot.confluence_score ?? 65}/100)
- Trigger Price: ${snapshot.triggerPrice}
- RSI (14): ${snapshot.rsi} (Reversal Slope: ${snapshot.rsi_slope > 0 ? '+' : ''}${snapshot.rsi_slope})
- BB Position: ${snapshot.bb_position_pct ?? 50}%
- Wick Rejection Strength: ${snapshot.wick_rejection_strength} (Wick Ratio: ${snapshot.wick_ratio})
- Volatility Metrics: ATR(14) ${snapshot.atr_pips} pips, Candle/ATR Ratio: ${snapshot.atr_ratio}x (${snapshot.volatility_regime})
- Bollinger Band Width Expansion: ${snapshot.bbw_expansion_pct}%
- S/R Distance: Support ${snapshot.distance_to_support_pips} pips (${snapshot.support_price}), Resistance ${snapshot.distance_to_resistance_pips} pips (${snapshot.resistance_price})
- 15-Candle Divergence: ${snapshot.divergence_detected ? `DETECTED (${snapshot.divergence_type})` : 'NONE'}
- Distance from EMA 200: ${snapshot.ema200Distance} pips
- Initial SL: ${snapshot.proposedSlPips} pips (${snapshot.proposedSlPrice})
- Opposite BB TP: ${snapshot.proposedTpPips} pips (${snapshot.proposedTpPrice})
- Risk-Reward: ${snapshot.riskRewardRatio}:1

Return strict JSON only.`;
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

  const rawSum = baseScore + trendWeight + setupWeight + divergenceWeight + wickWeight + volatilityWeight + rrWeight;
  const finalScore = Math.min(100, Math.max(0, rawSum));

  const parts: string[] = [`Base ${baseScore}`];
  if (trendWeight > 0) parts.push(`Trend +${trendWeight}`);
  if (setupWeight > 0) parts.push(`Setup +${setupWeight}`);
  if (divergenceWeight > 0) parts.push(`Div +${divergenceWeight}`);
  if (wickWeight > 0) parts.push(`Wick +${wickWeight}`);
  if (volatilityWeight > 0) parts.push(`Vol +${volatilityWeight}`);
  if (rrWeight > 0) parts.push(`R:R +${rrWeight}`);

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
  confidenceThreshold: number = 70
): AiJudgeVerdict {
  const breakdown = computeAdaptiveQuantFallback(snapshot);
  const score = breakdown.finalScore;
  const decision: 'EXECUTE' | 'REJECT' = score >= confidenceThreshold ? 'EXECUTE' : 'REJECT';

  return {
    decision,
    confidence_score: score,
    recommended_sl_pips: snapshot.proposedSlPips,
    recommended_tp_pips: snapshot.proposedTpPips,
    reasoning: breakdown.reasoningBreakdown,
    source: 'HEURISTIC_QUANT_FALLBACK',
    executionAllowed: decision === 'EXECUTE',
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

/**
 * Dispatches technical snapshot to OpenAI-compatible endpoint with strict 6.0s timeout
 */
export async function evaluateWithAi(
  snapshot: TechnicalSnapshotPayload,
  config: AiConfig
): Promise<AiJudgeVerdict> {
  const confidenceThreshold = config.confidenceThreshold || 70;

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    return computeQuantHeuristicVerdict(snapshot, confidenceThreshold);
  }

  const systemPrompt = buildAiSystemPrompt();
  const userPrompt = buildAiUserPrompt(snapshot);
  const endpoint = config.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  const controller = new AbortController();
  // 6.0-second timeout per specification
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: config.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[AI Judge] LLM HTTP error ${response.status}. Reverting to Quantitative Fallback.`);
      return computeQuantHeuristicVerdict(snapshot, confidenceThreshold);
    }

    const json = await response.json();
    const rawContent = json.choices?.[0]?.message?.content || '';
    return parseAiJsonResponse(rawContent, snapshot, confidenceThreshold);
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.warn('[AI Judge] LLM timed out (>6.0s). Engaging Quantitative Fallback.');
    } else {
      console.warn('[AI Judge] LLM request error:', err.message);
    }
    return computeQuantHeuristicVerdict(snapshot, confidenceThreshold);
  }
}
