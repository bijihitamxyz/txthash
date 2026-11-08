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
  confidenceThreshold: 70,
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
 * Returns all AI provider slots that are enabled and have valid credentials (or tested local gateway).
 * Dynamically supports 0, 1, or N connected LLMs without hardcoding any mandatory default LLM.
 */
export function getActiveAiProviders(config: CentralAiConfig): AiProviderSlot[] {
  if (!config || config.engineSwitches?.multiAiRiskJudge === false) {
    return [];
  }
  const slots = Array.isArray(config.providers) ? config.providers : [];
  return slots.filter((slot) => {
    if (!slot || slot.enabled === false) return false;
    const cleanUrl = (slot.baseUrl || '').trim();
    if (!cleanUrl) return false;
    const cleanKey = (slot.apiKey || '').trim();
    const { isLocal } = normalizeAiEndpoint(cleanUrl);
    if (isLocal) {
      return cleanKey.length > 0 || slot.lastTestOk === true;
    }
    return cleanKey.length >= 5 && !cleanKey.includes('••••••••');
  });
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
