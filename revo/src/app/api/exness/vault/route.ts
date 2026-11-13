import { NextRequest, NextResponse } from 'next/server';
import {
  loadVaultCredentials,
  saveVaultCredentials,
  clearVaultCredentials,
  getMaskedVaultCredentials,
} from '@/core/exnessVault';
import { encryptCredential, decryptCredential } from '@/lib/cryptoVault';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const creds = await loadVaultCredentials();
    if (!creds) {
      return NextResponse.json(
        { ok: true, success: true, hasCredentials: false, credentials: null },
        { status: 200 }
      );
    }
    return NextResponse.json(
      {
        ok: true,
        success: true,
        hasCredentials: true,
        credentials: {
          mode: creds.mode,
          accountId: creds.accountId,
          server: creds.server,
          apiKey: creds.apiKey,
          masked: getMaskedVaultCredentials(creds),
          updatedAt: creds.updatedAt,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, hasCredentials: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '').toLowerCase();

    // Server-side AES-256-GCM fallback for HTTP non-localhost browsers where window.crypto.subtle is undefined
    if (action === 'encrypt') {
      const plaintext = typeof body?.plaintext === 'string' ? body.plaintext : '';
      if (!plaintext) {
        return NextResponse.json({ ok: true, success: true, encrypted: '' }, { status: 200 });
      }
      const encrypted = await encryptCredential(plaintext);
      return NextResponse.json({ ok: true, success: true, encrypted }, { status: 200 });
    }

    if (action === 'decrypt') {
      const encryptedBase64 = typeof body?.encryptedBase64 === 'string' ? body.encryptedBase64 : '';
      if (!encryptedBase64) {
        return NextResponse.json({ ok: true, success: true, plaintext: '' }, { status: 200 });
      }
      const plaintext = await decryptCredential(encryptedBase64);
      return NextResponse.json({ ok: true, success: true, plaintext }, { status: 200 });
    }

    // Save Exness credentials directly to server-side Node.js AES-256-GCM vault
    const c = body?.credentials || body;
    if (c?.accountId && c?.apiKey && c?.privateKey) {
      await saveVaultCredentials({
        accountId: String(c.accountId).trim(),
        mode: c.mode === 'REAL' ? 'REAL' : 'DEMO',
        server: String(c.server || 'https://api.exness-api.com').trim(),
        apiKey: String(c.apiKey).trim(),
        privateKey: String(c.privateKey).trim(),
        updatedAt: Date.now(),
      });
      return NextResponse.json({ ok: true, success: true }, { status: 200 });
    }

    return NextResponse.json(
      { ok: false, success: false, error: 'Unsupported vault action or missing credentials' },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}

export async function DELETE() {
  try {
    await clearVaultCredentials();
    return NextResponse.json({ ok: true, success: true }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}
