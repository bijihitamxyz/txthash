/**
 * AES-256-GCM Credentials Vault (src/core/exnessVault.ts)
 * Secure, production-grade server-side encryption for Exness credentials.
 * Persists encrypted payload safely in .data/exness-vault.enc.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type AccountMode = 'DEMO' | 'REAL';

export interface ExnessVaultCredentials {
  accountId: string;
  mode: AccountMode;
  server: string;
  apiKey: string;
  privateKey: string;
  updatedAt?: number;
}

// Master secret for deriving AES-256 key
const MASTER_SECRET =
  process.env.EXNESS_VAULT_SECRET ||
  process.env.APP_ENCRYPTION_KEY ||
  'exness-quant-ai-vault-master-key-2025-secure-aes256';

const DATA_DIR = path.resolve(process.cwd(), '.data');
const VAULT_FILE = path.resolve(DATA_DIR, 'exness-vault.enc');

interface EncryptedPayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: number;
}

/**
 * Ensures .data directory exists
 */
function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Derives a 32-byte key from salt and master secret using PBKDF2
 */
function deriveKey(salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(MASTER_SECRET, salt, 100000, 32, 'sha256');
}

/**
 * Encrypts credentials object to AES-256-GCM payload
 */
export function encryptCredentials(creds: ExnessVaultCredentials): EncryptedPayload {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
  const key = deriveKey(salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payloadStr = JSON.stringify(creds);

  const ciphertext = Buffer.concat([
    cipher.update(payloadStr, 'utf8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    updatedAt: Date.now(),
  };
}

/**
 * Decrypts AES-256-GCM payload to credentials object
 */
export function decryptCredentials(payload: EncryptedPayload): ExnessVaultCredentials {
  const salt = Buffer.from(payload.salt, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');

  const key = deriveKey(salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8')) as ExnessVaultCredentials;
}

declare global {
  // eslint-disable-next-line no-var
  var __exnessVaultCache: ExnessVaultCredentials | null | undefined;
  // eslint-disable-next-line no-var
  var __exnessVaultLogged: boolean | undefined;
}

/**
 * Saves credentials to .data/exness-vault.enc
 */
export async function saveVaultCredentials(creds: ExnessVaultCredentials): Promise<void> {
  ensureDataDir();
  const normalized: ExnessVaultCredentials = {
    accountId: String(creds.accountId || '').trim(),
    mode: creds.mode === 'REAL' ? 'REAL' : 'DEMO',
    server: String(creds.server || 'https://api.exness-api.com').trim(),
    apiKey: String(creds.apiKey || '').trim(),
    privateKey: String(creds.privateKey || '').trim(),
    updatedAt: Date.now(),
  };

  const encrypted = encryptCredentials(normalized);
  await fs.promises.writeFile(VAULT_FILE, JSON.stringify(encrypted, null, 2), 'utf8');

  // Invalidate and update in-memory cache
  globalThis.__exnessVaultCache = normalized;
  globalThis.__exnessVaultLogged = true;
  console.log(`[SECURITY] Decrypted credentials loaded from AES-256 Vault (${normalized.mode} Mode)`);
}

/**
 * Loads and decrypts credentials from .data/exness-vault.enc
 * Cached in globalThis.__exnessVaultCache to prevent repeated disk I/O and terminal log spam
 */
export async function loadVaultCredentials(): Promise<ExnessVaultCredentials | null> {
  try {
    // 1. Fast in-memory cache hit
    if (globalThis.__exnessVaultCache !== undefined) {
      return globalThis.__exnessVaultCache;
    }

    if (!fs.existsSync(VAULT_FILE)) {
      globalThis.__exnessVaultCache = null;
      return null;
    }

    const content = await fs.promises.readFile(VAULT_FILE, 'utf8');
    const payload: EncryptedPayload = JSON.parse(content);
    const creds = decryptCredentials(payload);

    // Cache decrypted credentials in memory
    globalThis.__exnessVaultCache = creds;

    // Log ONLY ONCE on initial load to eliminate terminal spam every 2 seconds
    if (!globalThis.__exnessVaultLogged) {
      globalThis.__exnessVaultLogged = true;
      const telemetryMsg = `[SECURITY] Decrypted credentials loaded from AES-256 Vault (${creds.mode} Mode)`;
      console.log(telemetryMsg);

      // Also notify runtime state if available
      try {
        const g = globalThis as any;
        if (typeof g.__emitVaultTelemetry === 'function') {
          g.__emitVaultTelemetry('SECURITY', telemetryMsg);
        }
      } catch {}
    }

    return creds;
  } catch (err: any) {
    console.error('[SECURITY] Error reading AES-256 vault:', err?.message || err);
    globalThis.__exnessVaultCache = null;
    return null;
  }
}

/**
 * Synchronous check if vault file exists
 */
export function hasVaultCredentials(): boolean {
  if (globalThis.__exnessVaultCache) return true;
  return fs.existsSync(VAULT_FILE);
}

/**
 * Clears the vault file and invalidates in-memory cache
 */
export async function clearVaultCredentials(): Promise<void> {
  globalThis.__exnessVaultCache = null;
  globalThis.__exnessVaultLogged = false;
  if (fs.existsSync(VAULT_FILE)) {
    await fs.promises.unlink(VAULT_FILE);
  }
}

// Aliases for clean compatibility
export const saveVault = saveVaultCredentials;
export const clearVault = clearVaultCredentials;
export const loadVault = loadVaultCredentials;

/**
 * Returns safe masked credentials for UI inspection
 */
export function getMaskedVaultCredentials(creds: ExnessVaultCredentials | null) {
  if (!creds) return null;
  return {
    accountId: creds.accountId,
    mode: creds.mode,
    server: creds.server,
    apiKey: creds.apiKey ? '••••••••' + creds.apiKey.slice(-4) : '',
    hasPrivateKey: !!creds.privateKey,
    updatedAt: creds.updatedAt,
  };
}
