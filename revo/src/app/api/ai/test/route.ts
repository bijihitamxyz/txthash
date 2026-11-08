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
    const rawApiKey = (body.apiKey ?? body.aiApiKey ?? '').trim();
    const effectiveApiKey =
      rawApiKey && !rawApiKey.includes('••••••••')
        ? rawApiKey
        : (savedCentral.apiKey || '');

    const result = await testAiPing({
      baseUrl: (body.baseUrl || body.aiBaseUrl || savedCentral.baseUrl || 'http://localhost:20128/v1').trim(),
      apiKey: effectiveApiKey,
      model: (body.model || body.aiModel || savedCentral.model || 'gpt-4o-mini').trim(),
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
