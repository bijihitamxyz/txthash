import { NextRequest, NextResponse } from 'next/server';
import { evaluateMultiAiConsensus } from '@/core/aiJudge';
import { readCentralAiConfig, getActiveAiProviders } from '@/core/centralAiConfig';
import { TechnicalSnapshotPayload } from '@/core/signalGate';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { snapshot } = body as {
      snapshot: TechnicalSnapshotPayload;
    };

    if (!snapshot || !snapshot.symbol || !snapshot.side) {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing technical snapshot payload' },
        { status: 400 }
      );
    }

    const centralAi = await readCentralAiConfig();
    const activeProviders = getActiveAiProviders(centralAi);
    const verdict = await evaluateMultiAiConsensus(
      snapshot,
      activeProviders,
      centralAi.confidenceThreshold || 70
    );

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
