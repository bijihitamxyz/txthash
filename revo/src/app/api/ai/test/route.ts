import { NextRequest, NextResponse } from 'next/server';
import { testAiPing } from '@/core/aiJudge';
import { readCentralAiConfig } from '@/core/centralAiConfig';
import { verifyAdminSecret } from '@/lib/licenseDb';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        {
          ok: false,
          success: false,
          error: 'Unauthorized: Admin Master Key required to test AI provider configuration.',
        },
        { status: 401 }
      );
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const savedCentral = await readCentralAiConfig();
    const providerId = body.providerId || body.id ? String(body.providerId || body.id).trim() : '';
    const rawBaseUrl = (body.baseUrl || body.aiBaseUrl || '').trim();
    const matchedSlot = savedCentral.providers?.find(
      (p) => (providerId && p.id === providerId) || (rawBaseUrl && p.baseUrl === rawBaseUrl)
    );
    const rawApiKey = (body.apiKey ?? body.aiApiKey ?? '').trim();
    const effectiveApiKey =
      rawApiKey && !rawApiKey.includes('••••••••')
        ? rawApiKey
        : (matchedSlot?.apiKey || savedCentral.apiKey || '');

    const result = await testAiPing({
      baseUrl: (rawBaseUrl || matchedSlot?.baseUrl || savedCentral.baseUrl || 'http://localhost:20128/v1').trim(),
      apiKey: effectiveApiKey,
      model: (body.model || body.aiModel || matchedSlot?.model || savedCentral.model || 'gpt-4o-mini').trim(),
    });

    return NextResponse.json(
      {
        ok: result.success,
        success: result.success,
        data: result,
        message: result.message,
        latencyMs: result.latencyMs,
        modelResponse: result.modelResponse,
        model: result.model,
        providerType: result.providerType,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}
