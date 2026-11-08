import { NextRequest, NextResponse } from 'next/server';
import {
  loadVaultCredentials,
  saveVaultCredentials,
  clearVaultCredentials,
  hasVaultCredentials,
  getMaskedVaultCredentials,
  ExnessVaultCredentials,
} from '@/core/exnessVault';
import { ExnessClient } from '@/core/exnessClient';
import { stateSync } from '@/lib/stateSync';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const creds = await loadVaultCredentials();
    return NextResponse.json({
      success: true,
      hasCredentials: hasVaultCredentials(),
      credentials: getMaskedVaultCredentials(creds),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to read vault' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { accountId, mode, server, apiKey, privateKey } = body;

    if (!accountId || !apiKey || !privateKey) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing required credentials: accountId, apiKey, and privateKey are mandatory.',
        },
        { status: 400 }
      );
    }

    const newCreds: ExnessVaultCredentials = {
      accountId: String(accountId).trim(),
      mode: mode === 'REAL' ? 'REAL' : 'DEMO',
      server: String(server || 'https://api.exness-api.com').trim(),
      apiKey: String(apiKey).trim(),
      privateKey: String(privateKey).trim(),
      updatedAt: Date.now(),
    };

    await saveVaultCredentials(newCreds);

    return NextResponse.json({
      success: true,
      message: `Credentials safely stored in AES-256 Vault (${newCreds.mode} Mode)`,
      credentials: getMaskedVaultCredentials(newCreds),
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to save vault credentials' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await clearVaultCredentials();
    ExnessClient.clearAllLivePositions();
    await stateSync.updateRuntimeState({ positions: [], isAutoTrading: false }).catch(() => {});
    return NextResponse.json({
      success: true,
      message: 'AES-256 Vault cleared successfully',
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to clear vault' },
      { status: 500 }
    );
  }
}
