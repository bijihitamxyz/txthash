import { NextRequest, NextResponse } from 'next/server';
import { testAiPing } from '@/core/aiJudge';
import { ExnessClient } from '@/core/exnessClient';
import { verifyAdminSecret } from '@/lib/licenseDb';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { ok: true, success: true, message: 'Validation API endpoint ready' },
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { ok: false, success: false, message: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const { type, action, baseUrl, apiKey, model, credentials, payload } = body;

    // Detect if this is an AI BYOK validation request
    const isAi =
      type === 'ai' ||
      action === 'test-ai' ||
      Boolean(baseUrl || (payload && payload.baseUrl) || (credentials && credentials.aiApiKey));

    if (isAi) {
      if (!verifyAdminSecret(req)) {
        return NextResponse.json(
          {
            ok: false,
            success: false,
            message: 'Unauthorized: AI provider configuration is restricted to Admin Dashboard.',
          },
          { status: 401 }
        );
      }
      const targetBaseUrl =
        baseUrl || payload?.baseUrl || payload?.aiBaseUrl || credentials?.aiBaseUrl || 'https://api.openai.com/v1';
      const targetApiKey =
        apiKey || payload?.apiKey || payload?.aiApiKey || credentials?.aiApiKey || '';
      const targetModel =
        model || payload?.model || payload?.aiModel || credentials?.aiModel || 'gpt-4o-mini';

      const result = await testAiPing({
        baseUrl: targetBaseUrl,
        apiKey: targetApiKey,
        model: targetModel,
      });

      return NextResponse.json(
        {
          ok: result.success,
          success: result.success,
          data: result,
          message: result.message,
        },
        { status: 200 }
      );
    }

    // Exness credentials validation request
    const exnessCreds = credentials || payload || {
      accountId: body.accountId,
      server: body.server || 'Exness-MT5Trial',
      apiKey: body.apiKey || body.token || body.password,
      privateKey: body.privateKey || body.apiKey || body.token || body.password,
    };

    const client = new ExnessClient(exnessCreds);
    const testResult = await client.testConnection();

    return NextResponse.json(
      {
        ok: testResult.success,
        success: testResult.success,
        data: testResult,
        message: testResult.message,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        success: false,
        message: `Validation request error: ${err?.message || 'Internal error'}`,
      },
      { status: 200 }
    );
  }
}
