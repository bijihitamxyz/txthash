import { NextRequest, NextResponse } from 'next/server';
import { verifyLicenseKey } from '@/lib/licenseDb';

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
