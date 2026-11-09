import path from 'path';
import { readDataFileAsync, writeDataFileAsync, getDataDir } from '@/lib/dataStore';
import { resetAiEndpointFailureCache, normalizeAiEndpoint } from '@/core/aiJudge';

export interface EngineSwitches {
  kronosForecaster: boolean;
  multiAiRiskJudge: boolean;
  localEaExecutor: boolean;
  exnessWebSocket: boolean;
  restMutexQueue: boolean;
  emergencyKillSwitch: boolean;
}

export interface AiProviderSlot {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  lastTestedAt?: number;
  lastTestOk?: boolean;
  lastLatencyMs?: number;
  lastError?: string;
}

export interface CentralAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  providers: AiProviderSlot[];
  confidenceThreshold: number;
  autoAdaptiveThreshold?: boolean;
  kronosVpsUrl: string;
  kronosApiKey: string;
  engineSwitches: EngineSwitches;
  updatedAt: number;
}

export const DEFAULT_AI_PROVIDER_SLOTS: AiProviderSlot[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude Opus / Sonnet)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    enabled: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter Gateway',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    model: 'anthropic/claude-3.7-sonnet',
    enabled: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    enabled: true,
  },
  {
    id: 'groq',
    name: 'Groq LPU',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    enabled: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-2.5-flash',
    enabled: true,
  },
  {
    id: 'custom',
    name: 'Custom / OpenAI-Compatible Gateway',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: '',
    model: 'meta/llama-3.3-70b-instruct',
    enabled: true,
  },
];

export const DEFAULT_ENGINE_SWITCHES: EngineSwitches = {
  kronosForecaster: true,
  multiAiRiskJudge: true,
  localEaExecutor: true,
  exnessWebSocket: true,
  restMutexQueue: true,
  emergencyKillSwitch: false,
};

export const DEFAULT_CENTRAL_AI_CONFIG: CentralAiConfig = {
  baseUrl: '',
  model: 'Multi-AI Consensus / Risk Governance',
  apiKey: '',
  providers: DEFAULT_AI_PROVIDER_SLOTS.map((s) => ({ ...s })),
  confidenceThreshold: 56,
  autoAdaptiveThreshold: true,
  kronosVpsUrl: process.env.NEXT_PUBLIC_KRONOS_VPS_URL || process.env.KRONOS_VPS_URL || 'http://127.0.0.1:8000',
  kronosApiKey: process.env.NEXT_PUBLIC_KRONOS_API_KEY || process.env.KRONOS_API_KEY || 'nmssx-kronos-secret-2026',
  engineSwitches: { ...DEFAULT_ENGINE_SWITCHES },
  updatedAt: Date.now(),
};

export function getAiConfigPath(): string {
  if (process.env.AI_CONFIG_FILE) {
    return process.env.AI_CONFIG_FILE;
  }
  return path.join(getDataDir(), 'ai_config.json');
}

function normalizeEngineSwitches(raw: any): EngineSwitches {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_ENGINE_SWITCHES };
  }
  return {
    kronosForecaster: typeof raw.kronosForecaster === 'boolean' ? raw.kronosForecaster : DEFAULT_ENGINE_SWITCHES.kronosForecaster,
    multiAiRiskJudge: typeof raw.multiAiRiskJudge === 'boolean' ? raw.multiAiRiskJudge : DEFAULT_ENGINE_SWITCHES.multiAiRiskJudge,
    localEaExecutor: typeof raw.localEaExecutor === 'boolean' ? raw.localEaExecutor : DEFAULT_ENGINE_SWITCHES.localEaExecutor,
    exnessWebSocket: typeof raw.exnessWebSocket === 'boolean' ? raw.exnessWebSocket : DEFAULT_ENGINE_SWITCHES.exnessWebSocket,
    restMutexQueue: typeof raw.restMutexQueue === 'boolean' ? raw.restMutexQueue : DEFAULT_ENGINE_SWITCHES.restMutexQueue,
    emergencyKillSwitch: typeof raw.emergencyKillSwitch === 'boolean' ? raw.emergencyKillSwitch : DEFAULT_ENGINE_SWITCHES.emergencyKillSwitch,
  };
}

function matchSlotIdForBaseUrl(baseUrl: string): string {
  const lower = (baseUrl || '').toLowerCase();
  if (lower.includes('anthropic.com')) return 'anthropic';
  if (lower.includes('openrouter.ai')) return 'openrouter';
  if (lower.includes('api.openai.com')) return 'openai';
  if (lower.includes('groq.com')) return 'groq';
  if (lower.includes('deepseek.com')) return 'deepseek';
  if (lower.includes('generativelanguage.googleapis.com')) return 'gemini';
  return 'custom';
}

export function normalizeProviderSlots(
  rawProviders: any,
  legacy?: { baseUrl?: string; model?: string; apiKey?: string },
  existingSlots?: AiProviderSlot[]
): AiProviderSlot[] {
  const baseMap = new Map<string, AiProviderSlot>();
  for (const def of DEFAULT_AI_PROVIDER_SLOTS) {
    const prev = existingSlots?.find((p) => p.id === def.id);
    baseMap.set(def.id, {
      ...def,
      ...(prev ? { ...prev } : {}),
    });
  }

  if (Array.isArray(rawProviders) && rawProviders.length > 0) {
    for (const item of rawProviders) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || matchSlotIdForBaseUrl(item.baseUrl || '')).trim();
      const fallback = baseMap.get(id) || {
        id,
        name: String(item.name || id.toUpperCase()),
        baseUrl: String(item.baseUrl || ''),
        apiKey: '',
        model: String(item.model || ''),
        enabled: true,
      };
      const rawKey = item.apiKey !== undefined ? String(item.apiKey).trim() : fallback.apiKey;
      const resolvedKey = rawKey.includes('••••••••') ? fallback.apiKey : rawKey;

      baseMap.set(id, {
        id,
        name: String(item.name || fallback.name).trim(),
        baseUrl: String(item.baseUrl ?? fallback.baseUrl).trim(),
        apiKey: resolvedKey,
        model: String(item.model ?? fallback.model).trim(),
        enabled: typeof item.enabled === 'boolean' ? item.enabled : fallback.enabled,
        lastTestedAt: typeof item.lastTestedAt === 'number' ? item.lastTestedAt : fallback.lastTestedAt,
        lastTestOk: typeof item.lastTestOk === 'boolean' ? item.lastTestOk : fallback.lastTestOk,
        lastLatencyMs: typeof item.lastLatencyMs === 'number' ? item.lastLatencyMs : fallback.lastLatencyMs,
        lastError: typeof item.lastError === 'string' ? item.lastError : fallback.lastError,
      });
    }
  } else if (legacy && legacy.apiKey && legacy.apiKey.trim() && !legacy.apiKey.includes('••••••••')) {
    // Migrate legacy single-provider ai_config.json into the matching provider slot
    const targetId = matchSlotIdForBaseUrl(legacy.baseUrl || '');
    const slot = baseMap.get(targetId)!;
    baseMap.set(targetId, {
      ...slot,
      baseUrl: (legacy.baseUrl || slot.baseUrl).trim(),
      model: (legacy.model || slot.model).trim(),
      apiKey: legacy.apiKey.trim(),
      enabled: true,
    });
  }

  return Array.from(baseMap.values());
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

/**
 * Returns all AI provider slots that are genuinely configured and active.
 * Automatically prunes unconfigured cloud providers even if default state was enabled.
 */
export function getActiveAiProviders(config: CentralAiConfig): AiProviderSlot[] {
  if (!config || config.engineSwitches?.multiAiRiskJudge === false) {
    return [];
  }
  const slots = Array.isArray(config.providers) ? config.providers : [];
  return slots.filter((slot) => isProviderGenuinelyConfigured(slot));
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

export function formatActiveAiSummaryLabel(config: CentralAiConfig): string {
  const active = getActiveAiProviders(config);
  if (active.length === 0) {
    return 'Kronos Quant Engine (No External LLM Connected)';
  }
  if (active.length === 1) {
    return `${active[0].name.split(' ')[0]} · ${active[0].model}`;
  }
  return `Multi-AI Consensus (${active.length} Active: ${active.map((a) => a.name.split(' ')[0]).join(', ')})`;
}

export async function readCentralAiConfig(): Promise<CentralAiConfig> {
  try {
    const raw = await readDataFileAsync('ai_config.json', JSON.stringify(DEFAULT_CENTRAL_AI_CONFIG, null, 2));
    if (!raw.trim()) {
      return {
        ...DEFAULT_CENTRAL_AI_CONFIG,
        providers: DEFAULT_AI_PROVIDER_SLOTS.map((s) => ({ ...s })),
        engineSwitches: { ...DEFAULT_ENGINE_SWITCHES },
      };
    }
    const parsed = JSON.parse(raw);
    const providers = normalizeProviderSlots(parsed.providers, {
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      apiKey: parsed.apiKey,
    });

    const tempConfig: CentralAiConfig = {
      baseUrl: parsed.baseUrl || '',
      model: parsed.model || 'Multi-AI Consensus / Risk Governance',
      apiKey: parsed.apiKey || '',
      providers,
      confidenceThreshold:
        typeof parsed.confidenceThreshold === 'number'
          ? parsed.confidenceThreshold
          : DEFAULT_CENTRAL_AI_CONFIG.confidenceThreshold,
      autoAdaptiveThreshold:
        typeof parsed.autoAdaptiveThreshold === 'boolean'
          ? parsed.autoAdaptiveThreshold
          : true,
      kronosVpsUrl: parsed.kronosVpsUrl || DEFAULT_CENTRAL_AI_CONFIG.kronosVpsUrl,
      kronosApiKey: parsed.kronosApiKey || DEFAULT_CENTRAL_AI_CONFIG.kronosApiKey,
      engineSwitches: normalizeEngineSwitches(parsed.engineSwitches),
      updatedAt: parsed.updatedAt || Date.now(),
    };

    const active = getActiveAiProviders(tempConfig);
    if (active.length > 0) {
      tempConfig.baseUrl = active[0].baseUrl;
      tempConfig.apiKey = active[0].apiKey;
      tempConfig.model =
        active.length === 1
          ? active[0].model
          : `Multi-AI Consensus (${active.length} Models)`;
    } else {
      tempConfig.baseUrl = '';
      tempConfig.apiKey = '';
      tempConfig.model = 'Multi-AI Consensus / Risk Governance';
    }

    return tempConfig;
  } catch (err) {
    console.error('[readCentralAiConfig] Error reading ai_config.json, returning defaults:', err);
    return {
      ...DEFAULT_CENTRAL_AI_CONFIG,
      providers: DEFAULT_AI_PROVIDER_SLOTS.map((s) => ({ ...s })),
      engineSwitches: { ...DEFAULT_ENGINE_SWITCHES },
    };
  }
}

export async function writeCentralAiConfig(
  config: Partial<Omit<CentralAiConfig, 'engineSwitches' | 'providers'>> & {
    engineSwitches?: Partial<EngineSwitches>;
    providers?: Partial<AiProviderSlot>[];
  }
): Promise<CentralAiConfig> {
  try {
    const current = await readCentralAiConfig();

    const isKronosMasked = config.kronosApiKey && config.kronosApiKey.includes('••••••••');
    const effectiveKronosKey = isKronosMasked
      ? current.kronosApiKey
      : config.kronosApiKey !== undefined && config.kronosApiKey.trim()
      ? config.kronosApiKey.trim()
      : current.kronosApiKey || DEFAULT_CENTRAL_AI_CONFIG.kronosApiKey;

    const mergedSwitches: EngineSwitches = normalizeEngineSwitches({
      ...current.engineSwitches,
      ...(config.engineSwitches || {}),
    });

    let mergedProviders = current.providers;
    if (Array.isArray(config.providers)) {
      mergedProviders = normalizeProviderSlots(config.providers, undefined, current.providers);
    } else if (config.apiKey !== undefined || config.baseUrl !== undefined || config.model !== undefined) {
      const isMasked = config.apiKey && config.apiKey.includes('••••••••');
      const effectiveApiKey = isMasked
        ? current.apiKey
        : config.apiKey !== undefined
        ? config.apiKey.trim()
        : current.apiKey;
      const targetUrl = (config.baseUrl ?? current.baseUrl).trim();
      const targetModel = (config.model ?? current.model).trim();
      if (targetUrl) {
        const slotId = matchSlotIdForBaseUrl(targetUrl);
        mergedProviders = current.providers.map((s) =>
          s.id === slotId
            ? {
                ...s,
                baseUrl: targetUrl,
                model: targetModel || s.model,
                apiKey: effectiveApiKey,
                enabled: Boolean(effectiveApiKey) || s.enabled,
              }
            : s
        );
      }
    }

    const updated: CentralAiConfig = {
      baseUrl: '',
      model: 'Multi-AI Consensus / Risk Governance',
      apiKey: '',
      providers: mergedProviders,
      confidenceThreshold:
        typeof config.confidenceThreshold === 'number'
          ? config.confidenceThreshold
          : current.confidenceThreshold ?? DEFAULT_CENTRAL_AI_CONFIG.confidenceThreshold,
      autoAdaptiveThreshold:
        typeof config.autoAdaptiveThreshold === 'boolean'
          ? config.autoAdaptiveThreshold
          : current.autoAdaptiveThreshold ?? true,
      kronosVpsUrl: (
        config.kronosVpsUrl ??
        current.kronosVpsUrl ??
        DEFAULT_CENTRAL_AI_CONFIG.kronosVpsUrl
      ).trim(),
      kronosApiKey: effectiveKronosKey,
      engineSwitches: mergedSwitches,
      updatedAt: Date.now(),
    };

    const active = getActiveAiProviders(updated);
    if (active.length > 0) {
      updated.baseUrl = active[0].baseUrl;
      updated.apiKey = active[0].apiKey;
      updated.model =
        active.length === 1
          ? active[0].model
          : `Multi-AI Consensus (${active.length} Models)`;
    }

    await writeDataFileAsync('ai_config.json', JSON.stringify(updated, null, 2));
    resetAiEndpointFailureCache();
    return updated;
  } catch (err) {
    console.error('[writeCentralAiConfig] Error writing ai_config.json:', err);
    return {
      ...DEFAULT_CENTRAL_AI_CONFIG,
      providers: DEFAULT_AI_PROVIDER_SLOTS.map((s) => ({ ...s })),
      engineSwitches: normalizeEngineSwitches(config.engineSwitches),
      updatedAt: Date.now(),
    };
  }
}
