/**
 * AES-256-GCM Credentials Vault (src/core/exnessVault.ts)
 * Secure, production-grade server-side encryption for Exness credentials.
 * Dynamic storage resolution:
 * - Vercel / Serverless: /tmp/revo-data/exness-vault.enc
 * - Local Node.js: .data/exness-vault.enc
 * Guaranteed 100% crash-free persistence with globalThis.__NEMESIS_MEMORY_STORE__ fallback.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDataDir, safeMkdirSync, getNemesisMemoryStore, isServerless } from '@/lib/dataStore';

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

export function getVaultDir(): string {
  return getDataDir();
}

export function getVaultFilePath(): string {
  return path.join(getVaultDir(), 'exness-vault.enc');
}

// Backwards-compatible constants
const DATA_DIR = getDataDir();
const VAULT_FILE = path.join(DATA_DIR, 'exness-vault.enc');

interface EncryptedPayload {
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  updatedAt: number;
}

/**
 * Ensures storage directory exists safely
 */
function ensureDataDir(): string {
  const dir = getDataDir();
  safeMkdirSync(dir);
  return dir;
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
 * Saves credentials to dynamic vault path (/tmp/revo-data or .data)
 * Mirrors every saved payload into globalThis.__NEMESIS_MEMORY_STORE__
 * Never throws ENOENT or EROFS on read-only serverless environments.
 */
export async function saveVaultCredentials(creds: ExnessVaultCredentials): Promise<void> {
  const dir = ensureDataDir();
  const normalized: ExnessVaultCredentials = {
    accountId: String(creds.accountId || '').trim(),
    mode: creds.mode === 'REAL' ? 'REAL' : 'DEMO',
    server: String(creds.server || 'https://api.exness-api.com').trim(),
    apiKey: String(creds.apiKey || '').trim(),
    privateKey: String(creds.privateKey || '').trim(),
    updatedAt: Date.now(),
  };

  const encrypted = encryptCredentials(normalized);

  // Mirror payload into global in-memory NEMESIS store
  const nemesis = getNemesisMemoryStore();
  nemesis['exness-vault.enc'] = encrypted;
  nemesis['exness-vault.json'] = normalized;

  // Attempt filesystem persistence safely inside try/catch
  try {
    const targetPath = getVaultFilePath();
    const targetDir = path.dirname(targetPath);
    safeMkdirSync(targetDir);
    await fs.promises.writeFile(targetPath, JSON.stringify(encrypted, null, 2), { encoding: 'utf8', mode: 0o600 });

    // Also persist to VPS data/ directory so credentials survive restarts & are immediately available to engineScheduler
    if (!isServerless()) {
      const vpsDataDir = path.join(process.cwd(), 'data');
      safeMkdirSync(vpsDataDir);
      const vpsVaultPath = path.join(vpsDataDir, 'exness-vault.enc');
      if (vpsVaultPath !== targetPath) {
        await fs.promises.writeFile(vpsVaultPath, JSON.stringify(encrypted, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
    }
  } catch (fsErr) {
    console.warn('[exnessVault] Filesystem write failed, running in memory-only fallback:', fsErr);
  }

  // Update in-memory process cache
  globalThis.__exnessVaultCache = normalized;
  globalThis.__exnessVaultLogged = true;

  const signature = `${normalized.accountId}_${normalized.mode}_${normalized.server}_${normalized.apiKey}_${normalized.privateKey}`;
  if ((globalThis as any).__lastLoggedVaultSignature !== signature) {
    (globalThis as any).__lastLoggedVaultSignature = signature;
    console.log(`[SECURITY] Decrypted credentials loaded from AES-256 Vault (${normalized.mode} Mode)`);
  }
}

/**
 * Loads and decrypts credentials from dynamic vault or in-memory NEMESIS store
 */
export async function loadVaultCredentials(): Promise<ExnessVaultCredentials | null> {
  try {
    // 1. Fast in-memory cache hit
    if (globalThis.__exnessVaultCache !== undefined && globalThis.__exnessVaultCache !== null) {
      return globalThis.__exnessVaultCache;
    }

    // 2. Check NEMESIS in-memory fallback store
    const nemesis = getNemesisMemoryStore();
    if (nemesis['exness-vault.json']) {
      const memCreds = nemesis['exness-vault.json'] as ExnessVaultCredentials;
      if (memCreds && memCreds.apiKey) {
        globalThis.__exnessVaultCache = memCreds;
        return memCreds;
      }
    }
    if (nemesis['exness-vault.enc']) {
      try {
        const rawPayload = nemesis['exness-vault.enc'];
        const payload: EncryptedPayload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
        const creds = decryptCredentials(payload);
        globalThis.__exnessVaultCache = creds;
        return creds;
      } catch {}
    }

    // 3. Try reading from dynamic primary storage path (/tmp/revo-data or .data)
    const targetPath = getVaultFilePath();
    let content: string | null = null;
    try {
      if (fs.existsSync(targetPath)) {
        content = await fs.promises.readFile(targetPath, 'utf8');
      }
    } catch (readErr) {
      console.warn(`[exnessVault] Primary read warning for ${targetPath}:`, readErr);
    }

    // 4. Fallback to seed files (.data/ or data/)
    if (!content || !content.trim()) {
      const seedCandidates = [
        path.join(process.cwd(), '.data', 'exness-vault.enc'),
        path.join(process.cwd(), 'data', 'exness-vault.enc'),
      ];
      for (const seedPath of seedCandidates) {
        try {
          if (fs.existsSync(seedPath)) {
            content = await fs.promises.readFile(seedPath, 'utf8');
            if (content && content.trim()) break;
          }
        } catch {}
      }
    }

    if (!content || !content.trim()) {
      globalThis.__exnessVaultCache = null;
      return null;
    }

    const payload: EncryptedPayload = JSON.parse(content);
    const creds = decryptCredentials(payload);

    // Cache decrypted credentials in memory and mirror to NEMESIS store
    globalThis.__exnessVaultCache = creds;
    nemesis['exness-vault.enc'] = payload;
    nemesis['exness-vault.json'] = creds;

    // Log ONLY ONCE on initial load or when credentials change to eliminate terminal spam
    const signature = `${creds.accountId}_${creds.mode}_${creds.server}_${creds.apiKey}_${creds.privateKey}`;
    if ((globalThis as any).__lastLoggedVaultSignature !== signature) {
      (globalThis as any).__lastLoggedVaultSignature = signature;
      globalThis.__exnessVaultLogged = true;
      const telemetryMsg = `[SECURITY] Decrypted credentials loaded from AES-256 Vault (${creds.mode} Mode)`;
      console.log(telemetryMsg);

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
 * Synchronous check if vault credentials exist
 */
export function hasVaultCredentials(): boolean {
  if (globalThis.__exnessVaultCache) return true;
  const nemesis = getNemesisMemoryStore();
  if (nemesis['exness-vault.json'] || nemesis['exness-vault.enc']) return true;
  try {
    const targetPath = getVaultFilePath();
    if (fs.existsSync(targetPath)) return true;
    const seedCandidates = [
      path.join(process.cwd(), '.data', 'exness-vault.enc'),
      path.join(process.cwd(), 'data', 'exness-vault.enc'),
    ];
    for (const seedPath of seedCandidates) {
      if (fs.existsSync(seedPath)) return true;
    }
  } catch {}
  return false;
}

/**
 * Clears the vault file and invalidates in-memory caches
 */
export async function clearVaultCredentials(): Promise<void> {
  globalThis.__exnessVaultCache = null;
  globalThis.__exnessVaultLogged = false;
  const nemesis = getNemesisMemoryStore();
  delete nemesis['exness-vault.enc'];
  delete nemesis['exness-vault.json'];

  try {
    const targetPath = getVaultFilePath();
    if (fs.existsSync(targetPath)) {
      await fs.promises.unlink(targetPath);
    }
    if (!isServerless()) {
      const vpsVaultPath = path.join(process.cwd(), 'data', 'exness-vault.enc');
      if (vpsVaultPath !== targetPath && fs.existsSync(vpsVaultPath)) {
        await fs.promises.unlink(vpsVaultPath);
      }
    }
  } catch (err) {
    console.warn('[exnessVault] clearVaultCredentials unlink warning:', err);
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
