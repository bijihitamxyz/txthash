import { NextRequest, NextResponse } from 'next/server';
import { normalizeAiEndpoint } from '@/core/aiJudge';
import { verifyAdminSecret } from '@/lib/licenseDb';
import { readCentralAiConfig } from '@/core/centralAiConfig';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        {
          success: false,
          message: 'Unauthorized: Admin Master Key required to query AI provider models.',
          models: [],
        },
        { status: 401 }
      );
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const savedCentral = await readCentralAiConfig();
    const providerId = body.providerId ? String(body.providerId).trim() : '';
    const matchedSlot = providerId
      ? savedCentral.providers.find((p) => p.id === providerId)
      : undefined;
    const rawBaseUrl =
      (body.baseUrl || body.aiBaseUrl || matchedSlot?.baseUrl || savedCentral.baseUrl || '').trim() ||
      'https://api.openai.com/v1';
    const rawInputKey = (body.apiKey || body.aiApiKey || '').trim();
    const apiKey =
      rawInputKey && !rawInputKey.includes('••••••••')
        ? rawInputKey
        : (matchedSlot?.apiKey || savedCentral.apiKey || '').trim();

    const { modelsEndpoint, isAnthropic, isLocal } = normalizeAiEndpoint(rawBaseUrl);
    const effectiveKey = apiKey || (isLocal ? 'sk-local-9router' : '');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      try {
        controller.abort();
      } catch {}
    }, 8000);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://nmssx.xyz',
      'X-Title': 'NEMESIS x Trade Multi-AI Consensus',
    };

    if (isAnthropic) {
      if (effectiveKey) {
        headers['x-api-key'] = effectiveKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    } else if (effectiveKey) {
      headers['Authorization'] = `Bearer ${effectiveKey}`;
    }

    try {
      const response = await fetch(modelsEndpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (isLocal && (rawBaseUrl.includes('11434') || rawBaseUrl.includes('ollama'))) {
          try {
            const ollamaTagsUrl = rawBaseUrl.replace(/\/v1\/?$/, '') + '/api/tags';
            const ollamaRes = await fetch(ollamaTagsUrl);
            if (ollamaRes.ok) {
              const tagsData = await ollamaRes.json();
              const models = (tagsData.models || []).map((m: any) => m.name || m.model);
              if (models.length > 0) {
                return NextResponse.json({
                  success: true,
                  source: 'ollama_tags',
                  models,
                  count: models.length,
                });
              }
            }
          } catch {}
        }

        let errDetail = '';
        try {
          const errJson = await response.json();
          errDetail = errJson.error?.message || errJson.message || JSON.stringify(errJson);
        } catch {
          errDetail = `HTTP ${response.status}: ${response.statusText}`;
        }

        return NextResponse.json({
          success: false,
          message: `Endpoint returned HTTP ${response.status}: ${errDetail}`,
          models: [],
        });
      }

      const data = await response.json();
      let modelList: string[] = [];

      if (Array.isArray(data.data)) {
        modelList = data.data.map((m: any) => m.id).filter(Boolean);
      } else if (Array.isArray(data.models)) {
        modelList = data.models.map((m: any) => m.id || m.name || m).filter(Boolean);
      } else if (Array.isArray(data)) {
        modelList = data.map((m: any) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
      }

      modelList.sort((a, b) => a.localeCompare(b));

      return NextResponse.json({
        success: true,
        models: modelList,
        count: modelList.length,
        is9Router: isLocal,
      });
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);

      if (fetchErr.name === 'AbortError') {
        return NextResponse.json({
          success: false,
          message: 'Model list request timed out (>8000ms). Verify Base URL and network connectivity.',
          models: [],
        });
      }

      return NextResponse.json({
        success: false,
        message: `Failed to fetch model list: ${fetchErr.message || 'Network error'}`,
        models: [],
      });
    }
  } catch (err: any) {
    return NextResponse.json({
      success: false,
      message: err.message || 'Internal server error while fetching models',
      models: [],
    });
  }
}
