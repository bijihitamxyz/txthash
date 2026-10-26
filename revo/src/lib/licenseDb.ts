import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type LicenseDuration = '7d' | '30d';
export type LicenseStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface LicenseRecord {
  id: string;
  licenseKey: string;
  username: string;
  telegram: string;
  email?: string;
  duration: LicenseDuration;
  status: LicenseStatus;
  createdAt: string;
  expiresAt: string;
}

export interface LicenseDbData {
  licenses: LicenseRecord[];
}

export interface LicenseStats {
  totalKeys: number;
  activeKeys: number;
  expiredKeys: number;
  revokedKeys: number;
}

// Unambiguous characters for license keys (omits 0, O, 1, I, L)
const KEY_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Returns the absolute path to licenses_db.json
 */
export function getLicensesDbPath(): string {
  if (process.env.DB_FILE) {
    return process.env.DB_FILE;
  }
  return path.join(process.cwd(), 'data', 'licenses_db.json');
}

// Queue for sequential write safety to prevent file corruption
let fileLockQueue = Promise.resolve();

function withFileLock<T>(taskFn: () => Promise<T>): Promise<T> {
  const next = fileLockQueue.then(() => taskFn());
  fileLockQueue = next.then(() => {}).catch(() => {});
  return next;
}

/**
 * Ensures data directory exists and returns default db structure
 */
function ensureDbFileExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    const initialData: LicenseDbData = { licenses: [] };
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf-8');
  }
}

/**
 * Safely reads the license records, automatically updating status to EXPIRED
 * if expiresAt has passed.
 */
export async function readLicenses(): Promise<LicenseRecord[]> {
  const filePath = getLicensesDbPath();
  ensureDbFileExists(filePath);

  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    if (!content.trim()) {
      return [];
    }
    const parsed: LicenseDbData = JSON.parse(content);
    const licenses = Array.isArray(parsed.licenses) ? parsed.licenses : [];

    // Check expiration timestamps and auto-update
    const now = Date.now();
    let hasUpdates = false;

    for (const record of licenses) {
      if (record.status === 'ACTIVE') {
        const expTime = new Date(record.expiresAt).getTime();
        if (now >= expTime) {
          record.status = 'EXPIRED';
          hasUpdates = true;
        }
      }
    }

    if (hasUpdates) {
      // Persist expired updates in background
      writeLicenses(licenses).catch((err) => {
        console.error('[LICENSE DB] Error auto-persisting expired states:', err);
      });
    }

    return licenses;
  } catch (err) {
    console.error('[LICENSE DB] Error reading licenses:', err);
    return [];
  }
}

/**
 * Safely writes the license records atomically using a temp file.
 */
export async function writeLicenses(licenses: LicenseRecord[]): Promise<void> {
  return withFileLock(async () => {
    const filePath = getLicensesDbPath();
    ensureDbFileExists(filePath);

    const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const payload: LicenseDbData = { licenses };
    const jsonStr = JSON.stringify(payload, null, 2);

    await fs.promises.writeFile(tmpPath, jsonStr, 'utf-8');
    await fs.promises.rename(tmpPath, filePath);
  });
}

/**
 * Generates random segment from unambiguous charset
 */
function generateKeySegment(length: number = 4): string {
  const bytes = crypto.randomBytes(length * 2);
  let segment = '';
  let i = 0;

  while (segment.length < length && i < bytes.length) {
    const byte = bytes[i++];
    const maxValid = 256 - (256 % KEY_CHARSET.length);
    if (byte < maxValid) {
      segment += KEY_CHARSET[byte % KEY_CHARSET.length];
    }
  }

  while (segment.length < length) {
    const extraByte = crypto.randomBytes(1)[0];
    segment += KEY_CHARSET[extraByte % KEY_CHARSET.length];
  }

  return segment;
}

/**
 * Generates formatted license key: EQ-7D-XXXX-XXXX or EQ-30D-XXXX-XXXX
 */
export function generateLicenseKey(duration: LicenseDuration): string {
  const prefix = duration === '30d' ? 'EQ-30D' : 'EQ-7D';
  const seg1 = generateKeySegment(4);
  const seg2 = generateKeySegment(4);
  return `${prefix}-${seg1}-${seg2}`;
}

/**
 * Computes summary stats across all licenses
 */
export function computeLicenseStats(licenses: LicenseRecord[]): LicenseStats {
  const now = Date.now();
  let activeKeys = 0;
  let expiredKeys = 0;
  let revokedKeys = 0;

  for (const lic of licenses) {
    if (lic.status === 'REVOKED') {
      revokedKeys++;
    } else if (lic.status === 'EXPIRED' || new Date(lic.expiresAt).getTime() <= now) {
      expiredKeys++;
    } else if (lic.status === 'ACTIVE') {
      activeKeys++;
    }
  }

  return {
    totalKeys: licenses.length,
    activeKeys,
    expiredKeys,
    revokedKeys,
  };
}

/**
 * Verifies a license key
 */
export async function verifyLicenseKey(rawKey: string): Promise<{
  valid: boolean;
  license?: LicenseRecord;
  message: string;
}> {
  const cleanKey = (rawKey || '').trim().toUpperCase();
  if (!cleanKey) {
    return { valid: false, message: 'License key cannot be empty.' };
  }

  const licenses = await readLicenses();
  const record = licenses.find((l) => l.licenseKey.toUpperCase() === cleanKey);

  if (!record) {
    return { valid: false, message: 'License key not found.' };
  }

  if (record.status === 'REVOKED') {
    return { valid: false, license: record, message: 'License has been revoked by administrator.' };
  }

  const now = Date.now();
  const expTime = new Date(record.expiresAt).getTime();
  if (record.status === 'EXPIRED' || now >= expTime) {
    if (record.status !== 'EXPIRED') {
      record.status = 'EXPIRED';
      await writeLicenses(licenses);
    }
    return { valid: false, license: record, message: 'License has expired.' };
  }

  return {
    valid: true,
    license: record,
    message: 'License is active and valid.',
  };
}

/**
 * Creates and persists a new license record
 */
export async function createLicenseRecord(params: {
  username: string;
  telegram: string;
  email?: string;
  duration: LicenseDuration;
}): Promise<LicenseRecord> {
  const { username, telegram, email, duration } = params;
  const licenses = await readLicenses();

  const days = duration === '30d' ? 30 : 7;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  // Generate unique key
  let licenseKey = '';
  let attempts = 0;
  do {
    licenseKey = generateLicenseKey(duration);
    attempts++;
  } while (licenses.some((l) => l.licenseKey === licenseKey) && attempts < 50);

  const newRecord: LicenseRecord = {
    id: `lic_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    licenseKey,
    username: username.trim(),
    telegram: telegram.trim().startsWith('@') ? telegram.trim() : `@${telegram.trim()}`,
    email: email?.trim() ? email.trim() : undefined,
    duration,
    status: 'ACTIVE',
    createdAt,
    expiresAt,
  };

  licenses.unshift(newRecord);
  await writeLicenses(licenses);

  return newRecord;
}

/**
 * Extends a license by +7 or +30 days
 */
export async function extendLicenseRecord(
  keyOrId: string,
  daysToAdd: number
): Promise<LicenseRecord | null> {
  const licenses = await readLicenses();
  const clean = keyOrId.trim().toUpperCase();
  const record = licenses.find(
    (l) => l.id === keyOrId || l.licenseKey.toUpperCase() === clean
  );

  if (!record) return null;

  const now = Date.now();
  const currentExp = new Date(record.expiresAt).getTime();
  // If already expired, extend starting from current time; otherwise extend from existing expiresAt
  const baseTime = currentExp > now ? currentExp : now;
  const newExpTime = baseTime + daysToAdd * 24 * 60 * 60 * 1000;

  record.expiresAt = new Date(newExpTime).toISOString();
  record.status = 'ACTIVE';

  await writeLicenses(licenses);
  return record;
}

/**
 * Toggles license status between ACTIVE and REVOKED
 */
export async function toggleRevokeLicenseRecord(keyOrId: string): Promise<LicenseRecord | null> {
  const licenses = await readLicenses();
  const clean = keyOrId.trim().toUpperCase();
  const record = licenses.find(
    (l) => l.id === keyOrId || l.licenseKey.toUpperCase() === clean
  );

  if (!record) return null;

  if (record.status === 'REVOKED') {
    const isExpired = new Date(record.expiresAt).getTime() <= Date.now();
    record.status = isExpired ? 'EXPIRED' : 'ACTIVE';
  } else {
    record.status = 'REVOKED';
  }

  await writeLicenses(licenses);
  return record;
}

/**
 * Deletes a license record
 */
export async function deleteLicenseRecord(keyOrId: string): Promise<boolean> {
  const licenses = await readLicenses();
  const clean = keyOrId.trim().toUpperCase();
  const initialLength = licenses.length;
  const filtered = licenses.filter(
    (l) => l.id !== keyOrId && l.licenseKey.toUpperCase() !== clean
  );

  if (filtered.length === initialLength) {
    return false;
  }

  await writeLicenses(filtered);
  return true;
}

/**
 * Checks Admin Authentication header
 */
export function verifyAdminSecret(req: Request): boolean {
  const adminSecret = process.env.ADMIN_SECRET || 'admin123';
  const provided = req.headers.get('x-admin-key');
  return provided === adminSecret;
}
