import { NextRequest, NextResponse } from 'next/server';
import { testAiPing } from '@/core/aiJudge';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const result = await testAiPing({
      baseUrl: body.baseUrl || body.aiBaseUrl || 'https://api.openai.com/v1',
      apiKey: body.apiKey || body.aiApiKey || '',
      model: body.model || body.aiModel || 'gpt-4o-mini',
    });

    return NextResponse.json(
      { ok: result.success, success: result.success, data: result, message: result.message },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}
