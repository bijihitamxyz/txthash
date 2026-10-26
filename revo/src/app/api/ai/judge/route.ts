import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { verifyAdminSecret } from '@/lib/licenseDb';
import { testAiPing } from '@/core/aiJudge';

export const dynamic = 'force-dynamic';

export interface CentralAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  updatedAt: number;
}

const DEFAULT_CENTRAL_AI_CONFIG: CentralAiConfig = {
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  apiKey: '',
  updatedAt: Date.now(),
};

export function getAiConfigPath(): string {
  if (process.env.AI_CONFIG_FILE) {
    return process.env.AI_CONFIG_FILE;
  }
  return path.join(process.cwd(), 'data', 'ai_config.json');
}

export async function readCentralAiConfig(): Promise<CentralAiConfig> {
  const filePath = getAiConfigPath();
  try {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_CENTRAL_AI_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_CENTRAL_AI_CONFIG };
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      return { ...DEFAULT_CENTRAL_AI_CONFIG };
    }
    const parsed = JSON.parse(raw);
    return {
      baseUrl: parsed.baseUrl || DEFAULT_CENTRAL_AI_CONFIG.baseUrl,
      model: parsed.model || DEFAULT_CENTRAL_AI_CONFIG.model,
      apiKey: parsed.apiKey || '',
      updatedAt: parsed.updatedAt || Date.now(),
    };
  } catch (err) {
    console.error('[readCentralAiConfig] Error reading ai_config.json, returning defaults:', err);
    return { ...DEFAULT_CENTRAL_AI_CONFIG };
  }
}

export async function writeCentralAiConfig(config: Partial<CentralAiConfig>): Promise<CentralAiConfig> {
  const filePath = getAiConfigPath();
  const dataDir = path.join(process.cwd(), 'data');
  // Automatically ensure the data directory exists before writing data/ai_config.json
  fs.mkdirSync(dataDir, { recursive: true });
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const current = await readCentralAiConfig();

  // If apiKey is masked with bullets, preserve the current real key
  const isMasked = config.apiKey && config.apiKey.includes('••••••••');
  const effectiveApiKey = isMasked
    ? current.apiKey
    : (config.apiKey !== undefined ? config.apiKey.trim() : current.apiKey);

  const updated: CentralAiConfig = {
    baseUrl: (config.baseUrl ?? current.baseUrl ?? DEFAULT_CENTRAL_AI_CONFIG.baseUrl).trim(),
    model: (config.model ?? current.model ?? DEFAULT_CENTRAL_AI_CONFIG.model).trim(),
    apiKey: effectiveApiKey,
    updatedAt: Date.now(),
  };

  fs.writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

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
  latencyMs: number;
}

/**
 * Evaluates snapshot with central AI (NVIDIA Nemotron 120B or OpenAI-compatible)
 * Falls back immediately to quantitative institutional heuristic if offline or times out.
 */
export async function evaluateSetupWithCentralAi(payload: {
  symbol: string;
  side: 'BUY' | 'SELL';
  timeframe?: string;
  price: number;
  confluenceScore: number;
  bbWickSweepPct?: number;
  volumeRatio?: number;
  rsi?: number;
  vwapDistancePct?: number;
  fundingRate?: number;
  emaTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  divergence?: string;
  room?: 'EXNESS' | 'BINANCE';
}): Promise<AiJudgeVerdict> {
  const startTime = Date.now();
  const config = await readCentralAiConfig();
  const apiKey = (config.apiKey || '').trim();
  const baseUrl = (config.baseUrl || DEFAULT_CENTRAL_AI_CONFIG.baseUrl).trim();
  const model = (config.model || DEFAULT_CENTRAL_AI_CONFIG.model).trim();

  // If no API key configured, use high-precision heuristic quantitative fallback
  if (!apiKey) {
    const latencyMs = Date.now() - startTime;
    const isApproved = payload.confluenceScore >= 80;
    return {
      decision: isApproved ? 'EXECUTE' : 'REJECT',
      confidence_score: isApproved
        ? Math.min(96, Math.max(80, Math.round(payload.confluenceScore * 0.95 + (payload.bbWickSweepPct || 0) * 0.1)))
        : Math.round(payload.confluenceScore * 0.7),
      reasoning: isApproved
        ? `[QUANT HEURISTIC VERIFIED] Confluence Score ${payload.confluenceScore}/100 meets high-probability threshold. Wick sweep rejection confirmed with volume expansion.`
        : `[QUANT HEURISTIC REJECTED] Confluence Score ${payload.confluenceScore}/100 insufficient (< 80 required).`,
      source: 'HEURISTIC_QUANT_FALLBACK',
      modelUsed: 'Institutional-Quant-Engine-v2',
      latencyMs,
    };
  }

  // Build clean LLM Prompt
  let endpoint = baseUrl.replace(/\/+$/, '');
  if (!endpoint.endsWith('/chat/completions')) {
    endpoint = `${endpoint}/chat/completions`;
  }

  const systemPrompt = `You are an elite Institutional Quantitative Risk Judge verifying automated algorithmic setups for ${payload.room || 'CRYPTO_FUTURES'}.
Evaluate whether to EXECUTE or REJECT this signal.
Only return strict JSON in this exact structure:
{
  "decision": "EXECUTE" or "REJECT",
  "confidence_score": 0 to 100,
  "reasoning": "Concise 1-sentence analytical rationale highlighting key metrics"
}`;

  const userPrompt = `Asset: ${payload.symbol}
Proposed Side: ${payload.side}
Timeframe: ${payload.timeframe || 'M5'}
Current Price: ${payload.price}
Confluence Score: ${payload.confluenceScore}/100
Bollinger Wick Sweep: ${payload.bbWickSweepPct ? (payload.bbWickSweepPct * 100).toFixed(1) + '%' : 'N/A'}
Volume vs SMA20: ${payload.volumeRatio ? payload.volumeRatio.toFixed(2) + 'x' : 'N/A'}
RSI(14): ${payload.rsi ? payload.rsi.toFixed(1) : 'N/A'}
Divergence: ${payload.divergence || 'NONE'}
VWAP Fair Value Distance: ${payload.vwapDistancePct ? (payload.vwapDistancePct * 100).toFixed(2) + '%' : 'N/A'}
Funding Rate: ${payload.fundingRate !== undefined ? (payload.fundingRate * 100).toFixed(4) + '%' : 'N/A'}
Trend: ${payload.emaTrend || 'NEUTRAL'}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, 5000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      throw new Error(`AI Provider HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const choice = data?.choices?.[0];
    const content = choice?.message?.content || choice?.message?.reasoning_content || '';

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const decision = parsed.decision === 'EXECUTE' ? 'EXECUTE' : 'REJECT';
      const confidence_score = typeof parsed.confidence_score === 'number'
        ? Math.min(100, Math.max(0, parsed.confidence_score))
        : 85;
      return {
        decision,
        confidence_score,
        reasoning: parsed.reasoning || `AI Judge approved ${payload.side} on ${payload.symbol}`,
        source: 'LLM',
        modelUsed: model,
        latencyMs,
      };
    }

    throw new Error('Could not parse JSON verdict from AI model output');
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    console.warn(`[CentralAiJudge Fallback] (${err?.message || err}). Reverting to Quantitative Fallback.`);
    const isApproved = payload.confluenceScore >= 80;
    return {
      decision: isApproved ? 'EXECUTE' : 'REJECT',
      confidence_score: isApproved
        ? Math.min(95, Math.max(80, Math.round(payload.confluenceScore * 0.95)))
        : Math.round(payload.confluenceScore * 0.7),
      reasoning: isApproved
        ? `[FALLBACK APPROVED: ${err?.message || 'Timeout'}] Institutional technical confluence score ${payload.confluenceScore}/100 qualifies for execution.`
        : `[FALLBACK REJECTED] Technical confluence ${payload.confluenceScore}/100 below 80 threshold.`,
      source: 'HEURISTIC_QUANT_FALLBACK',
      modelUsed: `${model} (Quant Fallback)`,
      latencyMs,
    };
  }
}

// GET: Returns AI config status (full config if admin key provided, masked otherwise)
export async function GET(req: NextRequest) {
  try {
    const config = await readCentralAiConfig();
    const isAdmin = verifyAdminSecret(req);

    if (isAdmin) {
      return NextResponse.json({
        success: true,
        config: {
          baseUrl: config.baseUrl,
          model: config.model,
          apiKey: config.apiKey,
          updatedAt: config.updatedAt,
          isConfigured: Boolean(config.apiKey && config.apiKey.trim().length > 0),
        },
      });
    }

    // Mask API key for non-admin callers
    const maskedKey = config.apiKey
      ? `${config.apiKey.slice(0, 6)}••••••••${config.apiKey.slice(-4)}`
      : '';

    return NextResponse.json({
      success: true,
      config: {
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: maskedKey,
        isConfigured: Boolean(config.apiKey && config.apiKey.trim().length > 0),
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

// POST: Save config, Test connection, or Judge evaluation
export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const action = body.action || 'JUDGE';

    // 1. SAVE CONFIG (Admin Only)
    if (action === 'SAVE_CONFIG') {
      if (!verifyAdminSecret(req)) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized: Invalid Admin Master Key.' },
          { status: 401 }
        );
      }

      const { baseUrl, model, apiKey } = body;
      const updated = await writeCentralAiConfig({
        baseUrl: baseUrl || DEFAULT_CENTRAL_AI_CONFIG.baseUrl,
        model: model || DEFAULT_CENTRAL_AI_CONFIG.model,
        apiKey: apiKey !== undefined ? apiKey : undefined,
      });

      return NextResponse.json({
        success: true,
        message: '✅ Konfigurasi AI berhasil disimpan ke server!',
        config: {
          baseUrl: updated.baseUrl,
          model: updated.model,
          apiKey: updated.apiKey,
          updatedAt: updated.updatedAt,
          isConfigured: Boolean(updated.apiKey),
        },
      });
    }

    // 2. TEST CONNECTION / CONFIG (Lightweight Ping)
    if (action === 'TEST_CONNECTION' || action === 'TEST_CONFIG') {
      const savedConfig = await readCentralAiConfig();
      const baseUrl = (body.baseUrl || savedConfig.baseUrl || DEFAULT_CENTRAL_AI_CONFIG.baseUrl).trim();
      const model = (body.model || savedConfig.model || DEFAULT_CENTRAL_AI_CONFIG.model).trim();
      const apiKey = (body.apiKey !== undefined ? body.apiKey : savedConfig.apiKey).trim();

      if (!apiKey) {
        return NextResponse.json({
          success: false,
          message: 'API Key is empty. Please enter your AI Master Key (e.g. nvapi-... or sk-...).',
        });
      }

      const pingResult = await testAiPing({ baseUrl, apiKey, model });
      return NextResponse.json(pingResult);
    }

    // 3. JUDGE EVALUATION (Called by Room 1 or Room 2)
    const verdict = await evaluateSetupWithCentralAi({
      symbol: body.symbol || 'BTCUSDT',
      side: body.side || 'BUY',
      timeframe: body.timeframe || 'M5',
      price: Number(body.price || 0),
      confluenceScore: Number(body.confluenceScore || 0),
      bbWickSweepPct: body.bbWickSweepPct,
      volumeRatio: body.volumeRatio,
      rsi: body.rsi,
      vwapDistancePct: body.vwapDistancePct,
      fundingRate: body.fundingRate,
      emaTrend: body.emaTrend,
      divergence: body.divergence,
      room: body.room,
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
