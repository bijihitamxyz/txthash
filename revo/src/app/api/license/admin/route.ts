import { NextRequest, NextResponse } from 'next/server';
import {
  readLicenses,
  computeLicenseStats,
  createLicenseRecord,
  extendLicenseRecord,
  toggleRevokeLicenseRecord,
  deleteLicenseRecord,
  verifyAdminSecret,
  LicenseDuration,
} from '@/lib/licenseDb';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Invalid Admin Master Key.' },
        { status: 401 }
      );
    }

    const licenses = await readLicenses();
    const stats = computeLicenseStats(licenses);

    return NextResponse.json(
      {
        success: true,
        licenses,
        stats,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error('[API GET /api/license/admin ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Failed to fetch licenses.' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!verifyAdminSecret(req)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Invalid Admin Master Key.' },
        { status: 401 }
      );
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Malformed JSON payload.' },
        { status: 400 }
      );
    }

    const { action } = body;

    if (!action) {
      return NextResponse.json(
        { success: false, error: 'Field "action" is required.' },
        { status: 400 }
      );
    }

    switch (action) {
      case 'CREATE': {
        const { username, telegram, email, duration } = body;

        const cleanUsername = typeof username === 'string' && username.trim() ? username.trim() : '';
        const effectiveTelegram = typeof telegram === 'string' && telegram.trim()
          ? (telegram.trim().startsWith('@') ? telegram.trim() : `@${telegram.trim()}`)
          : (cleanUsername
              ? (cleanUsername.startsWith('@') ? cleanUsername : `@${cleanUsername}`)
              : '');

        if (!effectiveTelegram) {
          return NextResponse.json(
            { success: false, error: 'Username or Telegram handle (@username) is required.' },
            { status: 400 }
          );
        }

        const validDuration: LicenseDuration =
          duration === '30d' ? '30d' : '7d';

        const newLicense = await createLicenseRecord({
          username: cleanUsername || effectiveTelegram,
          telegram: effectiveTelegram,
          email: typeof email === 'string' && email.trim() ? email.trim() : undefined,
          duration: validDuration,
        });

        const allLicenses = await readLicenses();
        const stats = computeLicenseStats(allLicenses);

        return NextResponse.json(
          {
            success: true,
            message: 'License key created successfully.',
            license: newLicense,
            stats,
          },
          { status: 201 }
        );
      }

      case 'EXTEND': {
        const { licenseKey, id, days, duration } = body;
        const keyOrId = licenseKey || id;

        if (!keyOrId) {
          return NextResponse.json(
            { success: false, error: 'licenseKey or id is required to extend.' },
            { status: 400 }
          );
        }

        // Determine days to add: explicit days, or calculated from duration ('7d' -> 7, '30d' -> 30)
        let daysToAdd = 7;
        if (typeof days === 'number' && days > 0) {
          daysToAdd = days;
        } else if (duration === '30d') {
          daysToAdd = 30;
        }

        const updated = await extendLicenseRecord(keyOrId, daysToAdd);

        if (!updated) {
          return NextResponse.json(
            { success: false, error: 'License key not found.' },
            { status: 404 }
          );
        }

        const allLicenses = await readLicenses();
        const stats = computeLicenseStats(allLicenses);

        return NextResponse.json(
          {
            success: true,
            message: `License extended by +${daysToAdd} days.`,
            license: updated,
            stats,
          },
          { status: 200 }
        );
      }

      case 'REVOKE': {
        const { licenseKey, id } = body;
        const keyOrId = licenseKey || id;

        if (!keyOrId) {
          return NextResponse.json(
            { success: false, error: 'licenseKey or id is required.' },
            { status: 400 }
          );
        }

        const updated = await toggleRevokeLicenseRecord(keyOrId);

        if (!updated) {
          return NextResponse.json(
            { success: false, error: 'License key not found.' },
            { status: 404 }
          );
        }

        const allLicenses = await readLicenses();
        const stats = computeLicenseStats(allLicenses);

        return NextResponse.json(
          {
            success: true,
            message: `License status changed to ${updated.status}.`,
            license: updated,
            stats,
          },
          { status: 200 }
        );
      }

      case 'DELETE': {
        const { licenseKey, id } = body;
        const keyOrId = licenseKey || id;

        if (!keyOrId) {
          return NextResponse.json(
            { success: false, error: 'licenseKey or id is required to delete.' },
            { status: 400 }
          );
        }

        const deleted = await deleteLicenseRecord(keyOrId);

        if (!deleted) {
          return NextResponse.json(
            { success: false, error: 'License key not found.' },
            { status: 404 }
          );
        }

        const allLicenses = await readLicenses();
        const stats = computeLicenseStats(allLicenses);

        return NextResponse.json(
          {
            success: true,
            message: 'License record deleted successfully.',
            deleted: true,
            stats,
          },
          { status: 200 }
        );
      }

      default:
        return NextResponse.json(
          { success: false, error: `Unsupported action '${action}'.` },
          { status: 400 }
        );
    }
  } catch (err: any) {
    console.error('[API POST /api/license/admin ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Server error processing admin request.' },
      { status: 500 }
    );
  }
}
