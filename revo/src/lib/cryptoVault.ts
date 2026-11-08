/**
 * AES-256-GCM Encrypted Credential Vault (src/lib/cryptoVault.ts)
 * Secure client & server credential encryption using Web Crypto API.
 * Stores Exness Demo Account, Exness Real Account, and BYOK AI Provider keys.
 * Zero native C++ compilation dependencies. Compatible with Linux/Termux, Vercel, and Browser runtime.
 */

const DEFAULT_SALT = 'EXNESS_AI_QUANT_TRADER_VAULT_2026_MASTER';

export type AccountMode = 'DEMO' | 'REAL';

export interface StoredCredentials {
  // Active Account Mode
  accountMode: AccountMode;

  // Exness Demo Account Credentials
  demoAccountId: string; // Account Number (default '30000143146')
  demoServer: string; // e.g. "Exness-Trial" | "Exness-MT5Trial17"
  demoApiKey: string; // Exness API Key (Full Access Token)
  demoApiSecret?: string; // Optional API Secret / Passphrase
  demoInitialBalance?: number; // Synced Initial Balance ($), default 100.00

  // Exness Real Account Credentials
  realAccountId: string; // Account Number (default '30000143146')
  realServer: string; // e.g. "Exness-Real" | "Exness-MT5Real"
  realApiKey: string; // Exness API Key (Full Access Token)
  realApiSecret?: string; // Optional API Secret / Passphrase
  realInitialBalance?: number; // Synced Initial Balance ($), default 100.00

  // BYOK AI Engine Configuration (OpenAI, Gemini, DeepSeek, Groq, Custom)
  aiProvider: 'openai' | 'gemini' | 'deepseek' | 'groq' | 'custom';
  aiBaseUrl: string;
  aiApiKey: string;
  aiModel: string;

  // Kronos FastAPI VPS Configuration
  kronosVpsUrl?: string;
  kronosApiKey?: string;

  // Backwards compatibility aliases
  exnessAccountId?: string;
  exnessServer?: string;
  exnessToken?: string;

  updatedAt: number;
}

export const DEFAULT_CREDENTIALS: StoredCredentials = {
  accountMode: 'DEMO',

  demoAccountId: '30000143146',
  demoServer: 'Exness-Trial',
  demoApiKey: '',
  demoApiSecret: '',
  demoInitialBalance: undefined,

  realAccountId: '464129221',
  realServer: 'Exness-Real',
  realApiKey: '',
  realApiSecret: '',
  realInitialBalance: undefined,

  aiProvider: 'openai',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',

  kronosVpsUrl: 'http://127.0.0.1:8000',
  kronosApiKey: 'nmssx-kronos-secret-2026',

  updatedAt: Date.now(),
};

/**
 * Returns active Exness account credentials based on current accountMode
 */
export function getActiveExnessCredentials(creds: StoredCredentials): {
  accountId: string;
  server: string;
  apiKey: string;
  secret: string;
  password: string;
  initialBalance: number;
  mode: AccountMode;
} {
  const isReal = creds.accountMode === 'REAL';
  const accountId = isReal
    ? (creds.realAccountId || creds.exnessAccountId || '30000143146')
    : (creds.demoAccountId || creds.exnessAccountId || '30000143146');
  const server = isReal
    ? (creds.realServer || 'Exness-Real')
    : (creds.demoServer || 'Exness-Trial');
  const apiKey = isReal
    ? (creds.realApiKey || creds.exnessToken || '')
    : (creds.demoApiKey || creds.exnessToken || '');
  const secret = isReal
    ? (creds.realApiSecret || '')
    : (creds.demoApiSecret || '');
  const initialBalance = isReal
    ? (typeof creds.realInitialBalance === 'number' && creds.realInitialBalance > 0 ? creds.realInitialBalance : 0)
    : (typeof creds.demoInitialBalance === 'number' && creds.demoInitialBalance > 0 ? creds.demoInitialBalance : 0);

  return {
    accountId,
    server,
    apiKey,
    secret,
    password: apiKey,
    initialBalance,
    mode: isReal ? 'REAL' : 'DEMO',
  };
}

/**
 * Checks whether valid Exness credentials have been configured for the current accountMode
 */
export function isVaultConfigured(creds?: StoredCredentials): boolean {
  if (!creds) return false;
  const isReal = creds.accountMode === 'REAL';
  const accountId = isReal ? creds.realAccountId : creds.demoAccountId;
  const token = isReal ? creds.realApiKey : creds.demoApiKey;
  const legacyId = creds.exnessAccountId;
  const legacyToken = creds.exnessToken;

  const hasId = Boolean((accountId && accountId.trim().length > 0) || (legacyId && legacyId.trim().length > 0));
  // Strictly enforce that API key is non-empty
  const hasToken = Boolean((token && token.trim().length > 0) || (legacyToken && legacyToken.trim().length > 0));
  return hasId && hasToken;
}

/**
 * Derives a 256-bit CryptoKey using PBKDF2 from a passphrase string
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as any,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a plaintext string into a base64 encoded payload: salt(16) + iv(12) + ciphertext_with_tag
 */
export async function encryptCredential(plaintext: string, masterKey?: string): Promise<string> {
  if (!plaintext) return '';
  const keyString = masterKey || (typeof process !== 'undefined' ? process.env?.APP_ENCRYPTION_KEY : undefined) || DEFAULT_SALT;

  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM

  const key = await deriveKey(keyString, salt);
  const encodedPlaintext = enc.encode(plaintext);

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    key,
    encodedPlaintext
  );

  // Combine: salt (16 bytes) + iv (12 bytes) + ciphertext (variable)
  const combined = new Uint8Array(salt.length + iv.length + encryptedBuffer.byteLength);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(encryptedBuffer), salt.length + iv.length);

  // Convert Uint8Array to base64
  let binary = '';
  const bytes = combined;
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
}

/**
 * Decrypts a base64 encoded payload back into the plaintext string
 */
export async function decryptCredential(encryptedBase64: string, masterKey?: string): Promise<string> {
  if (!encryptedBase64) return '';
  const keyString = masterKey || (typeof process !== 'undefined' ? process.env?.APP_ENCRYPTION_KEY : undefined) || DEFAULT_SALT;

  const binary = typeof atob === 'function' ? atob(encryptedBase64) : Buffer.from(encryptedBase64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (bytes.length < 28) {
    throw new Error('Invalid encrypted payload length for AES-GCM');
  }

  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const ciphertext = bytes.slice(28);

  const key = await deriveKey(keyString, salt);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
      tagLength: 128,
    },
    key,
    ciphertext
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuffer);
}

/**
 * Browser LocalStorage Vault for BYOK Credentials (stored encrypted)
 */
const VAULT_STORAGE_KEY = 'EXNESS_AI_TRADER_ENCRYPTED_VAULT';

export async function saveVaultToLocalStorage(creds: StoredCredentials): Promise<void> {
  if (typeof window === 'undefined') return;
  const jsonStr = JSON.stringify(creds);
  const encrypted = await encryptCredential(jsonStr);
  localStorage.setItem(VAULT_STORAGE_KEY, encrypted);
}

export async function loadVaultFromLocalStorage(): Promise<StoredCredentials | null> {
  if (typeof window === 'undefined') return null;
  const encrypted = localStorage.getItem(VAULT_STORAGE_KEY);
  if (!encrypted) return null;
  try {
    const decryptedJson = await decryptCredential(encrypted);
    const parsed = JSON.parse(decryptedJson) as StoredCredentials;
    return {
      ...DEFAULT_CREDENTIALS,
      ...parsed,
    };
  } catch (err) {
    console.error('Failed to decrypt stored credentials vault:', err);
    return null;
  }
}

/**
 * Server-Side Persistent Credential Vault (backed by safe dataStore)
 */
export async function saveServerVault(creds: StoredCredentials): Promise<void> {
  try {
    const jsonStr = JSON.stringify(creds);
    const encrypted = await encryptCredential(jsonStr);
    const { writeDataFileAsync } = await import('./dataStore');
    await writeDataFileAsync('vault.enc', encrypted);
  } catch (err) {
    console.warn('[cryptoVault] saveServerVault error (ignored):', err);
  }
}

export async function loadServerVault(): Promise<StoredCredentials | null> {
  try {
    const { readDataFileAsync } = await import('./dataStore');
    const encrypted = await readDataFileAsync('vault.enc', '');
    if (!encrypted || !encrypted.trim()) return null;
    const decrypted = await decryptCredential(encrypted);
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}
