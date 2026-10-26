import { NextRequest, NextResponse } from 'next/server';
import { evaluateWithAi, AiConfig, DEFAULT_AI_CONFIG } from '@/core/aiJudge';
import { TechnicalSnapshotPayload } from '@/core/signalGate';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { snapshot, aiConfig } = body as {
      snapshot: TechnicalSnapshotPayload;
      aiConfig?: Partial<AiConfig>;
    };

    if (!snapshot || !snapshot.symbol || !snapshot.side) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing technical snapshot payload' },
        { status: 400 }
      );
    }

    const mergedConfig: AiConfig = {
      ...DEFAULT_AI_CONFIG,
      ...aiConfig,
    };

    const verdict = await evaluateWithAi(snapshot, mergedConfig);

    return NextResponse.json({
      success: true,
      data: verdict,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'AI Judge evaluation failed' },
      { status: 500 }
    );
  }
}
