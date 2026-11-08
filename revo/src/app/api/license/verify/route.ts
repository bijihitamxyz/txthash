import { NextRequest, NextResponse } from 'next/server';
import {
  verifyLicenseKey,
  createLicenseRecord,
  LicenseDuration,
} from '@/lib/licenseDb';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { valid: false, message: 'Invalid JSON payload in request body.' },
        { status: 400 }
      );
    }

    // User Registration flow: generates & persists a new license access key
    if (body.action === 'REGISTER') {
      const rawUsername = typeof body.username === 'string' ? body.username.trim() : '';
      const rawTelegram = typeof body.telegram === 'string' ? body.telegram.trim() : '';
      const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';
      const validDuration: LicenseDuration = body.duration === '30d' ? '30d' : '7d';

      const effectiveUsername = rawUsername || rawTelegram.replace(/^@/, '');
      const effectiveTelegram = rawTelegram || rawUsername;

      if (!effectiveUsername || effectiveUsername.length < 2) {
        return NextResponse.json(
          {
            valid: false,
            message: 'Username minimal 2 karakter wajib diisi untuk registrasi key.',
          },
          { status: 400 }
        );
      }

      if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
        return NextResponse.json(
          {
            valid: false,
            message: 'Format alamat email tidak valid.',
          },
          { status: 400 }
        );
      }

      const created = await createLicenseRecord({
        username: effectiveUsername,
        telegram: effectiveTelegram || effectiveUsername,
        email: rawEmail || undefined,
        duration: validDuration,
      });

      return NextResponse.json(
        {
          valid: true,
          registered: true,
          licenseKey: created.licenseKey,
          username: created.username,
          telegram: created.telegram,
          email: created.email,
          duration: created.duration,
          expiresAt: created.expiresAt,
          createdAt: created.createdAt,
          status: created.status,
          message: `Access Key ${created.licenseKey} berhasil diregistrasi (${created.duration.toUpperCase()}).`,
        },
        { status: 201 }
      );
    }

    const { licenseKey } = body;
    if (!licenseKey || typeof licenseKey !== 'string' || !licenseKey.trim()) {
      return NextResponse.json(
        { valid: false, message: 'License key is required.' },
        { status: 400 }
      );
    }

    const result = await verifyLicenseKey(licenseKey);

    if (!result.valid || !result.license) {
      return NextResponse.json(
        {
          valid: false,
          status: result.license?.status || 'NOT_FOUND',
          message: result.message,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        valid: true,
        licenseKey: result.license.licenseKey,
        username: result.license.username,
        telegram: result.license.telegram,
        email: result.license.email,
        duration: result.license.duration,
        expiresAt: result.license.expiresAt,
        createdAt: result.license.createdAt,
        status: result.license.status,
        message: result.message,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[API /api/license/verify ERROR]:', err);
    return NextResponse.json(
      { valid: false, message: err?.message || 'Internal server error verifying license.' },
      { status: 500 }
    );
  }
}
