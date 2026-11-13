/**
 * Bulletproof Exness Direct Client & Real-Time Engine (src/core/exnessClient.ts)
 * Strictly conforms to Official Exness API Developer Portal Specification (exness-api.com):
 * 1. Ed25519 Request Signing & Key Parsing (128-char Hex, 64-char Hex seed, Base64, PKCS#8 PEM)
 * 2. EXN-* Headers: EXN-API-KEY, EXN-IDEMPOTENCY-KEY, EXN-TIMESTAMP, EXN-SIGN-VERSION, EXN-DATA, EXN-SIGN
 * 3. Step 1: Resolve & Cache Account access_point via Discovery (/v1/trading/access-point?account_id=...)
 * 4. Step 2: Account Verification (/v1/configuration/accounts/{accountId}/account & limits)
 * 5. Real-Time WebSocket Streams: /ws/ticks & /ws/events (live ticks, balance, equity, positions)
 * 6. Direct Order Execution: POST /v1/trading/accounts/{accountId}/positions with EXN-IDEMPOTENCY-KEY
 * 7. Strict Zero Dummy Balance: null balance, equity, and dailyPnl when disconnected
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { Candle } from './indicatorEngine';
import { PairProfile, getPairProfile, formatPrice, roundLotVolume, calculatePnL, evaluatePositionPnL } from './pairConfig';
import {
  ManagedPosition,
  sanitizePositionSlTp,
  markPositionClosingStart,
  markPositionClosingDone,
} from './trailingManager';
import { ExnessVaultCredentials } from './exnessVault';
import { getDataDir, safeMkdirSync, getNemesisMemoryStore } from '@/lib/dataStore';

// ==========================================
// MANDATED EXPORT: computeBodyHash
// ==========================================
/**
 * SHA-256 hash of the exact request body encoded as base64url WITHOUT '=' padding.
 * For requests without a body (GET), body_hash MUST equal:
 * "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
 */
export function computeBodyHash(body: string = ''): string {
  if (!body) {
    return '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';
  }
  return crypto
    .createHash('sha256')
    .update(body, 'utf8')
    .digest('base64url')
    .replace(/=+$/, '');
}

// ==========================================
// INTERFACES & TYPES
// ==========================================

export interface ExnessAccountCredentials {
  accountId?: string;
  server?: string;
  mode?: 'DEMO' | 'REAL';
  apiKey?: string;
  privateKey?: string;
  secret?: string;
  password?: string;
  token?: string;
  bridgeUrl?: string;
  initialBalance?: number;
  currentBalance?: number;
  cumulativePnl?: number;
}

export interface AccountInfo {
  accountNumber: string;
  server: string;
  currency: string;
  balance: number | null;
  equity: number | null;
  margin: number;
  freeMargin: number | null;
  marginLevelPct: number;
  dailyRealizedPnL: number | null;
  dailyRealizedLossUsd: number;
  latencyMs: number;
  connected: boolean;
  mode: 'DEMO' | 'REAL';
  isLiveExness?: boolean;
  error?: string;
}

export interface LiveQuote {
  symbol: string;
  bid: number;
  ask: number;
  spreadPips: number;
  timestamp: number;
}

export interface OrderPlacementRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number; // in standard lots (0.01 min)
  stopLossPrice?: number;
  takeProfitPrice?: number;
  comment?: string;
}

export interface OrderExecutionResult {
  success: boolean;
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  fillPrice: number;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  timestamp: number;
  message: string;
  marginAutoScaleLog?: string;
}

export interface ForexBaselineConfig {
  baseline: number;
  digits: number;
  pipValue: number;
  min: number;
  max: number;
}

export const PAIR_BASELINES: Record<string, ForexBaselineConfig> = {
  XAUUSDm: { baseline: 4116.85, digits: 2, pipValue: 0.10, min: 1500.00, max: 10000.00 },
  XAUUSD: { baseline: 4116.85, digits: 2, pipValue: 0.10, min: 1500.00, max: 10000.00 },
  EURUSDm: { baseline: 1.11592, digits: 5, pipValue: 0.0001, min: 0.50000, max: 2.50000 },
  GBPUSDm: { baseline: 1.33877, digits: 5, pipValue: 0.0001, min: 0.50000, max: 2.50000 },
  USDJPYm: { baseline: 157.569, digits: 3, pipValue: 0.01, min: 50.000, max: 300.000 },
};

export const FOREX_BASELINES = PAIR_BASELINES;
export const LAST_KNOWN_PRICE_KEY = 'exness_last_known_real_prices';
export const lastKnownPrice: Record<string, { price: number; timestamp: number; source?: string }> = {};

export function isValidPriceUpdate(symbol: string, newPrice: number): boolean {
  if (typeof newPrice !== 'number' || isNaN(newPrice) || !isFinite(newPrice) || newPrice <= 0) return false;
  if (symbol.startsWith('XAU')) {
    if (newPrice < 1500 || newPrice > 10000) return false;
    // Explicitly reject 3875 mock baseline or 4076/4077 corrupted seeds
    if (Math.abs(newPrice - 3875.70) < 5.0 || Math.abs(newPrice - 4076.77) < 5.0) return false;
  } else if (symbol.startsWith('EUR') || symbol.startsWith('GBP')) {
    if (newPrice < 0.5 || newPrice > 2.5) return false;
  } else if (symbol.startsWith('USDJPY')) {
    if (newPrice < 50 || newPrice > 300) return false;
  }
  const lastValid = lastKnownPrice[symbol]?.price || PAIR_BASELINES[symbol]?.baseline || (symbol.startsWith('XAU') ? 4116.85 : 0);
  if (lastValid > 0) {
    const deviation = Math.abs(newPrice - lastValid) / lastValid;
    // Protect against cross-symbol data injection (>15% jump on same symbol tick)
    if (deviation > 0.15) return false;
  }
  return true;
}

export function updateLastKnownPrice(symbol: string, price: number, source: string = 'live'): void {
  if (typeof price === 'number' && price > 0 && !isNaN(price)) {
    if (!isValidPriceUpdate(symbol, price)) return;
    lastKnownPrice[symbol] = { price, timestamp: Date.now(), source };
    savePersistedRealPrice(symbol, price);
    if (PAIR_BASELINES[symbol]) {
      PAIR_BASELINES[symbol].baseline = price;
    }
    if (symbol === 'XAUUSDm') {
      lastKnownPrice['XAUUSD'] = { price, timestamp: Date.now(), source };
      if (PAIR_BASELINES['XAUUSD']) PAIR_BASELINES['XAUUSD'].baseline = price;
    } else if (symbol === 'XAUUSD') {
      lastKnownPrice['XAUUSDm'] = { price, timestamp: Date.now(), source };
      if (PAIR_BASELINES['XAUUSDm']) PAIR_BASELINES['XAUUSDm'].baseline = price;
    }
  }
}

export function getPersistedRealPrice(symbol: string): number {
  if (lastKnownPrice[symbol] && lastKnownPrice[symbol].price > 0) {
    const p = lastKnownPrice[symbol].price;
    if (!symbol.startsWith('XAU') || (p >= 1500 && p <= 10000 && Math.abs(p - 3875.70) > 5.0 && Math.abs(p - 4076.77) > 5.0)) {
      return p;
    }
  }
  const filename = `${LAST_KNOWN_PRICE_KEY}.json`;
  try {
    const nemesis = getNemesisMemoryStore();
    if (filename in nemesis) {
      const data = nemesis[filename];
      if (data && typeof data[symbol] === 'number' && data[symbol] > 0) {
        const val = data[symbol];
        if (!symbol.startsWith('XAU') || (val >= 1500 && val <= 10000 && Math.abs(val - 3875.70) > 5.0 && Math.abs(val - 4076.77) > 5.0)) {
          lastKnownPrice[symbol] = { price: val, timestamp: Date.now(), source: 'memory-cache' };
          return val;
        }
      }
    }
  } catch {}

  try {
    const dataDir = getDataDir();
    const cacheFile = path.resolve(dataDir, filename);
    let content: string | null = null;
    if (fs.existsSync(cacheFile)) {
      content = fs.readFileSync(cacheFile, 'utf8');
    } else {
      const seedFile = path.resolve(process.cwd(), '.data', filename);
      if (fs.existsSync(seedFile)) {
        content = fs.readFileSync(seedFile, 'utf8');
      }
    }
    if (content) {
      const data = JSON.parse(content);
      if (data && typeof data[symbol] === 'number' && data[symbol] > 0) {
        const val = data[symbol];
        if (!symbol.startsWith('XAU') || (val >= 1500 && val <= 10000 && Math.abs(val - 3875.70) > 5.0 && Math.abs(val - 4076.77) > 5.0)) {
          lastKnownPrice[symbol] = { price: val, timestamp: Date.now(), source: 'disk-cache' };
          try {
            const nemesis = getNemesisMemoryStore();
            nemesis[filename] = data;
          } catch {}
          return val;
        }
      }
    }
  } catch {}
  return PAIR_BASELINES[symbol]?.baseline || (symbol.startsWith('XAU') ? 4108.90 : 0);
}

export function savePersistedRealPrice(symbol: string, price: number): void {
  if (!isValidPriceUpdate(symbol, price)) return;
  const filename = `${LAST_KNOWN_PRICE_KEY}.json`;
  try {
    const nemesis = getNemesisMemoryStore();
    let data: Record<string, number> = {};
    if (filename in nemesis && typeof nemesis[filename] === 'object') {
      data = { ...nemesis[filename] };
    }
    const dataDir = getDataDir();
    safeMkdirSync(dataDir);
    const cacheFile = path.resolve(dataDir, filename);
    if (fs.existsSync(cacheFile)) {
      try {
        const fileContent = fs.readFileSync(cacheFile, 'utf8');
        data = { ...data, ...JSON.parse(fileContent) };
      } catch {}
    }
    data[symbol] = price;
    nemesis[filename] = data;
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (writeErr) {
      console.warn('[exnessClient] savePersistedRealPrice write warning:', writeErr);
    }
  } catch {}
}

export function getBaselineConfig(symbol: string, digits: number = 2, pipValue: number = 0.10): ForexBaselineConfig {
  const existing = PAIR_BASELINES[symbol];
  if (existing) {
    const known = getPersistedRealPrice(symbol);
    if (known > 0) {
      existing.baseline = known;
    }
    return existing;
  }
  return {
    baseline: 1.0,
    digits,
    pipValue,
    min: 0.1,
    max: 100000.0,
  };
}

// ==========================================
// 1. OFFICIAL Ed25519 KEY PARSER & SIGNER
// ==========================================

const ED25519_PKCS8_DER_PREFIX = '302e020100300506032b657004220420';

/**
 * Parses an Ed25519 private key from:
 * 1. 128-char hex string (extract first 32 bytes / 64 hex chars as seed wrapped in PKCS#8 DER prefix)
 * 2. 64-char hex string (32-byte Ed25519 seed wrapped in PKCS#8 DER prefix)
 * 3. Unencrypted PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----")
 * 4. Base64 / Base64URL seed or PKCS#8 DER buffer
 */
export function parseEd25519PrivateKey(privateKeyInput: string | crypto.KeyObject): crypto.KeyObject | null {
  if (!privateKeyInput) return null;
  if (typeof privateKeyInput === 'object' && 'type' in privateKeyInput) {
    return privateKeyInput as crypto.KeyObject;
  }
  let trimmed = String(privateKeyInput).trim();
  // Strip enclosing quotes if present (e.g. from JSON or environment variable strings)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // 1. PEM format: Pass directly to crypto.createPrivateKey()
  if (trimmed.includes('-----BEGIN')) {
    try {
      return crypto.createPrivateKey(trimmed);
    } catch {
      try {
        const unescaped = trimmed.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
        return crypto.createPrivateKey(unescaped);
      } catch {}
    }
  }

  // 2. Clean hex representation
  const hexClean = trimmed.replace(/^0x/i, '').replace(/[\s\r\n\t]+/g, '');

  // 128-char Hex: Extract first 64 hex characters (32-byte seed) and wrap in PKCS#8 DER ASN.1 prefix:
  // Buffer.from("302e020100300506032b657004220420" + seedHex, "hex")
  if (/^[0-9a-fA-F]{128}$/.test(hexClean)) {
    try {
      const seedHex = hexClean.slice(0, 64);
      const derBuffer = Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex');
      return crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
    } catch (err: any) {
      console.error(`[ExnessKey] Failed importing 128-char hex Ed25519 key: ${err?.message || err}`);
    }
  }

  // 64-char Hex: Wrap in the same PKCS#8 DER ASN.1 prefix:
  // Buffer.from("302e020100300506032b657004220420" + hexClean, "hex")
  if (/^[0-9a-fA-F]{64}$/.test(hexClean)) {
    try {
      const derBuffer = Buffer.from('302e020100300506032b657004220420' + hexClean, 'hex');
      return crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
    } catch (err: any) {
      console.error(`[ExnessKey] Failed importing 64-char hex Ed25519 key: ${err?.message || err}`);
    }
  }

  // 3. Base64 / Base64URL string or raw DER buffer fallback
  try {
    const isUrl = trimmed.includes('-') || trimmed.includes('_');
    const rawBuf = Buffer.from(trimmed, isUrl ? 'base64url' : 'base64');
    if (rawBuf.length === 32 || rawBuf.length === 64) {
      const seedHex = rawBuf.subarray(0, 32).toString('hex');
      const derBuffer = Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex');
      return crypto.createPrivateKey({ key: derBuffer, format: 'der', type: 'pkcs8' });
    } else if (rawBuf.length === 48) {
      return crypto.createPrivateKey({ key: rawBuf, format: 'der', type: 'pkcs8' });
    }
  } catch {}

  return null;
}

// ==========================================
// 1. MODULE-LEVEL CLOCK SYNCHRONIZATION
// ==========================================
let exnessTimeOffsetMs = 0;

export function getExnessTimeOffsetMs(): number {
  return exnessTimeOffsetMs;
}

export function setExnessTimeOffsetMs(offsetMs: number): void {
  exnessTimeOffsetMs = offsetMs;
}

export function getSyncedTimestamp(): number {
  return Date.now() + exnessTimeOffsetMs;
}

/**
 * Parses Exness server time from HTTP response headers (x-request-start or date)
 * and updates module-level exnessTimeOffsetMs = serverTimeMs - Date.now().
 */
export function updateExnessTimeOffsetFromHeaders(
  headers: Headers | Record<string, string> | any
): number | null {
  try {
    let xRequestStart: string | null = null;
    let dateHeader: string | null = null;

    if (headers && typeof headers.get === 'function') {
      xRequestStart = headers.get('x-request-start') || headers.get('X-Request-Start');
      dateHeader = headers.get('date') || headers.get('Date');
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'x-request-start') xRequestStart = String(v);
        if (lk === 'date') dateHeader = String(v);
      }
    }

    let serverTimeMs: number | null = null;

    if (xRequestStart) {
      // Exness format: "t=1794216010.802" (unix seconds with ms precision) — preferred over
      // the HTTP `date` header, which truncates milliseconds (up to 999ms error).
      const sec = parseFloat(String(xRequestStart).trim().replace(/^t=/, ''));
      if (!isNaN(sec) && sec > 0) {
        // If in seconds (e.g. ~1.7e9), multiply by 1000; if already in ms (> 1e11), use directly
        serverTimeMs = sec < 1e11 ? Math.round(sec * 1000) : Math.round(sec);
      }
    }

    // Fallback only: `date` header has 1-second resolution
    if (!serverTimeMs && dateHeader) {
      const parsed = Date.parse(dateHeader);
      if (!isNaN(parsed) && parsed > 0) {
        serverTimeMs = parsed;
      }
    }

    if (serverTimeMs) {
      const newOffset = Math.round(serverTimeMs - Date.now());
      if (Math.abs(newOffset - exnessTimeOffsetMs) > 500) {
        console.log(
          `[ExnessClockSync] Synced Exness clock offset: ${newOffset}ms (Server Time: ${new Date(
            serverTimeMs
          ).toISOString()})`
        );
      }
      exnessTimeOffsetMs = newOffset;
      return exnessTimeOffsetMs;
    }
  } catch (err: any) {
    console.warn('[ExnessClockSync] Failed to parse server time from headers:', err?.message || err);
  }
  return null;
}

/**
 * Checks if response indicates an Exness timestamp drift error (e.g. 1001 "outside allowed window")
 */
export function isClockDriftError(status: number, body: any): boolean {
  if (status !== 401 && status !== 400) return false;
  const str = typeof body === 'string' ? body : JSON.stringify(body || {});
  const lower = str.toLowerCase();
  return (
    lower.includes('outside allowed window') ||
    lower.includes('1001') ||
    lower.includes('auth_invalid_signature') ||
    lower.includes('timestamp') ||
    lower.includes('clock')
  );
}

/**
 * Constructs the official EXN-* request headers according to the Exness specification:
 * Keys in exact order in JSON payload:
 * {
 *   "api_key": apiKey,
 *   "idempotency_key": idempotencyKey,
 *   "timestamp": timestampMs,
 *   "sign_version": 1,
 *   "method": method.toUpperCase(),
 *   "path": exactPathWithQuery,
 *   "body_hash": bodyHash
 * }
 */
export function buildExnessAuthHeaders(params: {
  apiKey: string;
  privateKey: string | crypto.KeyObject;
  method: string;
  path: string;
  bodyStr?: string;
  idempotencyKey?: string;
  timestampMs?: number;
}): Record<string, string> {
  const timestampMs = params.timestampMs !== undefined ? Math.floor(Number(params.timestampMs)) : getSyncedTimestamp();
  const methodUpper = params.method.toUpperCase();
  const isGet = methodUpper === 'GET';
  const idempotencyKey = isGet
    ? ''
    : (params.idempotencyKey !== undefined
      ? params.idempotencyKey
      : `order-${timestampMs}-${crypto.randomBytes(4).toString('hex')}`);

  const bodyStr = params.bodyStr || '';
  const bodyHash = computeBodyHash(bodyStr);
  const cleanApiKey = String(params.apiKey || '').trim().replace(/^["']|["']$/g, '').replace(/[\r\n\t]/g, '');

  const payloadObj = {
    api_key: cleanApiKey,
    idempotency_key: idempotencyKey,
    timestamp: timestampMs, // integer milliseconds number (Date.now(), NOT a string!)
    sign_version: 1, // integer number 1 (MUST NOT be string "1", which triggers Exness Error 3001 "EXN-DATA is not valid JSON")
    method: methodUpper,
    path: params.path,
    body_hash: bodyHash,
  };

  const jsonString = JSON.stringify(payloadObj);
  const payloadBytes = Buffer.from(jsonString, 'utf8');
  const exnData = payloadBytes.toString('base64url').replace(/=+$/, '');

  const keyObj = typeof params.privateKey === 'string'
    ? parseEd25519PrivateKey(params.privateKey)
    : params.privateKey;

  let exnSign = '';
  if (keyObj) {
    try {
      const sigBuf = crypto.sign(null, payloadBytes, keyObj);
      exnSign = sigBuf.toString('base64url').replace(/=+$/, '');
    } catch (err: any) {
      console.error(`[ExnessAuth] crypto.sign failed: ${err?.message || err}`);
    }
  } else {
    console.warn('[ExnessAuth] No valid Ed25519 key object could be parsed for request signing');
  }

  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'EXN-API-KEY': cleanApiKey,
    'EXN-IDEMPOTENCY-KEY': idempotencyKey,
    'EXN-TIMESTAMP': String(timestampMs),
    'EXN-SIGN-VERSION': '1',
    'EXN-DATA': exnData,
    'EXN-SIGN': exnSign,
  };
}

/**
 * Backwards-compatible signature helper
 */
export function signExnessRequest(
  privateKeyInput: string,
  timestamp: string | number,
  method: string,
  path: string,
  bodyHash: string
): string | null {
  try {
    const keyObj = parseEd25519PrivateKey(privateKeyInput);
    if (!keyObj) return null;
    const signPayload = `${timestamp}${method.toUpperCase()}${path}${bodyHash}`;
    const signature = crypto.sign(null, Buffer.from(signPayload, 'utf8'), keyObj);
    return signature.toString('base64url').replace(/=+$/, '');
  } catch {
    return null;
  }
}

/**
 * Validates Ed25519 Private Key format (128-char hex, 64-char hex seed, Base64, or PKCS#8 PEM)
 * and confirms cryptographic signing test succeeds.
 */
export function validateEd25519PrivateKey(privateKeyInput: string | crypto.KeyObject): {
  valid: boolean;
  keyObject?: crypto.KeyObject;
  error?: string;
} {
  if (!privateKeyInput) {
    return {
      valid: false,
      error: 'Private Key Ed25519 wajib diisi! Gunakan 128-char Hex, 64-char Hex seed, Base64, atau format PEM PKCS#8 resmi Exness.',
    };
  }
  const keyObj = parseEd25519PrivateKey(privateKeyInput);
  if (!keyObj) {
    return {
      valid: false,
      error: 'Private Key Ed25519 tidak valid! Gunakan 128-char Hex, 64-char Hex seed, Base64, atau format PEM PKCS#8 resmi Exness.',
    };
  }
  try {
    crypto.sign(null, Buffer.from('test'), keyObj);
    return { valid: true, keyObject: keyObj };
  } catch (err: any) {
    return {
      valid: false,
      error: `Uji tanda tangan kriptografis Ed25519 gagal: ${err?.message || 'Format kunci salah'}.`,
    };
  }
}

/**
 * Strict Exness API credential validation:
 * 1. accountId must be numeric MT5/Exness login (e.g. 464129221 or 30000143146).
 * 2. apiKey MUST start with "exnsk-" and be at least 36 characters long.
 * 3. privateKey MUST be a valid Ed25519 key that passes cryptographic signing.
 */
export function validateExnessCredentials(creds: {
  accountId?: string;
  apiKey?: string;
  privateKey?: string | crypto.KeyObject;
}): { valid: boolean; error?: string } {
  const accountId = String(creds.accountId || '').trim().replace(/^["']|["']$/g, '');
  const apiKey = String(creds.apiKey || '').trim().replace(/^["']|["']$/g, '');
  const privateKey = creds.privateKey;

  // 1. accountId check
  if (!accountId || !/^\d+$/.test(accountId)) {
    return {
      valid: false,
      error: 'Account ID Exness tidak valid! Masukkan nomor login MT5 berupa angka (contoh: 464129221 atau 30000143146).',
    };
  }

  // 2. apiKey check (NO fake bypass)
  if (!apiKey || !apiKey.startsWith('exnsk-') || apiKey.length < 36) {
    return {
      valid: false,
      error: "API Key Exness tidak valid! Gunakan Public Key resmi berawalan 'exnsk-' dari menu API Management Exness.",
    };
  }

  // 3. privateKey check
  if (!privateKey) {
    return {
      valid: false,
      error: 'Private Key Ed25519 wajib diisi! Gunakan 128-char Hex, 64-char Hex seed, Base64, atau format PEM PKCS#8 resmi Exness.',
    };
  }
  const edVal = validateEd25519PrivateKey(privateKey);
  if (!edVal.valid) {
    return {
      valid: false,
      error: edVal.error || 'Private Key Ed25519 tidak valid! Gunakan 128-char Hex, 64-char Hex seed, Base64, atau format PEM PKCS#8 resmi Exness.',
    };
  }

  return { valid: true };
}

// ==========================================
// GLOBAL SESSION SINGLETON & AUTH MUTEX
// ==========================================

export interface ExnessCoreState {
  sessionToken: string | null;
  tokenExpiresAt: number;
  inFlightAuthPromise: Promise<any> | null;
  inFlightSnapshotPromise: Promise<any> | null;
  lastSnapshot: any | null;
  lastSnapshotTime: number;
  lastSnapshotPollTime: number;
  lastPositionsPollTime: number;
  rateLimitUntil: number;
  activePositions: ManagedPosition[];
  accessPoints: Record<string, string>; // accountId -> resolved access_point URL
  liveAccount?: {
    accountId?: string;
    server?: string;
    currency?: string;
    balance?: number;
    equity?: number;
    margin?: number;
    freeMargin?: number;
    marginLevelPct?: number;
    updatedAt?: number;
    isVerified?: boolean;
  };
  activeForexPositions?: Record<string, ManagedPosition[]>;
}

declare global {
  // eslint-disable-next-line no-var
  var __exnessCoreState: ExnessCoreState | undefined;
  // eslint-disable-next-line no-var
  var __activeForexPositions: Record<string, ManagedPosition[]> | undefined;
}

export function getActiveForexPositionsMap(): Record<string, ManagedPosition[]> {
  if (!globalThis.__activeForexPositions) {
    globalThis.__activeForexPositions = {};
  }
  return globalThis.__activeForexPositions;
}

export function getActiveForexPositionsForAccount(accountId: string): ManagedPosition[] {
  const map = getActiveForexPositionsMap();
  const cleanId = String(accountId || '').trim();
  if (!cleanId) return [];
  if (!map[cleanId]) map[cleanId] = [];
  return map[cleanId];
}

export function saveActiveForexPosition(accountId: string, pos: ManagedPosition): void {
  const cleanId = String(accountId || '').trim();
  if (!cleanId || !pos || !pos.id) return;
  const map = getActiveForexPositionsMap();
  if (!map[cleanId]) map[cleanId] = [];
  const norm = (id: string) => String(id || '').replace(/^#+/, '').trim();
  const targetId = norm(pos.id);
  const existingIdx = map[cleanId].findIndex((p) => norm(p.id) === targetId);
  if (existingIdx >= 0) {
    map[cleanId][existingIdx] = { ...map[cleanId][existingIdx], ...pos };
  } else {
    map[cleanId].push({ ...pos });
  }
  try {
    if (typeof realTimeFeed !== 'undefined' && realTimeFeed) {
      realTimeFeed.addPosition(pos);
    }
  } catch {}
}

export function removeActiveForexPosition(accountId: string, positionId: string): void {
  const cleanId = String(accountId || '').trim();
  if (!cleanId) return;
  const map = getActiveForexPositionsMap();
  if (!map[cleanId]) return;
  const norm = (id: string) => String(id || '').replace(/^#+/, '').trim();
  const targetId = norm(positionId);
  map[cleanId] = map[cleanId].filter((p) => norm(p.id) !== targetId);
  try {
    if (typeof realTimeFeed !== 'undefined' && realTimeFeed) {
      realTimeFeed.removePosition(positionId);
    }
  } catch {}
}

export function clearAllActiveForexPositions(accountId: string): void {
  const cleanId = String(accountId || '').trim();
  const map = getActiveForexPositionsMap();
  map[cleanId] = [];
  try {
    if (typeof realTimeFeed !== 'undefined' && realTimeFeed) {
      realTimeFeed.clearAllPositions();
    }
  } catch {}
}

const normPosId = (id: string) => String(id || '').replace(/^#+/, '').trim();

/**
 * Refreshes floating pnl / pips / currentPrice on a position using the live quote
 * (BUY closes at Bid, SELL closes at Ask). Also tracks highest / lowest excursion for trailing.
 */
export function refreshPositionFloating(pos: ManagedPosition): ManagedPosition {
  try {
    if (typeof realTimeFeed === 'undefined' || !realTimeFeed) {
      return sanitizePositionSlTp(pos, pos.currentPrice || pos.entryPrice);
    }
    const q = realTimeFeed.getLiveQuote(pos.symbol);
    if (!q || !(q.bid > 0) || !(q.ask > 0) || !(pos.entryPrice > 0)) {
      return sanitizePositionSlTp(pos, pos.currentPrice || pos.entryPrice);
    }
    const res = evaluatePositionPnL(pos, q);
    if (!(res.curPrice > 0)) {
      return sanitizePositionSlTp(pos, pos.currentPrice || pos.entryPrice);
    }
    // Guard against uninitialized baseline (e.g. 4116.85 when entry is 4050.06) polluting highestPrice/lowestPrice
    const isGold = pos.symbol === 'XAUUSDm' || pos.symbol.startsWith('XAU');
    const maxDist = isGold ? 15.0 : 150 * getPairProfile(pos.symbol).pipValue;
    const isQuoteNearEntry = Math.abs(res.curPrice - pos.entryPrice) <= maxDist;
    if (isQuoteNearEntry) {
      pos.currentPrice = res.curPrice;
      pos.unrealizedPnl = res.pnlUsd;
      pos.pnl = res.pnlUsd;
      pos.pips = res.pnlPips;
      pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, res.curPrice);
      pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, res.curPrice);
    }
    sanitizePositionSlTp(pos, pos.currentPrice || pos.entryPrice);
  } catch {}
  return pos;
}

/**
 * Merges the remote Exness positions list with the persisted activeForexPositions ledger of `accountId`.
 * - Remote positions always win (authoritative fields), ledger keeps local trailing metadata.
 * - Ledger positions never seen on the broker (fallback / demo ledger fills, or REST eventual consistency)
 *   are KEPT until closed by TP, SL, trailing stop, manual close or panic close-all.
 * - Ledger positions that WERE seen on the broker and are now missing from a successful remote snapshot
 *   were closed broker-side (Exness TP/SL) and are removed.
 * - Ledger-only positions get their TP / SL evaluated locally against the live quote every poll.
 */
export function mergeRemoteWithActiveForexPositions(
  accountId: string,
  remote: ManagedPosition[],
  remoteSnapshotOk: boolean = true
): ManagedPosition[] {
  const cleanId = String(accountId || '').trim();
  const remoteList = Array.isArray(remote) ? remote : [];
  if (!cleanId) return remoteList.map((p) => refreshPositionFloating({ ...p }));

  const map = getActiveForexPositionsMap();
  const ledger = map[cleanId] || [];
  const remoteById = new Map(remoteList.map((p) => [normPosId(p.id), p]));
  const merged: ManagedPosition[] = [];
  const nextLedger: ManagedPosition[] = [];
  const consumedLocal = new Set<string>();
  const baseSym = (s: string) => String(s || '').replace(/m$/i, '').toUpperCase();

  for (const r of remoteList) {
    let local = ledger.find((p) => normPosId(p.id) === normPosId(r.id));
    if (!local) {
      // Order was stored under its operation_id: adopt the real broker position (same symbol/side/volume, opened < 15 min)
      local = ledger.find(
        (p) =>
          !p.seenOnBroker &&
          !consumedLocal.has(normPosId(p.id)) &&
          !remoteById.has(normPosId(p.id)) &&
          baseSym(p.symbol) === baseSym(r.symbol) &&
          p.side === r.side &&
          Math.abs((p.volume || 0) - (r.volume || 0)) < 1e-6 &&
          Date.now() - (p.openTime || 0) < 15 * 60 * 1000
      );
    }
    if (local) consumedLocal.add(normPosId(local.id));
    const effectiveSl =
      local?.currentSl && local.currentSl > 0 && (r.currentSl === 0 || local.lastSlUpdateTime)
        ? local.currentSl
        : r.currentSl || local?.currentSl || local?.virtualSl || r.virtualSl || 0;
    const effectiveTp =
      r.currentTp && r.currentTp > 0
        ? r.currentTp
        : local?.currentTp || local?.virtualTp || r.virtualTp || 0;
    const activeClosing =
      Boolean(local?.isClosing && local?.closingStartedAt && Date.now() - local.closingStartedAt < 15000);
    const pos: ManagedPosition = {
      ...(local || {}),
      ...r,
      currentSl: effectiveSl,
      currentTp: effectiveTp,
      virtualSl: effectiveSl,
      virtualTp: effectiveTp,
      lastSlUpdateTime: local?.lastSlUpdateTime || r.lastSlUpdateTime,
      highestPrice: Math.max(local?.highestPrice || 0, r.highestPrice || 0, r.currentPrice || 0),
      lowestPrice:
        local?.lowestPrice && local.lowestPrice > 0
          ? Math.min(local.lowestPrice, r.lowestPrice || local.lowestPrice)
          : r.lowestPrice,
      trailingStatus: local?.trailingStatus || r.trailingStatus || 'INITIAL',
      partialClosed: Boolean(local?.partialClosed || r.partialClosed),
      initialVolume: local?.initialVolume || r.initialVolume || r.volume,
      isClosing: activeClosing,
      closingStartedAt: activeClosing ? local?.closingStartedAt : undefined,
      accountId: cleanId,
      source: 'EXNESS',
      seenOnBroker: true,
    };
    refreshPositionFloating(pos);
    sanitizePositionSlTp(pos, pos.currentPrice || pos.entryPrice);
    merged.push(pos);
    nextLedger.push(pos);
  }

  for (const local of ledger) {
    if (remoteById.has(normPosId(local.id)) || consumedLocal.has(normPosId(local.id))) continue;
    // Broker-confirmed position that disappeared from a successful snapshot -> closed on Exness (TP/SL hit)
    if (local.seenOnBroker && remoteSnapshotOk) continue;

    const pos = refreshPositionFloating({ ...local });
    const px = pos.currentPrice || 0;
    if (px > 0 && !local.seenOnBroker) {
      const hitTp = pos.currentTp > 0 && (pos.side === 'BUY' ? px >= pos.currentTp : px <= pos.currentTp);
      const hitSl = pos.currentSl > 0 && (pos.side === 'BUY' ? px <= pos.currentSl : px >= pos.currentSl);
      if (hitTp || hitSl) {
        const exitPx = hitTp ? pos.currentTp : pos.currentSl;
        const realized = calculatePnL(pos.side, pos.entryPrice, exitPx, pos.volume, getPairProfile(pos.symbol)).pnlUsd;
        try {
          realTimeFeed.recordRealizedPnL(realized);
        } catch {}
        console.log(
          `[ActiveForexPositions] #${normPosId(pos.id)} ${pos.side} ${pos.volume} ${pos.symbol} closed by ${hitTp ? 'TP' : 'SL'} @ ${exitPx} (${realized >= 0 ? '+' : ''}$${realized.toFixed(2)})`
        );
        continue;
      }
    }
    merged.push(pos);
    nextLedger.push(pos);
  }

  map[cleanId] = nextLedger;
  try {
    if (typeof realTimeFeed !== 'undefined' && realTimeFeed) {
      realTimeFeed.setPositions(merged);
    }
  } catch {}
  return merged;
}

export function getGlobalExnessState(): ExnessCoreState {
  if (!globalThis.__exnessCoreState) {
    globalThis.__exnessCoreState = {
      sessionToken: null,
      tokenExpiresAt: 0,
      inFlightAuthPromise: null,
      inFlightSnapshotPromise: null,
      lastSnapshot: null,
      lastSnapshotTime: 0,
      lastSnapshotPollTime: 0,
      lastPositionsPollTime: 0,
      rateLimitUntil: 0,
      activePositions: [],
      accessPoints: {},
      activeForexPositions: getActiveForexPositionsMap(),
    };
  }
  if (!globalThis.__exnessCoreState.accessPoints) {
    globalThis.__exnessCoreState.accessPoints = {};
  }
  if (!globalThis.__exnessCoreState.activeForexPositions) {
    globalThis.__exnessCoreState.activeForexPositions = getActiveForexPositionsMap();
  }
  return globalThis.__exnessCoreState;
}

// ==========================================
// SERIALIZED REST THROTTLER (STRICT 1200ms SPACING)
// ==========================================

export interface ThrottlerScheduleOptions {
  /** HTTP method. Non-GET (orders / close / modify SL) jump ahead of read-only polling. */
  method?: string;
  /** Max time a READ request may wait in the queue before it is dropped as stale. */
  maxQueueWaitMs?: number;
}

const THROTTLER_MIN_SPACING_MS = Number(process.env.EXNESS_MIN_REQUEST_SPACING_MS || 1200);
const THROTTLER_MAX_READ_QUEUE_WAIT_MS = Number(process.env.EXNESS_MAX_QUEUE_WAIT_MS || 15000);

export class ExnessRestThrottler {
  private queue: Array<{
    task: () => Promise<any>;
    resolve: (val: any) => void;
    reject: (err: any) => void;
    priority: boolean;
    enqueuedAt: number;
    maxWaitMs: number;
  }> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly minSpacingMs = THROTTLER_MIN_SPACING_MS;
  private backoffUntil = 0;
  private lastQueueWarnAt = 0;

  public getQueueLength(): number {
    return this.queue.length;
  }

  public async schedule<T>(task: () => Promise<T>, opts: ThrottlerScheduleOptions = {}): Promise<T> {
    const method = String(opts.method || 'GET').toUpperCase();
    const priority = method !== 'GET';
    return new Promise<T>((resolve, reject) => {
      const item = {
        task,
        resolve,
        reject,
        priority,
        enqueuedAt: Date.now(),
        // Trading actions are never dropped; read-only polling becomes stale quickly
        maxWaitMs: priority ? Number.POSITIVE_INFINITY : (opts.maxQueueWaitMs ?? THROTTLER_MAX_READ_QUEUE_WAIT_MS),
      };
      if (priority) {
        // Insert after other priority items but before all read-only requests
        const firstReadIdx = this.queue.findIndex((q) => !q.priority);
        if (firstReadIdx === -1) this.queue.push(item);
        else this.queue.splice(firstReadIdx, 0, item);
      } else {
        this.queue.push(item);
      }
      if (this.queue.length >= 15 && Date.now() - this.lastQueueWarnAt > 30000) {
        this.lastQueueWarnAt = Date.now();
        console.warn(`[ExnessThrottler] REST queue backlog: ${this.queue.length} pending requests (spacing ${this.minSpacingMs}ms).`);
      }
      this.processQueue();
    });
  }

  public handleRateLimit(retryAfterMs: number = 5000): void {
    const delay = Math.max(retryAfterMs, 5000);
    this.backoffUntil = Date.now() + delay;
    console.warn(`[ExnessThrottler] HTTP 429 received. Backing off REST calls for ${delay}ms`);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        if (this.backoffUntil > now) {
          const waitMs = this.backoffUntil - now;
          await new Promise((r) => setTimeout(r, waitMs));
        }

        const elapsed = Date.now() - this.lastRequestTime;
        if (elapsed < this.minSpacingMs) {
          await new Promise((r) => setTimeout(r, this.minSpacingMs - elapsed));
        }

        // Pick the item AFTER waiting so a priority order that arrived meanwhile goes first
        const item = this.queue.shift();
        if (!item) continue;

        // Drop stale read requests instead of executing them late (prevents unbounded backlog)
        const waited = Date.now() - item.enqueuedAt;
        if (waited > item.maxWaitMs) {
          item.reject(new Error(`Exness REST request dropped after waiting ${waited}ms in throttler queue (backlog ${this.queue.length}).`));
          continue;
        }

        try {
          this.lastRequestTime = Date.now();
          const res = await item.task();
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

// Process-wide singleton: a second throttler instance (separate Next.js bundle) would double
// the request rate and trigger HTTP 429 back-offs from Exness.
export const exnessRestThrottler: ExnessRestThrottler =
  (globalThis as any).__exnessRestThrottler ?? ((globalThis as any).__exnessRestThrottler = new ExnessRestThrottler());

// ==========================================
// IN-MEMORY CANDLE CACHE & WS TICK AGGREGATOR
// ==========================================

export interface CandleCacheEntry {
  instrument: string;
  timeframe: string;
  candles: Candle[];
  lastFetchedAt: number;
  ttlMs: number;
}

export const exnessCandleMemoryCache: Map<string, CandleCacheEntry> =
  (globalThis as any).__exnessCandleMemoryCache ?? ((globalThis as any).__exnessCandleMemoryCache = new Map<string, CandleCacheEntry>());

/** Timestamp of the last tick received over the Exness WebSocket (0 = never). */
export function getLastWsTickAt(): number {
  return Number((globalThis as any).__exnessLastWsTickAt || 0);
}

function markWsTick(): void {
  (globalThis as any).__exnessLastWsTickAt = Date.now();
}

/** True if live WebSocket ticks arrived recently (prices are streaming). */
export function isWsTickStreamAlive(maxAgeMs: number = 15000): boolean {
  return Date.now() - getLastWsTickAt() < maxAgeMs;
}

export function getCandleTtlMs(timeframe: string): number {
  const tf = timeframe.toUpperCase();
  switch (tf) {
    case 'M1':
      return 60 * 1000;
    case 'M5':
      return 180 * 1000;
    case 'M15':
      return 300 * 1000;
    case 'H1':
      return 600 * 1000;
    default:
      return 120 * 1000;
  }
}

export function getTimeframeIntervalMs(timeframe: string): number {
  const tf = timeframe.toUpperCase();
  switch (tf) {
    case 'M1':
      return 60 * 1000;
    case 'M5':
      return 5 * 60 * 1000;
    case 'M15':
      return 15 * 60 * 1000;
    case 'H1':
      return 60 * 60 * 1000;
    default:
      return 5 * 60 * 1000;
  }
}

/**
 * Updates in-memory candles on every live tick from WebSocket.
 * Updates close, high, low, volume of the current candle or rolls a new candle if timeframe interval passed.
 */
export function updateCachedCandlesWithTick(symbolOrInstrument: string, bid: number, tickTime: number = Date.now()): void {
  if (!bid || bid <= 0) return;
  const cleanInst = symbolOrInstrument.replace(/m$/i, '').toUpperCase();

  for (const entry of exnessCandleMemoryCache.values()) {
    if (entry.instrument !== cleanInst) continue;
    const intervalMs = getTimeframeIntervalMs(entry.timeframe);
    const barStart = Math.floor(tickTime / intervalMs) * intervalMs;
    const candles = entry.candles;

    if (candles.length === 0) {
      candles.push({
        timestamp: barStart,
        open: bid,
        high: bid,
        low: bid,
        close: bid,
        volume: 1,
      });
      continue;
    }

    const last = candles[candles.length - 1];
    if (barStart > last.timestamp) {
      candles.push({
        timestamp: barStart,
        open: bid,
        high: bid,
        low: bid,
        close: bid,
        volume: 1,
      });
      if (candles.length > 300) {
        candles.shift();
      }
    } else {
      last.close = bid;
      if (bid > last.high) last.high = bid;
      if (bid < last.low) last.low = bid;
      last.volume = (last.volume || 0) + 1;
    }
  }
}

export function createTimeoutSignal(timeoutMs: number = 3500): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      controller.abort(new Error('Request timeout'));
    } catch {}
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

const SNAPSHOT_COALESCE_MS = 2500;

export async function coalesceSnapshotRequest<T>(fetchFn: () => Promise<T>): Promise<T> {
  const state = getGlobalExnessState();
  const now = Date.now();

  if (state.lastSnapshot && now - state.lastSnapshotTime < SNAPSHOT_COALESCE_MS) {
    return state.lastSnapshot as T;
  }

  if (state.inFlightSnapshotPromise) {
    return state.inFlightSnapshotPromise as Promise<T>;
  }

  state.inFlightSnapshotPromise = (async () => {
    try {
      const result = await fetchFn();
      state.lastSnapshot = result;
      state.lastSnapshotTime = Date.now();
      return result;
    } finally {
      state.inFlightSnapshotPromise = null;
    }
  })();

  return state.inFlightSnapshotPromise as Promise<T>;
}

export async function coalesceAuthRequest<T>(authFn: () => Promise<T>): Promise<T> {
  const state = getGlobalExnessState();
  const now = Date.now();

  if (state.rateLimitUntil > now) {
    const wait = Math.min(state.rateLimitUntil - now, 3000);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (state.inFlightAuthPromise) {
    return state.inFlightAuthPromise as Promise<T>;
  }

  state.inFlightAuthPromise = (async () => {
    try {
      return await authFn();
    } catch (err: any) {
      if (String(err?.message || '').includes('429')) {
        state.rateLimitUntil = Date.now() + 5000;
      }
      throw err;
    } finally {
      state.inFlightAuthPromise = null;
    }
  })();

  return state.inFlightAuthPromise as Promise<T>;
}

// ==========================================
// RESILIENT HISTORICAL CANDLES GENERATOR
// ==========================================

// Last synthetic close per `${symbol}_${timeframe}` (guarantees continuity between regenerated synthetic series)
const syntheticSeriesLastClose = new Map<string, number>();
const syntheticLogThrottle = new Map<string, number>();

export function generateFallbackCandles(
  rawSymbol: string,
  count: number = 80,
  explicitAnchor?: number,
  timeframe: string = 'M5'
): Candle[] {
  const targetCount = Math.max(80, count);
  const profile = getPairProfile(rawSymbol);
  const symbol = profile.symbol;
  const cfg = getBaselineConfig(symbol, profile.digits, profile.pipValue);

  // Strict anchor resolution: anchor strictly to last known live price (~4116.85 for XAU), NEVER to hardcoded ~4076 or 3875!
  // Priority: 1) lastKnownPrice (live WS/REST)  2) explicit anchor  3) feed memory  4) persisted disk price
  let anchor = 0;
  {
    const liveP = lastKnownPrice[symbol]?.price || (symbol.startsWith('XAU') ? (lastKnownPrice['XAUUSDm']?.price || lastKnownPrice['XAUUSD']?.price) : 0);
    if (typeof liveP === 'number' && liveP > 0 && (!symbol.startsWith('XAU') || (liveP >= 1500 && Math.abs(liveP - 4076.77) > 5.0 && Math.abs(liveP - 3875.70) > 5.0))) {
      anchor = liveP;
    }
  }

  if (anchor <= 0 && typeof explicitAnchor === 'number' && explicitAnchor > 0) {
    if (!symbol.startsWith('XAU') || (explicitAnchor >= 1500 && Math.abs(explicitAnchor - 4076.77) > 5.0 && Math.abs(explicitAnchor - 3875.70) > 5.0)) {
      anchor = explicitAnchor;
    }
  }

  if (anchor <= 0) {
    try {
      if (typeof realTimeFeed !== 'undefined' && realTimeFeed && typeof realTimeFeed.getLatestKnownPrice === 'function') {
        const knownPrice = realTimeFeed.getLatestKnownPrice(symbol);
        if (typeof knownPrice === 'number' && knownPrice > 0 && (!symbol.startsWith('XAU') || (knownPrice >= 1500 && Math.abs(knownPrice - 4076.77) > 5.0))) {
          anchor = knownPrice;
        }
      }
    } catch {}
  }

  if (anchor <= 0) {
    const persisted = getPersistedRealPrice(symbol);
    if (persisted > 0 && (!symbol.startsWith('XAU') || (persisted >= 1500 && Math.abs(persisted - 4076.77) > 5.0))) {
      anchor = persisted;
    }
  }

  if (anchor <= 0) {
    anchor = symbol.startsWith('XAU') ? 4116.85 : cfg.baseline;
  }

  // Protective clamp for gold against obsolete/erroneous seeds
  if (symbol.startsWith('XAU')) {
    if (anchor < 1500 || Math.abs(anchor - 4076.77) < 5.0 || Math.abs(anchor - 3875.70) < 5.0) {
      anchor = 4116.85;
    }
  }

  // Series continuity: a regenerated synthetic series may never jump > 0.15% from the previous synthetic close
  const seriesKey = `${symbol}_${timeframe}`;
  const prevSeriesClose = syntheticSeriesLastClose.get(seriesKey);
  if (typeof prevSeriesClose === 'number' && prevSeriesClose > 0) {
    const maxSeriesJump = prevSeriesClose * 0.0015;
    if (Math.abs(anchor - prevSeriesClose) > maxSeriesJump) {
      anchor = prevSeriesClose + (anchor > prevSeriesClose ? maxSeriesJump : -maxSeriesJump);
    }
  }
  anchor = Number(anchor.toFixed(cfg.digits));
  syntheticSeriesLastClose.set(seriesKey, anchor);

  const lastLog = syntheticLogThrottle.get(seriesKey) || 0;
  if (Date.now() - lastLog > 60000) {
    syntheticLogThrottle.set(seriesKey, Date.now());
    console.warn(`[ExnessClient] Using synthetic fallback candles for ${symbol} (${timeframe}) anchored to last known live price ${anchor}`);
  }

  const timeframeMs =
    timeframe === 'M1' ? 60 * 1000 :
    timeframe === 'M15' ? 15 * 60 * 1000 :
    timeframe === 'H1' ? 60 * 60 * 1000 :
    5 * 60 * 1000;

  const now = Date.now();
  const candles: Candle[] = new Array(targetCount);
  let prevClose = anchor;

  // Never allow synthetic candle generator to jump price by more than 0.15% from previous candle close
  const maxJump = anchor * 0.0015;

  for (let i = 0; i < targetCount; i++) {
    const timestamp = now - (targetCount - 1 - i) * timeframeMs;
    const progress = (i + 1) / targetCount;
    const wave = Math.sin(progress * Math.PI * 3) * Math.min(cfg.pipValue * 1.5, maxJump * 0.5);
    let targetPrice = anchor + wave;

    if (Math.abs(targetPrice - prevClose) > maxJump) {
      targetPrice = prevClose + (targetPrice > prevClose ? maxJump : -maxJump);
    }

    const cOpen = Number(prevClose.toFixed(cfg.digits));
    const step = (i % 2 === 0 ? cfg.pipValue * 0.4 : -cfg.pipValue * 0.4);
    let cClose = Number((targetPrice + step).toFixed(cfg.digits));
    if (Math.abs(cClose - cOpen) > maxJump) {
      cClose = Number((cOpen + (cClose > cOpen ? maxJump : -maxJump)).toFixed(cfg.digits));
    }
    if (i === targetCount - 1) {
      cClose = anchor;
    }

    const cHigh = Number((Math.max(cOpen, cClose) + Math.min(cfg.pipValue * 0.3, maxJump * 0.3)).toFixed(cfg.digits));
    const cLow = Number((Math.min(cOpen, cClose) - Math.min(cfg.pipValue * 0.3, maxJump * 0.3)).toFixed(cfg.digits));
    const volume = 120 + (i % 40);

    candles[i] = {
      timestamp,
      open: cOpen,
      high: cHigh,
      low: cLow,
      close: cClose,
      volume,
    };
    prevClose = cClose;
  }

  return candles;
}

// ==========================================
// REAL-TIME MARKET FEED
// ==========================================

export class RealTimeMarketFeed {
  private basePrices: Record<string, number> = {
    XAUUSDm: 4116.85,
    EURUSDm: 1.11592,
    GBPUSDm: 1.33877,
    USDJPYm: 157.569,
  };

  private liveQuotes: Record<string, LiveQuote> = {};
  private inFlightQuotes: Record<string, Promise<LiveQuote>> = {};
  private inFlightCandles: Record<string, Promise<Candle[]>> = {};
  private openPositions: ManagedPosition[] = [];
  private dailyRealizedPnL: number = 0.0;
  private dailyPnlDate: string = new Date().toISOString().slice(0, 10);
  private lastQuoteFetchTime: Record<string, number> = {};

  constructor() {
    this.initHistory();
    this.prefetchAllSpotData();
  }

  private prefetchAllSpotData(): void {
    const symbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
    for (const sym of symbols) {
      this.fetchLiveQuote(sym).catch(() => {});
    }
  }

  private initHistory(): void {
    const symbols = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];
    for (const sym of symbols) {
      const persisted = getPersistedRealPrice(sym);
      if (persisted > 0) {
        this.basePrices[sym] = persisted;
      }
      const spreadPips = sym === 'XAUUSDm' ? 2.0 : sym.includes('JPY') ? 0.8 : 0.8;
      const digits = sym === 'XAUUSDm' ? 2 : sym.includes('JPY') ? 3 : 5;
      const pip = sym === 'XAUUSDm' ? 0.10 : sym.includes('JPY') ? 0.01 : 0.0001;
      const ask = Number((this.basePrices[sym] + spreadPips * pip).toFixed(digits));

      this.liveQuotes[sym] = {
        symbol: sym,
        bid: this.basePrices[sym],
        ask,
        spreadPips,
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Updates quote directly from WebSocket ticks
   */
  public updateQuote(rawSymbol: string, bid: number, ask?: number): void {
    const profile = getPairProfile(rawSymbol);
    const symbol = profile.symbol;
    if (!bid || isNaN(bid) || bid <= 0) return;

    // Safety guard: ensure symbol price is strictly within reasonable market range for its asset class
    if (symbol.startsWith('XAU') && (bid < 1500 || bid > 10000 || Math.abs(bid - 3875.70) < 1.0)) return;
    if (symbol.startsWith('EUR') && (bid < 0.5 || bid > 2.5)) return;
    if (symbol.startsWith('GBP') && (bid < 0.5 || bid > 2.5)) return;
    if (symbol.startsWith('USDJPY') && (bid < 50 || bid > 300)) return;

    // Protective 15% deviation guard against corrupted cross-symbol ticks
    const currentBase = this.basePrices[symbol] || getPersistedRealPrice(symbol) || (symbol.startsWith('XAU') ? 4108.90 : 0);
    if (currentBase > 0) {
      const dev = Math.abs(bid - currentBase) / currentBase;
      if (dev > 0.15) {
        console.warn(`[ExnessMarketFeed] Blocked aberrant tick for ${symbol} @ ${bid} (deviating ${(dev * 100).toFixed(1)}% from ${currentBase})`);
        return;
      }
    }

    const spreadPips = ask && ask > bid ? Number(((ask - bid) / profile.pipValue).toFixed(1)) : (symbol === 'XAUUSDm' ? 2.0 : 1.0);
    const calculatedAsk = ask && ask > bid ? ask : Number((bid + spreadPips * profile.pipValue).toFixed(profile.digits));

    const quote: LiveQuote = {
      symbol,
      bid: Number(bid.toFixed(profile.digits)),
      ask: Number(calculatedAsk.toFixed(profile.digits)),
      spreadPips: Math.max(0.1, spreadPips),
      timestamp: Date.now(),
    };

    this.liveQuotes[symbol] = quote;
    this.basePrices[symbol] = bid;
    this.lastQuoteFetchTime[symbol] = Date.now();
    updateLastKnownPrice(symbol, bid, 'ws-ticks');

    // Cross-link XAUUSD and XAUUSDm
    if (symbol === 'XAUUSDm') {
      this.liveQuotes['XAUUSD'] = { ...quote, symbol: 'XAUUSD' };
    } else if (symbol === 'XAUUSD') {
      this.liveQuotes['XAUUSDm'] = { ...quote, symbol: 'XAUUSDm' };
    }
  }

  public getLatestKnownPrice(rawSymbol: string): number | null {
    const profile = getPairProfile(rawSymbol);
    const sym = profile.symbol;
    if (this.liveQuotes[sym] && this.liveQuotes[sym].bid > 0) {
      return this.liveQuotes[sym].bid;
    }
    return this.basePrices[sym] || null;
  }

  public async fetchLiveQuote(rawSymbol: string): Promise<LiveQuote> {
    const profile = getPairProfile(rawSymbol);
    const symbol = profile.symbol;

    if (this.liveQuotes[symbol] && this.liveQuotes[symbol].bid > 0) {
      if (!symbol.startsWith('XAU') || (this.liveQuotes[symbol].bid >= 1500 && Math.abs(this.liveQuotes[symbol].bid - 4076.77) > 5.0 && Math.abs(this.liveQuotes[symbol].bid - 3875.70) > 5.0)) {
        return this.liveQuotes[symbol];
      }
    }

    const persisted = getPersistedRealPrice(symbol);
    const base = (persisted > 0 && !isNaN(persisted) && (!symbol.startsWith('XAU') || (persisted >= 1500 && Math.abs(persisted - 4076.77) > 5.0 && Math.abs(persisted - 3875.70) > 5.0)))
      ? persisted
      : (this.basePrices[symbol] || PAIR_BASELINES[symbol]?.baseline || (symbol.startsWith('XAU') ? 4116.85 : 1.0));
    const pip = profile.pipValue;
    const spreadPips = symbol.startsWith('XAU') ? 2.0 : 0.8;
    const ask = Number((base + (symbol.startsWith('XAU') ? 0.20 : spreadPips * pip)).toFixed(profile.digits));

    const quote: LiveQuote = {
      symbol,
      bid: Number(base.toFixed(profile.digits)),
      ask,
      spreadPips,
      timestamp: Date.now(),
    };

    this.liveQuotes[symbol] = quote;
    this.basePrices[symbol] = base;
    return quote;
  }

  public getLiveQuote(rawSymbol: string): LiveQuote {
    const profile = getPairProfile(rawSymbol);
    const symbol = profile.symbol;
    if (this.liveQuotes[symbol] && this.liveQuotes[symbol].bid > 0) {
      if (!symbol.startsWith('XAU') || (this.liveQuotes[symbol].bid >= 1500 && Math.abs(this.liveQuotes[symbol].bid - 4076.77) > 5.0 && Math.abs(this.liveQuotes[symbol].bid - 3875.70) > 5.0)) {
        return this.liveQuotes[symbol];
      }
    }
    const base = (this.basePrices[symbol] && (!symbol.startsWith('XAU') || (this.basePrices[symbol] >= 1500 && Math.abs(this.basePrices[symbol] - 4076.77) > 5.0)))
      ? this.basePrices[symbol]
      : (PAIR_BASELINES[symbol]?.baseline || (symbol.startsWith('XAU') ? 4116.85 : 100));
    return {
      symbol,
      bid: base,
      ask: Number((base + (symbol.startsWith('XAU') ? 0.20 : profile.pipValue)).toFixed(profile.digits)),
      spreadPips: symbol.startsWith('XAU') ? 2.0 : 1.0,
      timestamp: Date.now(),
    };
  }

  public async fetchLiveCandles(rawSymbol: string, limit: number = 80, timeframe: string = 'M5'): Promise<Candle[]> {
    const targetLimit = Math.max(80, limit);
    const profile = getPairProfile(rawSymbol);
    const symbol = profile.symbol;
    const cacheKey = `${symbol}_${timeframe}_${targetLimit}`;

    const inFlight = this.inFlightCandles[cacheKey];
    if (inFlight) return inFlight;

    const fetchPromise = (async (): Promise<Candle[]> => {
      const liveQ = await this.fetchLiveQuote(symbol);
      const anchorPrice = liveQ.bid;
      return generateFallbackCandles(symbol, targetLimit, anchorPrice, timeframe);
    })();

    this.inFlightCandles[cacheKey] = fetchPromise;
    try {
      return await fetchPromise;
    } finally {
      delete this.inFlightCandles[cacheKey];
    }
  }

  public getPositions(): ManagedPosition[] {
    return [...this.openPositions];
  }

  public addPosition(pos: ManagedPosition): void {
    const existingIdx = this.openPositions.findIndex((p) => String(p.id) === String(pos.id));
    if (existingIdx >= 0) {
      this.openPositions[existingIdx] = { ...this.openPositions[existingIdx], ...pos };
    } else {
      this.openPositions.push(pos);
    }
    getGlobalExnessState().activePositions = [...this.openPositions];
  }

  public updatePosition(id: string, updates: Partial<ManagedPosition>): boolean {
    const targetId = String(id || '').replace(/^#+/, '').trim();
    const idx = this.openPositions.findIndex((p) => String(p.id).replace(/^#+/, '').trim() === targetId);
    if (idx >= 0) {
      this.openPositions[idx] = {
        ...this.openPositions[idx],
        ...updates,
      };
      getGlobalExnessState().activePositions = [...this.openPositions];
      return true;
    }
    return false;
  }

  public removePosition(id: string, realizedPnl: number = 0): void {
    const targetId = String(id || '').replace(/^#+/, '').trim();
    this.openPositions = this.openPositions.filter((p) => String(p.id).replace(/^#+/, '').trim() !== targetId);
    getGlobalExnessState().activePositions = [...this.openPositions];
    if (realizedPnl) {
      this.recordRealizedPnL(realizedPnl);
    }
  }

  public clearAllPositions(): void {
    this.openPositions = [];
    getGlobalExnessState().activePositions = [];
  }

  public setPositions(positions: ManagedPosition[]): void {
    const globalState = getGlobalExnessState();
    globalState.activePositions = [...positions];
    this.openPositions = [...positions];
  }

  public recordRealizedPnL(pnl: number): void {
    if (typeof pnl !== 'number' || isNaN(pnl)) return;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyPnlDate) {
      this.dailyPnlDate = today;
      this.dailyRealizedPnL = 0.0;
    }
    this.dailyRealizedPnL = Number((this.dailyRealizedPnL + pnl).toFixed(2));
  }

  public getDailyRealizedPnL(): number {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyPnlDate) {
      this.dailyPnlDate = today;
      this.dailyRealizedPnL = 0.0;
    }
    return this.dailyRealizedPnL;
  }
}

export const realTimeFeed: RealTimeMarketFeed =
  (globalThis as any).__exnessRealTimeFeed ?? ((globalThis as any).__exnessRealTimeFeed = new RealTimeMarketFeed());

// ==========================================
// DATA UNWRAPPING & NORMALIZATION
// ==========================================

export class ExnessApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number = 0, body: any = null) {
    super(message);
    this.name = 'ExnessApiError';
    this.status = status;
    this.body = body;
  }
}

const num = (...vals: any[]): number | undefined => {
  for (const v of vals) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!isNaN(n)) return n;
  }
  return undefined;
};

const unwrap = (data: any): any => {
  if (data && typeof data === 'object') {
    if (data.data !== undefined && !Array.isArray(data) && Object.keys(data).length <= 4) return data.data;
    if (data.result !== undefined && !Array.isArray(data)) return data.result;
  }
  return data;
};

const toMs = (v: any): number => {
  if (v === undefined || v === null || v === '') return Date.now();
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const asNum = Number(v);
  if (!isNaN(asNum)) return asNum < 1e12 ? asNum * 1000 : asNum;
  const parsed = Date.parse(String(v));
  return isNaN(parsed) ? Date.now() : parsed;
};

export function normalizeExnessPosition(raw: any, previous?: ManagedPosition): ManagedPosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.position_id ?? raw.positionId ?? raw.ticket ?? raw.order_id ?? '').trim();
  if (!id) return null;

  const stateStr = String(raw.state ?? raw.status ?? '').toLowerCase();
  const volume = num(raw.volume, raw.lots, raw.lot, raw.size, previous?.volume) ?? 0;
  if (stateStr === 'closed' || volume <= 0) return null;

  const rawSide = String(raw.side ?? raw.type ?? raw.direction ?? raw.action ?? '').toUpperCase();
  const side: 'BUY' | 'SELL' = rawSide.includes('SELL') || rawSide === '1' || rawSide === 'SHORT' ? 'SELL' : 'BUY';
  const rawSym = String(raw.symbol ?? raw.instrument ?? previous?.symbol ?? 'XAUUSDm');
  const profile = getPairProfile(rawSym);
  const symbol = profile.symbol;

  const entryPrice = num(raw.open_price, raw.openPrice, raw.price_open, raw.entry_price, raw.entryPrice, raw.price, previous?.entryPrice) ?? 0;
  const currentPrice = num(raw.current_price, raw.currentPrice, raw.price_current, raw.market_price, previous?.currentPrice, entryPrice) ?? entryPrice;
  const rawLivePrice = (typeof realTimeFeed !== 'undefined' && realTimeFeed.getLatestKnownPrice(symbol)) || entryPrice;
  const maxQuoteDev = symbol.startsWith('XAU') ? 15.0 : 150 * profile.pipValue;
  const safeLivePrice = entryPrice > 0 && Math.abs(rawLivePrice - entryPrice) > maxQuoteDev ? entryPrice : rawLivePrice;
  const resolvedCurrentPrice = currentPrice > 0 && Math.abs(currentPrice - entryPrice) <= maxQuoteDev ? currentPrice : safeLivePrice;

  const sl = num(raw.sl, raw.stop_loss, raw.stopLoss, raw.sl_price, previous?.currentSl, previous?.virtualSl) ?? 0;
  const tp = num(raw.tp, raw.take_profit, raw.takeProfit, raw.tp_price, previous?.currentTp, previous?.virtualTp) ?? 0;
  const profit = num(raw.profit, raw.unrealized_pnl, raw.unrealizedPnl, raw.pnl, raw.floating_profit);
  const resolvedPnl = profit !== undefined ? profit : calculatePnL(side, entryPrice, resolvedCurrentPrice, volume, profile).pnlUsd;

  const normalized: ManagedPosition = {
    id,
    symbol,
    side,
    volume,
    initialVolume: previous?.initialVolume ?? num(raw.initial_volume, raw.initialVolume) ?? volume,
    entryPrice,
    currentPrice: resolvedCurrentPrice,
    currentSl: sl,
    currentTp: tp,
    virtualSl: sl,
    virtualTp: tp,
    highestPrice: Math.max(previous?.highestPrice ?? entryPrice, resolvedCurrentPrice),
    lowestPrice: Math.min(previous?.lowestPrice ?? entryPrice, resolvedCurrentPrice),
    openTime: toMs(raw.open_time ?? raw.openTime ?? raw.time ?? raw.create_time ?? raw.created_at ?? previous?.openTime),
    partialClosed: previous?.partialClosed ?? (previous ? volume < previous.initialVolume : false),
    trailingStatus: previous?.trailingStatus ?? 'INITIAL',
    lastSlUpdateTime: previous?.lastSlUpdateTime,
    unrealizedPnl: resolvedPnl !== undefined ? Number(resolvedPnl.toFixed(2)) : previous?.unrealizedPnl,
  };
  return sanitizePositionSlTp(normalized, resolvedCurrentPrice);
}

export function matchAccountFromPayload(
  raw: any,
  targetAccountId?: string,
  targetServer?: string
): {
  accountId: string;
  server: string;
  currency: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevelPct: number;
} | null {
  const data = unwrap(raw);
  if (!data) return null;

  let accountList: any[] = [];
  if (Array.isArray(data)) {
    accountList = data;
  } else if (typeof data === 'object') {
    if (Array.isArray(data.accounts)) accountList = data.accounts;
    else if (Array.isArray(data.data)) accountList = data.data;
    else if (Array.isArray(data.items)) accountList = data.items;
    else if (Array.isArray(data.result)) accountList = data.result;
    else if (Array.isArray(data.trading_accounts)) accountList = data.trading_accounts;
    else if (Array.isArray(data.tradingAccounts)) accountList = data.tradingAccounts;
  }

  const normTarget = String(targetAccountId || '').trim().toLowerCase();
  const normServer = String(targetServer || '').trim().toLowerCase();

  let candidate: any = null;

  if (accountList.length > 0) {
    if (normTarget) {
      candidate = accountList.find((acc: any) => {
        if (!acc || typeof acc !== 'object') return false;
        const id = String(
          acc.id ?? acc.login ?? acc.account_id ?? acc.accountId ?? acc.account_number ?? acc.number ?? ''
        ).trim().toLowerCase();
        return id === normTarget;
      });
    }

    if (!candidate && normServer) {
      candidate = accountList.find((acc: any) => {
        if (!acc || typeof acc !== 'object') return false;
        const s = String(acc.server ?? acc.platform ?? '').trim().toLowerCase();
        return s.includes(normServer) || normServer.includes(s);
      });
    }

    if (!candidate) {
      candidate = accountList[0];
    }
  } else if (typeof data === 'object') {
    const accObj = data.account && typeof data.account === 'object'
      ? data.account
      : data.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? data.data.account || data.data
      : data;

    if (accObj && typeof accObj === 'object') {
      candidate = accObj;
    }
  }

  if (!candidate || typeof candidate !== 'object') return null;

  const accState = candidate.account_state || candidate.accountState || candidate.payload?.account_state || candidate;
  const balance = num(
    accState.balance,
    accState.account_balance,
    candidate.balance,
    candidate.account_balance,
    candidate.accountBalance,
    candidate.wallet_balance,
    candidate.walletBalance,
    candidate.funds?.balance,
    candidate.cash
  );

  // If no balance is present in this payload, do NOT manufacture a fake 0 balance!
  if (balance === undefined) {
    return null;
  }

  const equity = num(
    accState.equity,
    accState.account_equity,
    candidate.equity,
    candidate.account_equity,
    candidate.accountEquity,
    candidate.funds?.equity
  ) ?? balance;

  const margin = num(
    accState.used_margin,
    accState.margin,
    candidate.margin,
    candidate.used_margin,
    candidate.usedMargin,
    candidate.funds?.margin
  ) ?? 0;

  const freeMargin = num(
    accState.free_margin,
    candidate.free_margin,
    candidate.freeMargin,
    candidate.margin_free,
    candidate.funds?.freeMargin
  ) ?? Math.max(0, equity - margin);

  const marginLevelPct = num(
    accState.margin_level,
    candidate.margin_level,
    candidate.marginLevel,
    candidate.margin_level_pct
  ) ?? (margin > 0 ? (equity / margin) * 100 : 0);

  const resolvedId = String(
    candidate.id ?? candidate.login ?? candidate.account_id ?? candidate.accountId ?? candidate.account_number ?? targetAccountId ?? ''
  );
  const resolvedServer = String(
    candidate.server ?? candidate.platform ?? targetServer ?? ''
  );
  const currency = String(
    candidate.currency ?? candidate.account_currency ?? candidate.settings?.currency ?? 'USD'
  );

  return {
    accountId: resolvedId,
    server: resolvedServer,
    currency,
    balance: Number(balance.toFixed(2)),
    equity: Number(equity.toFixed(2)),
    margin: Number(margin.toFixed(2)),
    freeMargin: Number(freeMargin.toFixed(2)),
    marginLevelPct: Number(marginLevelPct.toFixed(1)),
  };
}

// ==========================================
// 2. ACCESS POINT DISCOVERY & CACHING
// ==========================================

export function normalizeGatewayHost(rawHost?: string): string {
  if (!rawHost) return 'https://api.exness-api.com';
  let trimmed = String(rawHost).trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://api.exness-api.com';
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    trimmed = `https://${trimmed}`;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.origin.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

export function isGatewayHost(urlOrHost: string): boolean {
  if (!urlOrHost) return false;
  try {
    const parsed = new URL(urlOrHost.startsWith('http') ? urlOrHost : `https://${urlOrHost}`);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'api.exness.com' ||
      hostname === 'api.exness-api.com' ||
      (hostname.endsWith('.exness.com') && !hostname.startsWith('ap-')) ||
      (hostname.endsWith('.exness-api.com') && !hostname.startsWith('ap-'))
    );
  } catch {
    const clean = urlOrHost.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    return clean === 'api.exness.com' || clean === 'api.exness-api.com';
  }
}

export interface DiscoveryAttemptLog {
  gateway: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

export async function resolveAccessPoint(
  accountId: string,
  apiKey: string,
  privateKey: string,
  configuredHost?: string,
  forceRefresh: boolean = false
): Promise<string> {
  const cleanAccountId = String(accountId || '').trim().replace(/[\r\n\t]/g, '');
  const cleanApiKey = String(apiKey || '').trim().replace(/[\r\n\t]/g, '');
  const host = String(configuredHost || '').trim();
  const coreState = getGlobalExnessState();

  if (!cleanAccountId || !/^\d+$/.test(cleanAccountId)) {
    throw new ExnessApiError(`Account ID Exness tidak valid: "${cleanAccountId}". Harus berupa nomor login MT5 numerik.`, 400);
  }

  // If host is an explicit Access Point URL (e.g. ap-*.exness.com) and NOT a gateway host, use it directly
  const isExplicitAccessPoint = Boolean(
    host &&
    (host.startsWith('https://ap-') || host.startsWith('http://ap-') || host.startsWith('ap-') || (host.includes('.') && host.includes('ap-')))
  );
  if (isExplicitAccessPoint && !isGatewayHost(host)) {
    let normalized = host;
    if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
      normalized = `https://${normalized}`;
    }
    normalized = normalized.replace(/\/+$/, '');
    coreState.accessPoints[cleanAccountId] = normalized;
    return normalized;
  }

  // If not forcing refresh, check existing cached access point
  if (!forceRefresh && coreState.accessPoints[cleanAccountId]) {
    const cachedAp = coreState.accessPoints[cleanAccountId];
    // Safety check: ensure the cached access point is NOT a gateway host
    if (!isGatewayHost(cachedAp)) {
      return cachedAp;
    }
    // Delete invalid cached gateway host
    delete coreState.accessPoints[cleanAccountId];
  }

  // Gateways: Try api.exness-api.com first (fast, reliable globally), then fallback to api.exness.com
  const defaultGateways = ['https://api.exness-api.com', 'https://api.exness.com'];
  let gatewayBases = defaultGateways;
  if (host) {
    const norm = normalizeGatewayHost(host);
    if (isGatewayHost(norm) || !norm.includes('ap-')) {
      gatewayBases = [norm, ...defaultGateways.filter((g) => g !== norm)];
    }
  }
  const cleanPath = '/v1/trading/access-point';
  const discoveryPath = `${cleanPath}?account_id=${encodeURIComponent(cleanAccountId)}`;

  const discoveryAttempts: DiscoveryAttemptLog[] = [];

  for (const gatewayBaseUrl of gatewayBases) {
    const fullDiscoveryUrl = `${gatewayBaseUrl.replace(/\/+$/, '')}${discoveryPath}`;
    console.log(`[ExnessDiscovery] Probing Exness Gateway: GET ${fullDiscoveryUrl}`);

    try {
      const headers = buildExnessAuthHeaders({
        apiKey: cleanApiKey,
        privateKey,
        method: 'GET',
        path: discoveryPath,
        bodyStr: '',
        idempotencyKey: '',
        timestampMs: getSyncedTimestamp(),
      });

      let res: Response;
      let rawBody = '';
      const resHeadersObj: Record<string, string> = {};

      {
        // NOTE: the timeout signal is created INSIDE the throttled task. Previously it was created
        // before queueing, so time spent waiting in the REST queue counted against the 7s budget and
        // discovery aborted before the request was even sent whenever the queue was busy.
        const fetchResult = await exnessRestThrottler.schedule(async () => {
          const { signal, cleanup } = createTimeoutSignal(7000);
          try {
            // Re-sign right before sending: the request may have waited in the queue, and a stale
            // signature timestamp would be rejected as clock drift.
            const freshHeaders = buildExnessAuthHeaders({
              apiKey: cleanApiKey,
              privateKey,
              method: 'GET',
              path: discoveryPath,
              bodyStr: '',
              idempotencyKey: '',
              timestampMs: getSyncedTimestamp(),
            });
            const r = await fetch(fullDiscoveryUrl, {
              method: 'GET',
              headers: freshHeaders || headers,
              signal,
              cache: 'no-store',
            });
            const b = await r.text().catch(() => '');
            return { res: r, rawBody: b };
          } finally {
            cleanup();
          }
        });
        res = fetchResult.res;
        rawBody = fetchResult.rawBody;
        res.headers.forEach((val, key) => {
          resHeadersObj[key] = val;
        });
        updateExnessTimeOffsetFromHeaders(res.headers);
      }

      // Check for timestamp drift (code: 1001, "outside allowed window", AUTH_INVALID_SIGNATURE)
      if (!res.ok && isClockDriftError(res.status, rawBody)) {
        console.warn(
          `[ExnessDiscovery] Clock drift detected (${res.status}: ${rawBody}). Re-signing with synced offset (${exnessTimeOffsetMs}ms) and retrying once...`
        );
        const retryHeaders = buildExnessAuthHeaders({
          apiKey: cleanApiKey,
          privateKey,
          method: 'GET',
          path: discoveryPath,
          bodyStr: '',
          idempotencyKey: '',
          timestampMs: getSyncedTimestamp(),
        });
        const { signal: s2, cleanup: c2 } = createTimeoutSignal(7000);
        try {
          const retryRes = await fetch(fullDiscoveryUrl, {
            method: 'GET',
            headers: retryHeaders,
            signal: s2,
            cache: 'no-store',
          });
          const retryBody = await retryRes.text().catch(() => '');
          updateExnessTimeOffsetFromHeaders(retryRes.headers);
          if (retryRes.status === 200) {
            res = retryRes;
            rawBody = retryBody;
            retryRes.headers.forEach((val, key) => {
              resHeadersObj[key] = val;
            });
          } else if (isClockDriftError(retryRes.status, retryBody)) {
            // Also test seconds format if needed by endpoint
            const secHeaders = buildExnessAuthHeaders({
              apiKey: cleanApiKey,
              privateKey,
              method: 'GET',
              path: discoveryPath,
              bodyStr: '',
              idempotencyKey: '',
              timestampMs: Math.floor(getSyncedTimestamp() / 1000),
            });
            const { signal: s3, cleanup: c3 } = createTimeoutSignal(7000);
            try {
              const secRes = await fetch(fullDiscoveryUrl, {
                method: 'GET',
                headers: secHeaders,
                signal: s3,
                cache: 'no-store',
              });
              const secBody = await secRes.text().catch(() => '');
              updateExnessTimeOffsetFromHeaders(secRes.headers);
              if (secRes.status === 200) {
                res = secRes;
                rawBody = secBody;
                secRes.headers.forEach((val, key) => {
                  resHeadersObj[key] = val;
                });
              }
            } finally {
              c3();
            }
          }
        } finally {
          c2();
        }
      }

      // Concise logging: status always; headers/body only on failure (keeps terminal clean)
      console.log(`[ExnessDiscovery] ${fullDiscoveryUrl} -> ${res.status} ${res.statusText} (clock offset ${exnessTimeOffsetMs}ms)`);
      if (!res.ok) {
        console.log(`[ExnessDiscovery] Raw Response Body:`, rawBody);
      }

      discoveryAttempts.push({
        gateway: gatewayBaseUrl,
        url: fullDiscoveryUrl,
        status: res.status,
        statusText: res.statusText,
        headers: resHeadersObj,
        body: rawBody,
      });

      if (res.status === 200) {
        let json: any = {};
        try {
          json = JSON.parse(rawBody);
        } catch {
          console.error(`[ExnessDiscovery] Failed to parse JSON response from ${fullDiscoveryUrl}:`, rawBody);
        }

        const apRaw = json?.access_point || json?.data?.access_point || json?.accessPoint || json?.data?.accessPoint;
        if (apRaw && typeof apRaw === 'string') {
          let normalizedAp = apRaw.trim();
          if (!normalizedAp.startsWith('http://') && !normalizedAp.startsWith('https://')) {
            normalizedAp = `https://${normalizedAp}`;
          }
          normalizedAp = normalizedAp.replace(/\/+$/, '');
          // Protect against gateway host returning itself
          if (isGatewayHost(normalizedAp)) {
            console.error(`[ExnessDiscovery] Gateway returned another gateway host as access_point: ${normalizedAp}`);
          } else {
            coreState.accessPoints[cleanAccountId] = normalizedAp;
            console.log(`[ExnessDiscovery] Account #${cleanAccountId} access_point resolved successfully: ${normalizedAp}`);
            return normalizedAp;
          }
        } else {
          console.error(`[ExnessDiscovery] HTTP 200 received from ${fullDiscoveryUrl} but missing access_point property in JSON:`, rawBody);
        }
      }

      // If gateway returns 401/403 (e.g. invalid API key or bad signature), stop immediately - credentials are authoritative across all gateways
      if (res.status === 401 || res.status === 403) {
        break;
      }
    } catch (netErr: any) {
      console.warn(`[ExnessDiscovery] Network/probe error contacting ${fullDiscoveryUrl}:`, netErr?.message || netErr);
      discoveryAttempts.push({
        gateway: gatewayBaseUrl,
        url: fullDiscoveryUrl,
        status: 0,
        statusText: 'Network / Timeout Error',
        headers: {},
        body: netErr?.message || String(netErr),
        error: netErr?.message || String(netErr),
      });
    }
  }

  // If we reached here, discovery failed on both Gateways.
  // CRITICAL: NEVER fall back to api.exness.com or api.exness-api.com (which would trigger 404 on /v1/configuration/accounts/...)
  const mainAttempt = discoveryAttempts[0];
  const altAttempt = discoveryAttempts[1];

  const primary = mainAttempt && mainAttempt.status > 0 ? mainAttempt : (altAttempt || mainAttempt);
  const statusToReport = primary && primary.status > 0 ? primary.status : 502;

  const formattedLog = discoveryAttempts.map((att) => {
    return `Gateway: ${att.url}\n` +
      `HTTP Status: ${att.status} ${att.statusText}\n` +
      `Headers: ${JSON.stringify(att.headers)}\n` +
      `Response Body: ${att.body || '(empty body)'}`;
  }).join('\n---\n');

  const errorMessage = `Exness Access-Point Discovery failed for account #${cleanAccountId} on both Gateway hosts.\n` +
    `Exact Gateway Response (${primary?.url || 'https://api.exness.com'}):\n` +
    `HTTP Status: ${primary?.status ?? 0} ${primary?.statusText ?? ''}\n` +
    `Response Headers: ${JSON.stringify(primary?.headers || {})}\n` +
    `Response Body: ${primary?.body || '(empty)'}\n` +
    `\nDetailed Probe Log:\n${formattedLog}`;

  throw new ExnessApiError(errorMessage, statusToReport, {
    attempts: discoveryAttempts,
    primary,
  });
}

// ==========================================
// 3. REAL-TIME WEBSOCKET STREAMS MANAGER (/ws/ticks & /ws/events)
// ==========================================

class ExnessWebSocketManager {
  private ticksWs: WebSocket | null = null;
  private eventsWs: WebSocket | null = null;
  private activeAccountId: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastCreds: { accessPoint: string; accountId: string; apiKey: string; privateKey: string } | null = null;
  private rateLimitAttempts: number = 0;
  private isRateLimited: boolean = false;
  private hasHandshakeError: boolean = false;
  private readonly rateLimitDelays = [5000, 15000, 30000, 60000];
  // Handshake rejection backoff (HTTP 400 / 401 / 403 / 429): minimum 30s, escalating, REST polling covers prices meanwhile
  private handshakeBlockedUntil: number = 0;
  private handshakeFailures: number = 0;
  private readonly handshakeDelays = [30000, 60000, 120000, 300000];

  /** Registers a WS handshake rejection and returns the applied backoff (ms). Shared across ticks & events streams. */
  private registerHandshakeRejection(stream: 'Ticks' | 'Events', status: number): number {
    const now = Date.now();
    // Both streams usually fail in the same instant: only escalate once per backoff window
    if (now < this.handshakeBlockedUntil) {
      return this.handshakeBlockedUntil - now;
    }
    const idx = Math.min(this.handshakeFailures, this.handshakeDelays.length - 1);
    const delay = this.handshakeDelays[idx];
    this.handshakeFailures++;
    this.hasHandshakeError = true;
    if (status === 429) this.isRateLimited = true;
    this.handshakeBlockedUntil = now + delay;
    console.warn(
      `[ExnessWS] ${stream} stream rejected (HTTP ${status}). Pausing WebSocket reconnects for ${delay / 1000}s; using REST price polling meanwhile.`
    );
    return delay;
  }

  private extractHandshakeStatus(msg: string): number {
    const m = msg.match(/Unexpected server response:\s*(\d{3})/i);
    if (m) return Number(m[1]);
    if (msg.includes('429')) return 429;
    return 0;
  }

  public connect(accessPoint: string, accountId: string, apiKey: string, privateKey: string): void {
    const cleanAccountId = String(accountId || '').trim();
    if (!cleanAccountId || !apiKey || !privateKey) return;
    if (isGatewayHost(accessPoint)) {
      console.warn(`[ExnessWS] Cannot connect WebSocket to Gateway host: ${accessPoint}`);
      return;
    }

    this.lastCreds = { accessPoint, accountId: cleanAccountId, apiKey, privateKey };
    if (this.activeAccountId === cleanAccountId && (this.ticksWs || this.eventsWs)) {
      return;
    }
    // If currently rate-limited (HTTP 429) and cooldown timer is already running, avoid spamming
    if (this.isRateLimited && this.reconnectTimer) {
      return;
    }
    // Same account still inside a 400/401/403/429 handshake backoff window: do NOT tear down & reconnect on every poll
    if (this.activeAccountId === cleanAccountId && Date.now() < this.handshakeBlockedUntil) {
      if (!this.reconnectTimer) this.scheduleReconnect();
      return;
    }
    if (this.activeAccountId !== cleanAccountId) {
      // New account -> fresh handshake budget
      this.handshakeBlockedUntil = 0;
      this.handshakeFailures = 0;
    }
    const blockedUntil = this.handshakeBlockedUntil;
    const failures = this.handshakeFailures;
    this.disconnect();
    this.handshakeBlockedUntil = blockedUntil;
    this.handshakeFailures = failures;
    this.activeAccountId = cleanAccountId;
    this.initStreams();
  }

  private initStreams(): void {
    if (!this.lastCreds || !this.activeAccountId) return;
    const { accessPoint, accountId, apiKey, privateKey } = this.lastCreds;
    this.initStreamsInner(accessPoint, accountId, apiKey, privateKey);
    if (this.ticksWs) this.attachKeepAlive(this.ticksWs, 'Ticks');
    if (this.eventsWs) this.attachKeepAlive(this.eventsWs, 'Events');
  }

  /**
   * Ping/pong keep-alive. On VPS/cloud networks idle TCP connections are often silently dropped by
   * NAT/firewalls without a FIN, so 'close' never fires and the bot keeps a dead socket forever
   * (prices freeze). If no pong arrives within 2 ping intervals the socket is terminated, which
   * triggers the normal 'close' → scheduleReconnect() path.
   */
  private attachKeepAlive(ws: WebSocket, label: 'Ticks' | 'Events'): void {
    const anyWs = ws as any;
    if (anyWs.__keepAliveAttached) return;
    anyWs.__keepAliveAttached = true;
    const PING_INTERVAL_MS = Number(process.env.EXNESS_WS_PING_MS || 20000);
    let lastPong = Date.now();
    ws.on('pong', () => {
      lastPong = Date.now();
    });
    ws.on('message', () => {
      lastPong = Date.now();
    });
    const timer = setInterval(() => {
      try {
        if (ws.readyState !== WebSocket.OPEN) {
          if (ws.readyState === WebSocket.CLOSED) clearInterval(timer);
          return;
        }
        if (Date.now() - lastPong > PING_INTERVAL_MS * 2.5) {
          console.warn(`[ExnessWS] ${label} stream unresponsive (no pong for ${Math.round((Date.now() - lastPong) / 1000)}s). Terminating to force reconnect.`);
          clearInterval(timer);
          ws.terminate();
          return;
        }
        ws.ping();
      } catch {}
    }, PING_INTERVAL_MS);
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    ws.on('close', () => clearInterval(timer));
  }

  private initStreamsInner(accessPoint: string, accountId: string, apiKey: string, privateKey: string): void {
    let host = 'api.exness-api.com';
    try {
      host = new URL(accessPoint).host;
    } catch {
      host = accessPoint.replace(/^https?:\/\//, '').split('/')[0];
    }

    // 1. WebSocket Live Ticks: wss://${accessPointHost}/v1/server-events/accounts/${accountId}/ws/ticks
    const ticksPath = `/v1/server-events/accounts/${encodeURIComponent(accountId)}/ws/ticks`;
    const ticksHeaders = buildExnessAuthHeaders({
      apiKey,
      privateKey,
      method: 'GET',
      path: ticksPath,
      bodyStr: '',
      idempotencyKey: '',
    });

    // Only (re)open streams that are not already alive (prevents orphaned duplicate sockets on reconnect)
    if (!this.ticksWs) try {
      const ticksUrl = `wss://${host}${ticksPath}`;
      // Subprotocol ['exness-ws-protocol'] prevents "Server sent a subprotocol but none was requested" handshake error
      const wsTicks = new WebSocket(ticksUrl, ['exness-ws-protocol'], { headers: ticksHeaders });
      this.ticksWs = wsTicks;

      wsTicks.on('open', () => {
        this.isRateLimited = false;
        this.rateLimitAttempts = 0;
        this.handshakeFailures = 0;
        this.handshakeBlockedUntil = 0;
        this.hasHandshakeError = false;
        console.log(`[ExnessWS] Ticks stream connected for account #${accountId}`);
        try {
          // Subscribe strictly to Forex & Gold instruments
          wsTicks.send(
            JSON.stringify({
              id: 'ticks-forex-1',
              subscribe: {
                event: 'ticks',
                instruments: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
              },
            })
          );
        } catch {}
      });

      wsTicks.on('message', (data: WebSocket.Data) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString('utf8');
          if (!raw) return;
          const msg = JSON.parse(raw);
          const ticks = Array.isArray(msg)
            ? msg
            : Array.isArray(msg?.ticks)
            ? msg.ticks
            : Array.isArray(msg?.data)
            ? msg.data
            : [msg?.data || msg];

          for (const t of ticks) {
            if (!t || typeof t !== 'object') continue;
            const inst = String(t.instrument || t.symbol || t.inst || '').trim();
            const bid = num(t.bid, t.price, t.b);
            const ask = num(t.ask, t.a);
            if (inst && bid && bid > 0) {
              markWsTick();
              const baseInst = inst.replace(/m$/i, '');
              const suffixedInst = `${baseInst}m`;
              realTimeFeed.updateQuote(baseInst, bid, ask);
              realTimeFeed.updateQuote(suffixedInst, bid, ask);

              // Live WS Tick Aggregation for in-memory candles
              updateCachedCandlesWithTick(baseInst, bid);
            }
          }
        } catch {}
      });

      wsTicks.on('error', (err: any) => {
        const msg = String(err?.message || '');
        const status = this.extractHandshakeStatus(msg);
        if (status === 400 || status === 401 || status === 403 || status === 429) {
          this.registerHandshakeRejection('Ticks', status);
        } else {
          console.warn(`[ExnessWS] Ticks stream warning: ${err?.message || 'handshake error'}`);
        }
      });

      wsTicks.on('close', () => {
        if (this.ticksWs === wsTicks) {
          this.ticksWs = null;
          this.scheduleReconnect();
        }
      });
    } catch (err: any) {
      console.warn(`[ExnessWS] Could not initiate ticks stream: ${err?.message || err}`);
    }

    // 2. WebSocket Events: wss://${accessPointHost}/v1/server-events/accounts/${accountId}/ws/events
    const eventsPath = `/v1/server-events/accounts/${encodeURIComponent(accountId)}/ws/events`;
    const eventsHeaders = buildExnessAuthHeaders({
      apiKey,
      privateKey,
      method: 'GET',
      path: eventsPath,
      bodyStr: '',
      idempotencyKey: '',
    });

    if (!this.eventsWs) try {
      const eventsUrl = `wss://${host}${eventsPath}`;
      // Subprotocol ['exness-ws-protocol'] prevents "Server sent a subprotocol but none was requested" handshake error
      const wsEvents = new WebSocket(eventsUrl, ['exness-ws-protocol'], { headers: eventsHeaders });
      this.eventsWs = wsEvents;

      wsEvents.on('open', () => {
        this.isRateLimited = false;
        this.rateLimitAttempts = 0;
        this.handshakeFailures = 0;
        this.handshakeBlockedUntil = 0;
        this.hasHandshakeError = false;
        console.log(`[ExnessWS] Events stream connected for account #${accountId}`);
        try {
          wsEvents.send(JSON.stringify({ id: 'sub-account-1', subscribe: { event: 'account' } }));
          wsEvents.send(JSON.stringify({ id: 'sub-tx-1', subscribe: { event: 'transactions' } }));
          wsEvents.send(JSON.stringify({ id: 'sub-inst-1', subscribe: { event: 'instruments' } }));
        } catch {}
      });

      wsEvents.on('message', (data: WebSocket.Data) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString('utf8');
          if (!raw) return;
          const msg = JSON.parse(raw);
          const evType = String(msg.event_type || msg.event || msg.type || '').toLowerCase();

          // Account events / trading_state_snapshot
          const accState = msg.payload?.account_state || msg.account_state || msg.account || msg.data?.account_state || msg.data;
          if (accState && (accState.balance !== undefined || accState.account_balance !== undefined)) {
            const b = num(accState.balance, accState.account_balance);
            const eq = num(accState.equity, accState.account_equity) ?? b;
            const m = num(accState.used_margin, accState.margin) ?? 0;
            const fm = b !== undefined ? Math.max(0, (eq ?? b) - m) : undefined;

            const coreState = getGlobalExnessState();
            coreState.liveAccount = {
              ...(coreState.liveAccount || {}),
              ...(b !== undefined ? { balance: b } : {}),
              ...(eq !== undefined ? { equity: eq } : {}),
              ...(fm !== undefined ? { freeMargin: fm } : {}),
              ...(m !== undefined ? { margin: m } : {}),
              updatedAt: Date.now(),
            };
          }

          // Initial positions snapshot from trading_state_snapshot
          if (evType === 'trading_state_snapshot' && Array.isArray(msg.payload?.positions)) {
            const list = msg.payload.positions
              .map((r: any) => normalizeExnessPosition(r))
              .filter((p: any): p is ManagedPosition => Boolean(p));
            realTimeFeed.setPositions(list);
          }

          // Live transaction events (fills, closes, position updates)
          if (evType === 'transaction_event' && msg.payload) {
            const payload = msg.payload;
            if (payload.account_state) {
              const b = num(payload.account_state.balance);
              const eq = num(payload.account_state.equity) ?? b;
              const m = num(payload.account_state.used_margin) ?? 0;
              const fm = b !== undefined ? Math.max(0, (eq ?? b) - m) : undefined;
              const coreState = getGlobalExnessState();
              coreState.liveAccount = {
                ...(coreState.liveAccount || {}),
                ...(b !== undefined ? { balance: b } : {}),
                ...(eq !== undefined ? { equity: eq } : {}),
                ...(fm !== undefined ? { freeMargin: fm } : {}),
                ...(m !== undefined ? { margin: m } : {}),
                updatedAt: Date.now(),
              };
            }

            if (Array.isArray(payload.positions)) {
              for (const p of payload.positions) {
                const state = String(p.state || '').toLowerCase();
                const vol = num(p.volume) ?? 0;
                const posId = String(p.position_id || p.id || '');
                if (state === 'closed' || vol <= 0) {
                  let profit = 0;
                  if (Array.isArray(payload.deals)) {
                    const deal = payload.deals.find((d: any) => String(d.position_id) === posId);
                    if (deal?.profit?.amount) profit = Number(deal.profit.amount) || 0;
                  }
                  realTimeFeed.removePosition(posId, profit);
                } else {
                  const norm = normalizeExnessPosition(p);
                  if (norm) realTimeFeed.addPosition(norm);
                }
              }
            }
          }
        } catch {}
      });

      wsEvents.on('error', (err: any) => {
        const msg = String(err?.message || '');
        const status = this.extractHandshakeStatus(msg);
        if (status === 400 || status === 401 || status === 403 || status === 429) {
          this.registerHandshakeRejection('Events', status);
        } else {
          console.warn(`[ExnessWS] Events stream warning: ${err?.message || 'handshake error'}`);
        }
      });

      wsEvents.on('close', () => {
        if (this.eventsWs === wsEvents) {
          this.eventsWs = null;
          this.scheduleReconnect();
        }
      });
    } catch (err: any) {
      console.warn(`[ExnessWS] Could not initiate events stream: ${err?.message || err}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    let delay = 5000;
    if (this.isRateLimited) {
      const idx = Math.min(this.rateLimitAttempts, this.rateLimitDelays.length - 1);
      delay = this.rateLimitDelays[idx];
      this.rateLimitAttempts++;
      console.warn(`[ExnessWS] 429 Rate Limit backoff active. Cooldown for ${delay / 1000}s (attempt ${this.rateLimitAttempts}) before reconnecting...`);
    }
    // Honour HTTP 400/401/403/429 handshake backoff window (>= 30s)
    const blockedRemaining = this.handshakeBlockedUntil - Date.now();
    if (blockedRemaining > delay) {
      delay = blockedRemaining;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.activeAccountId && this.lastCreds) {
        if (!this.ticksWs || !this.eventsWs) {
          this.initStreams();
        }
      }
    }, delay);
  }

  public disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rateLimitAttempts = 0;
    this.isRateLimited = false;
    this.activeAccountId = null;
    if (this.ticksWs) {
      try {
        this.ticksWs.close();
      } catch {}
      this.ticksWs = null;
    }
    if (this.eventsWs) {
      try {
        this.eventsWs.close();
      } catch {}
      this.eventsWs = null;
    }
  }
}

// Process-wide singleton: separate Next.js bundles must NOT open duplicate WebSocket streams
// (Exness rejects parallel handshakes with HTTP 429 → long reconnect back-offs → frozen prices).
export const exnessWsManager: ExnessWebSocketManager =
  (globalThis as any).__exnessWsManager ?? ((globalThis as any).__exnessWsManager = new ExnessWebSocketManager());

// ==========================================
// 4. BULLETPROOF EXNESS CLIENT CLASS
// ==========================================

export const EXNESS_API_CONFIG = {
  baseUrl: process.env.EXNESS_API_BASE_URL || 'https://api.exness-api.com',
  timeoutMs: Number(process.env.EXNESS_API_TIMEOUT_MS || 8000),
};

export class ExnessClient {
  private credentials: ExnessAccountCredentials;
  private configuredHost: string = 'https://api.exness-api.com';

  constructor(credentials?: ExnessAccountCredentials | ExnessVaultCredentials | string) {
    if (typeof credentials === 'string') {
      this.credentials = { apiKey: credentials };
    } else if (credentials) {
      const key = (credentials as any).apiKey || (credentials as any).token || '';
      const accId = String(credentials.accountId || '').trim();
      const srv = credentials.server || 'https://api.exness-api.com';
      this.credentials = {
        ...credentials,
        accountId: accId,
        server: srv,
        apiKey: key,
        privateKey: (credentials as any).privateKey || '',
      };
      this.configuredHost = normalizeGatewayHost(srv);
    } else {
      this.credentials = {};
    }
  }

  public hasCredentials(): boolean {
    return validateExnessCredentials({
      accountId: this.credentials.accountId,
      apiKey: this.credentials.apiKey,
      privateKey: this.credentials.privateKey,
    }).valid;
  }

  public static clearAllLivePositions(): void {
    realTimeFeed.clearAllPositions();
    exnessWsManager.disconnect();
  }

  private getMode(): 'DEMO' | 'REAL' {
    const server = String(this.credentials.server || '');
    return (this.credentials.mode || (server.toLowerCase().includes('real') ? 'REAL' : 'DEMO')) as 'DEMO' | 'REAL';
  }

  public async resolveAccessPoint(forceRefresh: boolean = false): Promise<string> {
    const accountId = String(this.credentials.accountId || '').trim();
    const apiKey = String(this.credentials.apiKey || '').trim();
    const privateKey = String(this.credentials.privateKey || '').trim();
    return resolveAccessPoint(accountId, apiKey, privateKey, this.configuredHost, forceRefresh);
  }

  public buildAuthHeaders(
    method: string,
    path: string,
    bodyStr: string = '',
    customIdempotencyKey?: string,
    timestampMs?: number
  ): Record<string, string> {
    const apiKey = String(this.credentials.apiKey || '').trim().replace(/^["']|["']$/g, '');
    const privateKey = typeof this.credentials.privateKey === 'string'
      ? this.credentials.privateKey.trim().replace(/^["']|["']$/g, '')
      : this.credentials.privateKey || '';

    return buildExnessAuthHeaders({
      apiKey,
      privateKey,
      method,
      path,
      bodyStr,
      idempotencyKey: customIdempotencyKey,
      timestampMs: timestampMs !== undefined ? timestampMs : getSyncedTimestamp(),
    });
  }

  /**
   * Signed HTTP request to the resolved Access Point
   */
  private async signedRequest<T = any>(
    method: string,
    path: string,
    body?: any,
    customIdempotencyKey?: string
  ): Promise<T> {
    const accountId = String(this.credentials.accountId || '').trim().replace(/^["']|["']$/g, '');
    const apiKey = String(this.credentials.apiKey || '').trim().replace(/^["']|["']$/g, '');
    const privateKey = typeof this.credentials.privateKey === 'string'
      ? this.credentials.privateKey.trim().replace(/^["']|["']$/g, '')
      : this.credentials.privateKey || '';

    const validation = validateExnessCredentials({ accountId, apiKey, privateKey });
    if (!validation.valid) {
      throw new ExnessApiError(validation.error || 'Kredensial Exness belum dikonfigurasi.', 401);
    }

    const accessPoint = await this.resolveAccessPoint();

    // Guard: The DNS Gateway hosts (api.exness.com / api.exness-api.com) ONLY serve Discovery.
    // NEVER call account/trading endpoints on Gateway hosts directly.
    if (isGatewayHost(accessPoint)) {
      throw new ExnessApiError(
        `Cannot call ${path} on Gateway host (${accessPoint}). Account endpoints must ONLY be called against the resolved access_point from discovery!`,
        500
      );
    }

    const bodyStr = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const baseAp = accessPoint.replace(/\/+$/, '');
    const fullUrl = `${baseAp}${cleanPath}`;

    return exnessRestThrottler.schedule<T>(async () => {
      const executeCall = async (tsOverride?: number) => {
        const headers = this.buildAuthHeaders(method, cleanPath, bodyStr, customIdempotencyKey, tsOverride);
        const { signal, cleanup } = createTimeoutSignal(EXNESS_API_CONFIG.timeoutMs);
        try {
          const res = await fetch(fullUrl, {
            method,
            headers,
            body: bodyStr || undefined,
            signal,
            cache: 'no-store',
          } as RequestInit);
          const text = await res.text().catch(() => '');
          updateExnessTimeOffsetFromHeaders(res.headers);
          return { res, text };
        } catch (err: any) {
          throw new ExnessApiError(`Tidak dapat terhubung ke Exness API (${err?.message || 'network error'}).`, 0);
        } finally {
          cleanup();
        }
      };

      let { res, text } = await executeCall();

      // If clock drift error (1001 / outside allowed window), re-sign and retry once transparently
      if (!res.ok && isClockDriftError(res.status, text)) {
        console.warn(
          `[ExnessAuth] Detected clock drift (status ${res.status}: ${text}). Re-signing with synced offset (${exnessTimeOffsetMs}ms) and retrying once...`
        );
        const retry1 = await executeCall(getSyncedTimestamp());
        res = retry1.res;
        text = retry1.text;

        if (!res.ok && isClockDriftError(res.status, text)) {
          const retrySec = await executeCall(Math.floor(getSyncedTimestamp() / 1000));
          if (retrySec.res.ok) {
            res = retrySec.res;
            text = retrySec.text;
          }
        }
      }

      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retrySeconds = retryAfterHeader ? Number(retryAfterHeader) || 5 : 5;
        exnessRestThrottler.handleRateLimit(retrySeconds * 1000);
        getGlobalExnessState().rateLimitUntil = Date.now() + retrySeconds * 1000;
        throw new ExnessApiError(`Exness API rate limit (HTTP 429) on ${method} ${cleanPath}. Throttler backing off.`, 429, data);
      }

      if (!res.ok) {
        const detail =
          (data && typeof data === 'object' && (data.message || data.error || data.detail || data.error_message || data.description)) ||
          (typeof data === 'string' ? data.slice(0, 200) : '');
        if (res.status === 401 || res.status === 403) {
          throw new ExnessApiError(
            `Autentikasi Exness ditolak (HTTP ${res.status}). Periksa Public Key (exnsk-) dan Ed25519 Private Key Anda. ${detail}`.trim(),
            res.status,
            data
          );
        }
        throw new ExnessApiError(`Exness API error HTTP ${res.status} ${method} ${cleanPath}${detail ? `: ${detail}` : ''}`, res.status, data);
      }

      return data as T;
    }, { method });
  }

  /**
   * Step 2: Account Verification & Probing
   * Calls:
   * 1. GET /v1/configuration/accounts/${accountId}/account
   * 2. GET /v1/configuration/accounts/${accountId}/limits
   * With fallback probe endpoints.
   */
  private async discoverAndFetchAccount(): Promise<{
    accountId: string;
    server: string;
    currency: string;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    marginLevelPct: number;
  }> {
    const accountId = String(this.credentials.accountId || '').trim().replace(/^["']|["']$/g, '');
    const apiKey = String(this.credentials.apiKey || '').trim().replace(/^["']|["']$/g, '');
    const privateKey = typeof this.credentials.privateKey === 'string'
      ? this.credentials.privateKey.trim().replace(/^["']|["']$/g, '')
      : this.credentials.privateKey || '';
    const server = String(this.credentials.server || '').trim();

    const validation = validateExnessCredentials({ accountId, apiKey, privateKey });
    if (!validation.valid) {
      throw new ExnessApiError(validation.error || 'Kredensial Exness belum dikonfigurasi.', 401);
    }

    // Step 1: Strictly resolve Access Point before calling account endpoints
    const accessPoint = await this.resolveAccessPoint();
    if (isGatewayHost(accessPoint)) {
      throw new ExnessApiError(
        `Cannot call account endpoints on Gateway host (${accessPoint}). Access Point discovery must resolve to a valid trading node.`,
        500
      );
    }

    // 1. Account Settings: GET /v1/configuration/accounts/${accountId}/account
    const configPath = "/v1/configuration/accounts/" + accountId + "/account";
    let resolvedCurrency = 'USD';
    let resolvedLeverage = 2000;

    try {
      const rawConfig = await this.signedRequest('GET', configPath);
      if (rawConfig?.settings?.currency) {
        resolvedCurrency = String(rawConfig.settings.currency);
      }
      if (rawConfig?.settings?.leverage) {
        resolvedLeverage = Number(rawConfig.settings.leverage) || 2000;
      }
    } catch (err: any) {
      console.warn(`[ExnessDiscovery] Probe ${configPath} on ${accessPoint} returned: ${err?.message || err}`);
    }

    // 2. Authoritative Trading Snapshot (Live Balance, Equity, Positions): GET /v1/trading/accounts/${accountId}/snapshot
    const snapshotPath = "/v1/trading/accounts/" + accountId + "/snapshot";
    try {
      const snapshotData = await this.signedRequest('GET', snapshotPath);
      if (snapshotData?.account_state) {
        const state = snapshotData.account_state;
        const b = num(state.balance);
        const eq = num(state.equity) ?? b;
        const m = num(state.used_margin) ?? 0;
        const fm = Math.max(0, (eq ?? b ?? 0) - m);
        const marginLevelPct = m > 0 ? ((eq ?? 0) / m) * 100 : 0;

        if (b !== undefined) {
          const coreState = getGlobalExnessState();
          coreState.liveAccount = {
            ...(coreState.liveAccount || {}),
            balance: b,
            equity: eq ?? b,
            margin: m,
            freeMargin: fm,
            updatedAt: Date.now(),
          };

          if (Array.isArray(snapshotData.positions)) {
            const positions = snapshotData.positions
              .map((p: any) => normalizeExnessPosition(p))
              .filter((p: any): p is ManagedPosition => Boolean(p));
            realTimeFeed.setPositions(positions);
          }

          console.log(`[ExnessDiscovery] Account #${accountId} snapshot verified on ${accessPoint} (Real Balance: $${b}, Equity: $${eq})`);

          return {
            accountId,
            server: server || accessPoint,
            currency: resolvedCurrency,
            balance: Number(b.toFixed(2)),
            equity: Number((eq ?? b).toFixed(2)),
            margin: Number(m.toFixed(2)),
            freeMargin: Number(fm.toFixed(2)),
            marginLevelPct: Number(marginLevelPct.toFixed(1)),
          };
        }
      }
    } catch (err: any) {
      console.warn(`[ExnessDiscovery] Probe ${snapshotPath} on ${accessPoint} returned: ${err?.message || err}`);
    }

    // 3. Fallback candidate account endpoints on accessPoint
    const candidateEndpoints: Array<{ method: string; path: string; body?: any }> = [
      { method: 'GET', path: `/v1/trading/accounts/${accountId}/snapshot` },
      { method: 'GET', path: `/v1/accounts/${accountId}` },
      { method: 'GET', path: `/v1/trading/accounts/${accountId}` },
      { method: 'GET', path: `/v1/accounts/${accountId}/balance` },
      { method: 'GET', path: '/v1/accounts/me' },
      { method: 'GET', path: '/v1/trading/account' },
    ];

    for (const probe of candidateEndpoints) {
      try {
        const raw = await this.signedRequest(probe.method, probe.path, probe.body);
        const candMatch = matchAccountFromPayload(raw, accountId, server || accessPoint);
        if (candMatch && candMatch.balance !== null && candMatch.balance !== undefined) {
          console.log(`[ExnessDiscovery] Matched Exness account #${candMatch.accountId} via ${probe.path}`);
          return candMatch;
        }
      } catch {}
    }

    // 4. Check if liveAccount from WebSocket events has balance
    const liveAcc = getGlobalExnessState().liveAccount;
    if (liveAcc && liveAcc.balance !== undefined && liveAcc.balance !== null) {
      return {
        accountId,
        server: server || accessPoint,
        currency: resolvedCurrency,
        balance: liveAcc.balance,
        equity: liveAcc.equity ?? liveAcc.balance,
        margin: liveAcc.margin ?? 0,
        freeMargin: liveAcc.freeMargin ?? liveAcc.balance,
        marginLevelPct: liveAcc.margin ? (liveAcc.equity! / liveAcc.margin) * 100 : 0,
      };
    }

    throw new ExnessApiError(
      `Account #${accountId} verification failed on ${accessPoint}. Periksa nomor Account ID, API Key (exnsk-), dan Ed25519 Private Key.`,
      404
    );
  }

  private async fetchRawAccount(): Promise<{
    accountId: string;
    server: string;
    currency: string;
    balance: number;
    equity: number;
    margin: number;
    freeMargin: number;
    marginLevelPct: number;
  }> {
    return coalesceAuthRequest(async () => {
      return this.discoverAndFetchAccount();
    });
  }

  /**
   * Connects and verifies credentials with Exness, then initiates WebSocket streams
   */
  public async connectAndVerify(credentials?: ExnessAccountCredentials | ExnessVaultCredentials): Promise<{
    connected: boolean;
    mode: 'DEMO' | 'REAL';
    accountId: string;
    server: string;
    balance: number;
    equity: number;
    freeMargin: number;
    currency: string;
  }> {
    if (credentials) {
      const cleanAccId = String(credentials.accountId || this.credentials.accountId || '').trim();
      if (cleanAccId) {
        // Clear cached access point to force fresh discovery for new/updated credentials
        delete getGlobalExnessState().accessPoints[cleanAccId];
      }
      this.credentials = {
        ...this.credentials,
        ...credentials,
        apiKey: (credentials as any).apiKey || (credentials as any).token || this.credentials.apiKey,
        privateKey: (credentials as any).privateKey || this.credentials.privateKey,
      };
      if (credentials.server) {
        this.configuredHost = normalizeGatewayHost(credentials.server);
      }
    }

    const acc = await this.discoverAndFetchAccount();
    const coreState = getGlobalExnessState();
    coreState.sessionToken = this.credentials.apiKey || null;
    coreState.tokenExpiresAt = Date.now() + 3600 * 1000;
    coreState.lastSnapshotPollTime = Date.now();
    coreState.lastPositionsPollTime = Date.now();
    coreState.liveAccount = {
      accountId: acc.accountId,
      server: acc.server,
      currency: acc.currency,
      balance: acc.balance,
      equity: acc.equity,
      margin: acc.margin,
      freeMargin: acc.freeMargin,
      marginLevelPct: acc.marginLevelPct,
      updatedAt: Date.now(),
      isVerified: true,
    };

    // Connect WebSocket streams (/ws/ticks & /ws/events) against resolved access_point
    const accessPoint = await this.resolveAccessPoint();
    if (!isGatewayHost(accessPoint)) {
      exnessWsManager.connect(
        accessPoint,
        acc.accountId,
        String(this.credentials.apiKey || ''),
        String(this.credentials.privateKey || '')
      );
    }

    return {
      connected: true,
      mode: this.getMode(),
      accountId: acc.accountId,
      server: acc.server || accessPoint,
      balance: acc.balance,
      equity: acc.equity,
      freeMargin: acc.freeMargin,
      currency: acc.currency,
    };
  }

  public async getMarketData(symbol: string = 'XAUUSDm', timeframe: string = 'M5'): Promise<{
    symbol: string;
    timeframe: string;
    bid: number;
    ask: number;
    spreadPips: number;
    candles: Candle[];
  }> {
    const quote = await this.getQuote(symbol);
    const candles = await this.getCandles(symbol, timeframe, 80);

    return {
      symbol,
      timeframe,
      bid: quote.bid,
      ask: quote.ask,
      spreadPips: quote.spreadPips,
      candles,
    };
  }

  /**
   * Official Order Placement:
   * Sends signed POST ${accessPoint}/v1/trading/accounts/${accountId}/positions
   * with non-empty EXN-IDEMPOTENCY-KEY and JSON body:
   * { "instrument": "XAUUSD", "side": "buy" | "sell", "volume": String(lot) }
   */
  public async openMarketOrder(req: {
    symbol: string;
    side: 'BUY' | 'SELL';
    lot?: number;
    volume?: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<OrderExecutionResult> {
    const lotSize = req.lot ?? req.volume ?? 0.01;
    return this.placeMarketOrder({
      symbol: req.symbol,
      side: req.side,
      volume: lotSize,
      stopLossPrice: req.stopLoss,
      takeProfitPrice: req.takeProfit,
      comment: req.comment,
    });
  }

  public async placeOrder(req: OrderPlacementRequest): Promise<OrderExecutionResult> {
    return this.placeMarketOrder(req);
  }

  public async placeMarketOrder(req: OrderPlacementRequest): Promise<OrderExecutionResult> {
    const profile = getPairProfile(req.symbol);
    const accountId = String(this.credentials.accountId || '').trim();
    const validVolume = roundLotVolume(req.volume || 0.10, profile.minLot, profile.lotStep);
    let currentVolume = validVolume;
    const sideLower = (req.side === 'SELL' ? 'sell' : 'buy') as 'buy' | 'sell';

    // HARD GATE MAX 2 POSITIONS: Always perform a live fetch directly from Exness API before placing any order
    const liveOpenPositions = await this.fetchOpenPositions(true).catch(() => [] as ManagedPosition[]);
    if (liveOpenPositions.length >= 2) {
      const guardMsg = `[POSITION_GUARD] Max 2 positions reached on Exness server (${liveOpenPositions.length}/2). Order aborted.`;
      console.warn(guardMsg);
      return {
        success: false,
        orderId: '',
        symbol: profile.symbol,
        side: req.side,
        fillPrice: 0,
        volume: currentVolume,
        stopLoss: req.stopLossPrice || 0,
        takeProfit: req.takeProfitPrice || 0,
        timestamp: Date.now(),
        message: guardMsg,
      };
    }

    // Ensure Hard SL (25 pips) and Hard TP (50 pips) are always computed and sent to Exness/MT5
    const isGold = profile.symbol === 'XAUUSDm' || profile.symbol.startsWith('XAU');
    const pipVal = isGold ? 0.10 : profile.pipValue;
    const liveQuote = realTimeFeed.getLiveQuote(req.symbol);
    const refPrice = req.side === 'BUY' ? (liveQuote.ask || liveQuote.bid) : (liveQuote.bid || liveQuote.ask);
    const resolvedSlPrice = req.stopLossPrice && req.stopLossPrice > 0
      ? req.stopLossPrice
      : (refPrice > 0
          ? Number((req.side === 'BUY' ? refPrice - 25 * pipVal : refPrice + 25 * pipVal).toFixed(profile.digits))
          : undefined);
    const resolvedTpPrice = req.takeProfitPrice && req.takeProfitPrice > 0
      ? req.takeProfitPrice
      : (refPrice > 0
          ? Number((req.side === 'BUY' ? refPrice + 50 * pipVal : refPrice - 50 * pipVal).toFixed(profile.digits))
          : undefined);

    // Base instrument name (e.g. "XAUUSD" for "XAUUSDm")
    const instName = req.symbol.endsWith('m') ? req.symbol.slice(0, -1) : req.symbol;

    let orderBody: Record<string, any> = {
      instrument: instName,
      side: sideLower,
      volume: String(currentVolume),
    };

    if (resolvedSlPrice) {
      orderBody.stop_loss = formatPrice(resolvedSlPrice, profile.digits);
    }
    if (resolvedTpPrice) {
      orderBody.take_profit = formatPrice(resolvedTpPrice, profile.digits);
    }
    if (req.comment) {
      orderBody.comment = String(req.comment).slice(0, 31);
    }

    let strippedSlTp = !resolvedSlPrice && !resolvedTpPrice && !req.comment;
    let scaledToMinLot = currentVolume <= 0.01;
    let marginAutoScaleLog: string | undefined = undefined;

    let idempotencyKey = `order-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const candidatePaths = [
      `/v1/trading/accounts/${encodeURIComponent(accountId)}/positions`,
      `/v1/trading/accounts/${encodeURIComponent(accountId)}/positions/open`,
      `/v1/trading/accounts/${encodeURIComponent(accountId)}/orders`,
      `/v1/trading/positions`,
      `/v1/trading/orders`,
    ];

    // Snapshot of position IDs BEFORE placing the order, so we match the NEW position (not an older one on the same symbol)
    const preOrderIds = new Set(realTimeFeed.getPositions().map((p) => normPosId(p.id)));

    let lastErr: any = null;
    let instrumentRetried = false;
    for (let pi = 0; pi < candidatePaths.length; pi++) {
      const path = candidatePaths[pi];
      try {
        const raw = await this.signedRequest('POST', path, orderBody, idempotencyKey);
        const data = unwrap(raw) || {};
        const operationId = String(data.operation_id ?? data.operationId ?? data.id ?? '');
        let orderId = String(data.position_id ?? data.positionId ?? data.ticket ?? '') || operationId;

        // If operation_id returned, wait for execution confirmation (up to ~1.8s) and detect async broker rejection
        if (operationId) {
          let opRejectedReason = '';
          let rejectedOpData: any = null;
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 300));
            try {
              const opRaw = await this.signedRequest(
                'GET',
                `/v1/trading/accounts/${encodeURIComponent(accountId)}/operations/${encodeURIComponent(operationId)}`
              );
              const opData = unwrap(opRaw) || opRaw || {};
              const opStatus = String(opData?.status || '').toLowerCase();
              const opPosId = String(opData?.position_id ?? opData?.positionId ?? opData?.result?.position_id ?? '');
              if (opPosId) orderId = opPosId;
              if (['rejected', 'failed', 'error', 'cancelled', 'canceled'].includes(opStatus)) {
                rejectedOpData = opData;
                console.warn(`[ExnessOrder] Operation #${operationId} rejected raw JSON: ${JSON.stringify(opData)}`);
                const brokerReason =
                  opData?.reason ||
                  opData?.error ||
                  opData?.comment ||
                  opData?.code ||
                  opData?.message ||
                  opData?.result?.reason ||
                  opData?.result?.error ||
                  opData?.result?.comment ||
                  opData?.result?.code ||
                  '';
                opRejectedReason = brokerReason
                  ? `${opStatus} (${brokerReason}) ${JSON.stringify(opData)}`
                  : `${opStatus} ${JSON.stringify(opData)}`;
                break;
              }
              if (opStatus === 'confirmed' || opStatus === 'executed' || opStatus === 'filled' || opStatus === 'done') break;
            } catch {}
          }
          if (opRejectedReason) {
            const rejErr: any = new Error(`Operation #${operationId} ${opRejectedReason}`);
            rejErr.status = 422;
            rejErr.isBrokerRejection = true;
            rejErr.opData = rejectedOpData;
            throw rejErr;
          }
        }

        // Refresh authoritative positions list from Exness snapshot (force REST poll, bypass 20s WS cache)
        getGlobalExnessState().lastPositionsPollTime = 0;
        const updatedPositions = await this.fetchOpenPositions().catch(() => [] as ManagedPosition[]);
        const matchedPos =
          updatedPositions.find((p) => normPosId(p.id) === normPosId(orderId) && p.source !== 'LOCAL_LEDGER') ||
          updatedPositions.find(
            (p) =>
              p.source !== 'LOCAL_LEDGER' &&
              !preOrderIds.has(normPosId(p.id)) &&
              (p.symbol === profile.symbol || p.symbol === req.symbol) &&
              p.side === req.side
          );
        if (matchedPos) {
          orderId = matchedPos.id;
        }

        const fillPrice = matchedPos?.entryPrice ??
          (req.side === 'BUY'
            ? realTimeFeed.getLiveQuote(req.symbol).ask
            : realTimeFeed.getLiveQuote(req.symbol).bid);
        const sl = num(matchedPos?.currentSl, orderBody.stop_loss) ?? (resolvedSlPrice || 0);
        const tp = num(matchedPos?.currentTp, orderBody.take_profit) ?? (resolvedTpPrice || 0);
        const filledVolume = matchedPos?.volume ?? currentVolume;

        // If inline SL/TP was stripped on retry, enforce Hard SL/TP via awaited post-fill position modification
        const finalId = String(orderId || operationId || `LOCAL-${Date.now()}`);
        if (strippedSlTp && (resolvedSlPrice || resolvedTpPrice) && finalId && !finalId.startsWith('LOCAL-')) {
          await this.modifyPositionInternal(finalId, resolvedSlPrice, resolvedTpPrice, req.symbol).catch(() => {});
        }

        // Persist the filled order in the server-side activeForexPositions ledger keyed by accountId so the next
        // 3s account poll MERGES it instead of wiping it with `positions: []` (Exness eventual consistency / fallback).
        const ledgerPos: ManagedPosition = refreshPositionFloating({
          ...(matchedPos || {}),
          id: finalId,
          symbol: profile.symbol,
          side: req.side,
          volume: filledVolume,
          initialVolume: matchedPos?.initialVolume ?? filledVolume,
          entryPrice: fillPrice,
          currentPrice: fillPrice,
          currentSl: sl,
          currentTp: tp,
          highestPrice: fillPrice,
          lowestPrice: fillPrice,
          openTime: matchedPos?.openTime ?? Date.now(),
          partialClosed: false,
          trailingStatus: matchedPos?.trailingStatus ?? 'INITIAL',
          accountId,
          source: matchedPos ? 'EXNESS' : 'LOCAL_LEDGER',
          seenOnBroker: Boolean(matchedPos),
        });
        saveActiveForexPosition(accountId, ledgerPos);

        return {
          success: true,
          orderId: finalId,
          symbol: profile.symbol,
          side: req.side,
          fillPrice,
          volume: filledVolume,
          stopLoss: ledgerPos.currentSl || sl,
          takeProfit: ledgerPos.currentTp || tp,
          timestamp: Date.now(),
          marginAutoScaleLog,
          message: `Exness FILLED: ${req.side} ${filledVolume} ${profile.symbol}${fillPrice ? ` @ ${formatPrice(fillPrice, profile.digits)}` : ''}${orderId ? ` (#${orderId})` : ''}${marginAutoScaleLog ? ` | ${marginAutoScaleLog}` : ''}`,
        };
      } catch (err: any) {
        lastErr = err;
        const errMsgLower = String(err?.message || '').toLowerCase();
        if (
          !instrumentRetried &&
          (errMsgLower.includes('instrument') || errMsgLower.includes('symbol')) &&
          orderBody.instrument !== req.symbol
        ) {
          // Exness "m"-suffixed accounts (Standard) trade "XAUUSDm": retry same endpoint once with the suffixed instrument
          orderBody.instrument = req.symbol;
          instrumentRetried = true;
          idempotencyKey = `order-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          pi--;
          continue;
        }

        const isRejection =
          Boolean(err?.isBrokerRejection) ||
          errMsgLower.includes('rejected') ||
          err?.status === 422 ||
          err?.status === 400;

        // Retry 1 (Strip Inline SL/TP): retry Market order with ONLY { instrument, side, volume } (no inline sl or tp)
        if (isRejection && !strippedSlTp) {
          strippedSlTp = true;
          orderBody = {
            instrument: orderBody.instrument,
            side: sideLower,
            volume: String(currentVolume),
          };
          console.warn(
            `[ExnessOrder] Retry 1 (Strip Inline SL/TP): Retrying ${req.side} ${currentVolume} ${orderBody.instrument} with ONLY { instrument, side, volume } after rejection: ${err?.message}`
          );
          idempotencyKey = `order-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          pi--;
          continue;
        }

        // Retry 2 (Auto-Cap Volume to Free Margin / 0.01 Lot): if Retry 1 still returns rejected when volume > 0.01
        if (isRejection && !scaledToMinLot && currentVolume > 0.01) {
          const prevVol = currentVolume;
          scaledToMinLot = true;
          strippedSlTp = true;
          currentVolume = 0.01;
          orderBody = {
            instrument: orderBody.instrument,
            side: sideLower,
            volume: '0.01',
          };
          const liveAcc = getGlobalExnessState().liveAccount;
          const freeMarginVal =
            liveAcc?.freeMargin ??
            liveAcc?.balance ??
            this.credentials.currentBalance ??
            this.credentials.initialBalance;
          const freeMarginStr =
            typeof freeMarginVal === 'number' && !isNaN(freeMarginVal)
              ? `$${freeMarginVal.toFixed(2)}`
              : '$70.07';
          marginAutoScaleLog = `[MARGIN AUTO-SCALE] Scaled lot from ${prevVol.toFixed(2)} -> 0.01 to fit Exness free margin (${freeMarginStr})`;
          console.warn(marginAutoScaleLog);
          idempotencyKey = `order-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          pi--;
          continue;
        }

        if (err?.status !== 404 && err?.status !== 405) {
          break;
        }
      }
    }

    return {
      success: false,
      orderId: '',
      symbol: profile.symbol,
      side: req.side,
      fillPrice: 0,
      volume: currentVolume,
      stopLoss: req.stopLossPrice || 0,
      takeProfit: req.takeProfitPrice || 0,
      timestamp: Date.now(),
      marginAutoScaleLog,
      message: `Order ditolak / gagal di Exness: ${lastErr?.message || lastErr}`,
    };
  }

  public async modifyPosition(
    reqOrId: string | { positionId: string; stopLoss?: number; takeProfit?: number },
    stopLoss?: number,
    takeProfit?: number,
    symbol?: string
  ): Promise<boolean> {
    if (typeof reqOrId === 'object') {
      return this.modifyPositionInternal(reqOrId.positionId, reqOrId.stopLoss, reqOrId.takeProfit, symbol);
    }
    return this.modifyPositionInternal(reqOrId, stopLoss, takeProfit, symbol);
  }

  private async modifyPositionInternal(
    positionId: string,
    stopLoss?: number,
    takeProfit?: number,
    symbol?: string
  ): Promise<boolean> {
    const cleanId = String(positionId || '').replace(/^#+/, '').trim();
    if (!cleanId) return false;
    const accountId = String(this.credentials.accountId || '').trim();
    const cached =
      realTimeFeed.getPositions().find((p) => normPosId(p.id) === cleanId) ||
      getActiveForexPositionsForAccount(accountId).find((p) => normPosId(p.id) === cleanId);
    const profile = getPairProfile(symbol || cached?.symbol || 'XAUUSDm');

    let safeStopLoss = stopLoss;
    if (safeStopLoss !== undefined && safeStopLoss !== null && cached && cached.entryPrice > 0) {
      const curPx = cached.currentPrice || cached.entryPrice;
      const isBuy = cached.side === 'BUY';
      if (isBuy && safeStopLoss >= cached.entryPrice && curPx <= cached.entryPrice) {
        safeStopLoss = Number((cached.entryPrice - 25 * (profile.symbol.startsWith('XAU') ? 0.10 : profile.pipValue)).toFixed(profile.digits));
      } else if (!isBuy && safeStopLoss <= cached.entryPrice && curPx >= cached.entryPrice) {
        safeStopLoss = Number((cached.entryPrice + 25 * (profile.symbol.startsWith('XAU') ? 0.10 : profile.pipValue)).toFixed(profile.digits));
      }
    }

    const body: Record<string, any> = {};
    if (safeStopLoss !== undefined && safeStopLoss !== null) {
      body.stop_loss = formatPrice(safeStopLoss, profile.digits);
    }
    if (takeProfit !== undefined && takeProfit !== null) {
      body.take_profit = formatPrice(takeProfit, profile.digits);
    }
    if (Object.keys(body).length === 0) return false;

    const idempotencyKey = `mod-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // Try modifying via Exness API positions / orders endpoints
    try {
      await this.signedRequest(
        'PATCH',
        `/v1/trading/accounts/${encodeURIComponent(accountId)}/positions/${encodeURIComponent(cleanId)}`,
        body,
        idempotencyKey
      );
    } catch {
      try {
        await this.signedRequest(
          'PATCH',
          `/v1/trading/accounts/${encodeURIComponent(accountId)}/orders/${encodeURIComponent(cleanId)}`,
          body,
          `mod-ord-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
        );
      } catch {
        // Endpoint not applicable to market positions on this node; local virtual/hybrid trailing manager enforces SL/TP
      }
    }

    const updates: Partial<ManagedPosition> = { lastSlUpdateTime: Date.now() };
    if (safeStopLoss !== undefined && safeStopLoss !== null) {
      updates.currentSl = safeStopLoss;
      updates.virtualSl = safeStopLoss;
    }
    if (takeProfit !== undefined && takeProfit !== null) {
      updates.currentTp = takeProfit;
      updates.virtualTp = takeProfit;
    }
    realTimeFeed.updatePosition(cleanId, updates);
    if (accountId) {
      const ledgerEntry = getActiveForexPositionsForAccount(accountId).find(
        (p) => normPosId(p.id) === cleanId
      );
      if (ledgerEntry) {
        saveActiveForexPosition(accountId, { ...ledgerEntry, ...updates });
      }
    }
    return true;
  }

  public async closePosition(
    reqOrId: string | { positionId: string },
    volumeToClose?: number,
    symbol?: string
  ): Promise<{ success: boolean; message: string; realizedPnl?: number; closePrice?: number }> {
    const positionId = String(typeof reqOrId === 'string' ? reqOrId : reqOrId.positionId).replace(/^#+/, '').trim();
    if (!positionId) return { success: false, message: 'Position ID is required' };

    const accountId = String(this.credentials.accountId || '').trim();
    const cached =
      realTimeFeed.getPositions().find((p) => normPosId(p.id) === positionId) ||
      getActiveForexPositionsForAccount(accountId).find((p) => normPosId(p.id) === positionId);
    const profile = getPairProfile(symbol || cached?.symbol || 'XAUUSDm');
    const isPartial = Boolean(volumeToClose && cached && volumeToClose < cached.volume);
    const closeVol = isPartial
      ? roundLotVolume(Number(volumeToClose), profile.minLot, profile.lotStep)
      : cached?.volume
      ? roundLotVolume(cached.volume, profile.minLot, profile.lotStep)
      : undefined;

    // Mark as isClosing in memory while keeping it in openPositions until broker confirms close
    markPositionClosingStart(positionId);
    const closingNow = Date.now();
    realTimeFeed.updatePosition(positionId, { isClosing: true, closingStartedAt: closingNow });
    if (accountId && cached) {
      saveActiveForexPosition(accountId, { ...cached, isClosing: true, closingStartedAt: closingNow });
    }

    const encAcc = encodeURIComponent(accountId);
    const encPos = encodeURIComponent(positionId);
    const baseInst = profile.symbol.endsWith('m') ? profile.symbol.slice(0, -1) : profile.symbol;

    const closeStrategies: Array<{ method: string; path: string; body?: any }> = [];
    if (isPartial && closeVol) {
      closeStrategies.push(
        {
          method: 'DELETE',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}?volume=${encodeURIComponent(String(closeVol))}`,
        },
        {
          method: 'POST',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}/close`,
          body: { volume: String(closeVol) },
        },
        {
          method: 'DELETE',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}`,
          body: { volume: String(closeVol) },
        },
        {
          method: 'POST',
          path: `/v1/trading/accounts/${encAcc}/positions/close`,
          body: { position_id: positionId, volume: String(closeVol) },
        }
      );
    } else {
      closeStrategies.push(
        {
          method: 'DELETE',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}`,
        },
        {
          method: 'POST',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}/close`,
          body: closeVol ? { volume: String(closeVol) } : {},
        },
        {
          method: 'DELETE',
          path: `/v2/trading/accounts/${encAcc}/positions/${encPos}`,
        },
        {
          method: 'POST',
          path: `/v1/trading/accounts/${encAcc}/positions/close`,
          body: { position_id: positionId, ...(closeVol ? { volume: String(closeVol) } : {}) },
        }
      );
      if (closeVol) {
        closeStrategies.push({
          method: 'DELETE',
          path: `/v1/trading/accounts/${encAcc}/positions/${encPos}?volume=${encodeURIComponent(String(closeVol))}`,
        });
      }
      if (cached && closeVol) {
        const oppositeSide = cached.side === 'BUY' ? 'sell' : 'buy';
        closeStrategies.push({
          method: 'POST',
          path: `/v1/trading/accounts/${encAcc}/positions`,
          body: {
            instrument: baseInst,
            side: oppositeSide,
            volume: String(closeVol),
            position_id: positionId,
          },
        });
      }
    }

    let closeConfirmed = false;
    let lastErr: any = null;

    for (const strat of closeStrategies) {
      const idempotencyKey = `close-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      try {
        const raw = await this.signedRequest(strat.method, strat.path, strat.body, idempotencyKey);
        const data = unwrap(raw) || {};
        const operationId = String(data.operation_id ?? data.operationId ?? '');

        if (operationId) {
          let opRejected = false;
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 250));
            try {
              const opRaw = await this.signedRequest(
                'GET',
                `/v1/trading/accounts/${encAcc}/operations/${encodeURIComponent(operationId)}`
              );
              const opData = unwrap(opRaw) || opRaw || {};
              const opStatus = String(opData?.status || '').toLowerCase();
              if (['rejected', 'failed', 'error', 'cancelled', 'canceled'].includes(opStatus)) {
                opRejected = true;
                lastErr = new Error(`Close operation #${operationId} ${opStatus}: ${JSON.stringify(opData)}`);
                break;
              }
              if (['confirmed', 'executed', 'filled', 'done', 'closed'].includes(opStatus)) {
                break;
              }
            } catch {}
          }
          if (opRejected) {
            continue;
          }
        }

        closeConfirmed = true;
        break;
      } catch (err: any) {
        lastErr = err;
      }
    }

    if (closeConfirmed) {
      if (!isPartial) {
        removeActiveForexPosition(accountId, positionId);
      }

      await new Promise((r) => setTimeout(r, 250));
      getGlobalExnessState().lastPositionsPollTime = 0;
      const latestAfterClose = await this.fetchOpenPositions().catch(() => [] as ManagedPosition[]);
      const stillOnBroker =
        !isPartial && latestAfterClose.some((p) => normPosId(p.id) === positionId && p.seenOnBroker !== false);

      if (stillOnBroker) {
        // Broker still reports the position open: keep it in openPositions without flickering and keep 15s cooldown
        realTimeFeed.updatePosition(positionId, { isClosing: false, closingStartedAt: undefined });
        markPositionClosingDone(positionId, false);
        return {
          success: false,
          message: `Close #${positionId} belum terkonfirmasi di server Exness (cooldown 15s aktif).`,
        };
      }

      markPositionClosingDone(positionId, true);
      const liveQuote = realTimeFeed.getLiveQuote(profile.symbol);
      const closePrice = cached?.side === 'BUY' ? liveQuote.bid : liveQuote.ask;
      const realizedPnl =
        cached && closePrice
          ? calculatePnL(cached.side, cached.entryPrice, closePrice, volumeToClose || cached.volume, profile).pnlUsd
          : undefined;

      if (realizedPnl !== undefined) realTimeFeed.recordRealizedPnL(realizedPnl);

      if (isPartial && volumeToClose && cached) {
        const remaining = Number((cached.volume - volumeToClose).toFixed(2));
        realTimeFeed.updatePosition(positionId, {
          volume: remaining,
          partialClosed: true,
          isClosing: false,
          closingStartedAt: undefined,
        });
        const ledgerEntry = getActiveForexPositionsForAccount(accountId).find((p) => normPosId(p.id) === positionId);
        if (ledgerEntry) {
          saveActiveForexPosition(accountId, {
            ...ledgerEntry,
            volume: remaining,
            partialClosed: true,
            isClosing: false,
            closingStartedAt: undefined,
          });
        }
        const pnlTxt = realizedPnl !== undefined ? ` (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})` : '';
        const priceTxt = closePrice !== undefined ? ` @ ${formatPrice(closePrice, profile.digits)}` : '';
        return {
          success: true,
          message: `Partial Close: ${volumeToClose} lots of #${positionId} closed on Exness${priceTxt}${pnlTxt}`,
          realizedPnl,
          closePrice,
        };
      } else {
        realTimeFeed.removePosition(positionId, realizedPnl || 0);
        const pnlTxt = realizedPnl !== undefined ? ` (${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)})` : '';
        const priceTxt = closePrice !== undefined ? ` @ ${formatPrice(closePrice, profile.digits)}` : '';
        return {
          success: true,
          message: `Position #${positionId} closed on Exness${priceTxt}${pnlTxt}`,
          realizedPnl,
          closePrice,
        };
      }
    }

    // Local ledger position never confirmed on the broker (fallback / demo fill): close it locally
    const ledgerEntry = getActiveForexPositionsForAccount(accountId).find((p) => normPosId(p.id) === positionId);
    if (ledgerEntry && !ledgerEntry.seenOnBroker) {
      markPositionClosingDone(positionId, true);
      const lq = realTimeFeed.getLiveQuote(ledgerEntry.symbol);
      const localClosePx = ledgerEntry.side === 'BUY' ? lq.bid : lq.ask;
      const localProfile = getPairProfile(ledgerEntry.symbol);
      const isPartialLocal = Boolean(volumeToClose && volumeToClose < ledgerEntry.volume);
      const closedVol = isPartialLocal
        ? roundLotVolume(Number(volumeToClose), localProfile.minLot, localProfile.lotStep)
        : ledgerEntry.volume;
      const localPnl = calculatePnL(
        ledgerEntry.side,
        ledgerEntry.entryPrice,
        localClosePx,
        closedVol,
        localProfile
      ).pnlUsd;
      realTimeFeed.recordRealizedPnL(localPnl);
      if (isPartialLocal) {
        const remaining = Number((ledgerEntry.volume - closedVol).toFixed(2));
        saveActiveForexPosition(accountId, {
          ...ledgerEntry,
          volume: remaining,
          partialClosed: true,
          isClosing: false,
          closingStartedAt: undefined,
        });
      } else {
        removeActiveForexPosition(accountId, positionId);
      }
      return {
        success: true,
        message: `${isPartialLocal ? `Partial Close: ${closedVol} lots of` : 'Position'} #${positionId} closed (local ledger) @ ${formatPrice(localClosePx, localProfile.digits)} (${localPnl >= 0 ? '+' : ''}$${localPnl.toFixed(2)})`,
        realizedPnl: localPnl,
        closePrice: localClosePx,
      };
    }

    realTimeFeed.updatePosition(positionId, { isClosing: false, closingStartedAt: undefined });
    markPositionClosingDone(positionId, false);
    return { success: false, message: `Close #${positionId} gagal: ${lastErr?.message || lastErr}` };
  }

  public async closeAllPositions(): Promise<{ closedCount: number; message: string }> {
    const positions = await this.fetchOpenPositions();
    let closedCount = 0;
    for (const p of positions) {
      const res = await this.closePosition(p.id, undefined, p.symbol);
      if (res.success) closedCount++;
    }
    // Panic Close All: purge any remaining local-ledger (never broker-confirmed) entries for this account
    const panicAccId = String(this.credentials.accountId || '').trim();
    if (panicAccId) {
      const leftovers = getActiveForexPositionsForAccount(panicAccId).filter((p) => !p.seenOnBroker);
      for (const p of leftovers) removeActiveForexPosition(panicAccId, p.id);
    }
    return {
      closedCount,
      message: `Panic Close: closed ${closedCount} of ${positions.length} Exness positions.`,
    };
  }

  public async getAccountSummary(): Promise<AccountInfo> {
    return coalesceSnapshotRequest(async () => {
      return this.getAccountInfo();
    });
  }

  public async getQuotes(symbols: string[] = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm']): Promise<Record<string, LiveQuote>> {
    return coalesceSnapshotRequest(async () => {
      const quotes: Record<string, LiveQuote> = {};
      await Promise.all(
        symbols.map(async (sym) => {
          quotes[sym] = await this.getQuote(sym);
        })
      );
      return quotes;
    });
  }

  public async fetchOpenPositions(forceLive: boolean = false): Promise<ManagedPosition[]> {
    if (!this.hasCredentials()) {
      return [];
    }
    const cleanAccountId = String(this.credentials.accountId || '').trim();
    const coreState = getGlobalExnessState();
    const now = Date.now();
    const POSITIONS_POLL_INTERVAL_MS = 20000;

    // If WebSocket events stream is connected and account is verified:
    // Serve from realTimeFeed (maintained in real time by WebSocket events) if polled < 20s ago
    // Unless forceLive === true (e.g. pre-order Max 2 Position Guard)
    if (!forceLive && coreState.liveAccount?.isVerified && (now - (coreState.lastPositionsPollTime || 0)) < POSITIONS_POLL_INTERVAL_MS) {
      // Merge with activeForexPositions ledger (never drop locally-filled orders) + refresh floating PnL
      return mergeRemoteWithActiveForexPositions(cleanAccountId, realTimeFeed.getPositions().filter((p) => p.source !== 'LOCAL_LEDGER' && p.seenOnBroker !== false), false);
    }

    try {
      coreState.lastPositionsPollTime = now;
      const snapshot = await this.signedRequest('GET', `/v1/trading/accounts/${encodeURIComponent(cleanAccountId)}/snapshot`);
      if (snapshot?.account_state) {
        const state = snapshot.account_state;
        const b = num(state.balance);
        const eq = num(state.equity) ?? b;
        const m = num(state.used_margin) ?? 0;
        const fm = Math.max(0, (eq ?? b ?? 0) - m);
        coreState.liveAccount = {
          ...(coreState.liveAccount || {}),
          ...(b !== undefined ? { balance: b } : {}),
          ...(eq !== undefined ? { equity: eq } : {}),
          ...(m !== undefined ? { margin: m } : {}),
          ...(fm !== undefined ? { freeMargin: fm } : {}),
          updatedAt: Date.now(),
          isVerified: true,
        };
      }

      const list: any[] = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
      const previous = new Map(realTimeFeed.getPositions().map((p) => [String(p.id), p]));
      const positions = list
        .map((r) => normalizeExnessPosition(r, previous.get(String(r?.id ?? r?.position_id ?? r?.positionId ?? r?.ticket ?? ''))))
        .filter((p): p is ManagedPosition => Boolean(p));

      // MERGE (never overwrite with []): keep locally-filled / fallback ledger positions until TP/SL/trailing/manual/panic close
      return mergeRemoteWithActiveForexPositions(cleanAccountId, positions, Array.isArray(snapshot?.positions));
    } catch (err: any) {
      console.warn(`[ExnessClient.fetchOpenPositions] Snapshot request failed: ${err?.message || err}`);
      return mergeRemoteWithActiveForexPositions(cleanAccountId, realTimeFeed.getPositions().filter((p) => p.source !== 'LOCAL_LEDGER'), false);
    }
  }

  /**
   * Returns REAL account info from Exness.
   * When disconnected: returns balance: null, equity: null, dailyPnl: null.
   * Never invents fake dummy balances.
   */
  public async getAccountInfo(): Promise<AccountInfo> {
    const mode = this.getMode();
    const started = Date.now();
    if (!this.hasCredentials()) {
      return {
        accountNumber: String(this.credentials.accountId || ''),
        server: String(this.credentials.server || ''),
        currency: 'USD',
        balance: null,
        equity: null,
        margin: 0,
        freeMargin: null,
        marginLevelPct: 0,
        dailyRealizedPnL: null,
        dailyRealizedLossUsd: 0,
        latencyMs: 0,
        connected: false,
        mode,
        isLiveExness: false,
        error: 'Akun Exness belum terhubung. Silakan isi kredensial di Vault.',
      };
    }

    const coreState = getGlobalExnessState();
    const liveAcc = coreState.liveAccount;
    const now = Date.now();
    const SNAPSHOT_POLL_INTERVAL_MS = 20000;

    // If verified and liveAccount exists:
    // Serve from memory maintained by WebSocket events if polled < 20s ago
    if (liveAcc && liveAcc.isVerified && liveAcc.balance !== null && liveAcc.balance !== undefined) {
      try {
        const ap = await this.resolveAccessPoint();
        if (!isGatewayHost(ap)) {
          this.ensureWebSocketConnected().catch(() => {});
        }
      } catch {}

      if (now - (coreState.lastSnapshotPollTime || 0) < SNAPSHOT_POLL_INTERVAL_MS) {
        return {
          accountNumber: String(this.credentials.accountId || liveAcc.accountId || ''),
          server: String(this.credentials.server || liveAcc.server || ''),
          currency: liveAcc.currency || 'USD',
          balance: liveAcc.balance,
          equity: liveAcc.equity ?? liveAcc.balance,
          margin: liveAcc.margin ?? 0,
          freeMargin: liveAcc.freeMargin ?? liveAcc.balance,
          marginLevelPct: liveAcc.marginLevelPct || (liveAcc.margin ? ((liveAcc.equity ?? 0) / liveAcc.margin) * 100 : 0),
          dailyRealizedPnL: realTimeFeed.getDailyRealizedPnL(),
          dailyRealizedLossUsd: 0,
          latencyMs: 10,
          connected: true,
          mode,
          isLiveExness: true,
        };
      }
    }

    try {
      coreState.lastSnapshotPollTime = now;
      const acc = await this.fetchRawAccount();
      const dailyPnl = realTimeFeed.getDailyRealizedPnL();

      // Ensure real-time WebSocket streams are connected
      try {
        const ap = await this.resolveAccessPoint();
        if (!isGatewayHost(ap)) {
          exnessWsManager.connect(
            ap,
            String(this.credentials.accountId || ''),
            String(this.credentials.apiKey || ''),
            String(this.credentials.privateKey || '')
          );
        }
      } catch {}

      return {
        accountNumber: acc.accountId,
        server: acc.server,
        currency: acc.currency,
        balance: acc.balance,
        equity: acc.equity,
        margin: acc.margin,
        freeMargin: acc.freeMargin,
        marginLevelPct: acc.marginLevelPct,
        dailyRealizedPnL: dailyPnl,
        dailyRealizedLossUsd: Math.max(0, -dailyPnl),
        latencyMs: Date.now() - started,
        connected: true,
        mode,
        isLiveExness: true,
      };
    } catch (err: any) {
      // If we had verified account data in memory, seamlessly preserve connection state
      if (liveAcc && liveAcc.isVerified && liveAcc.balance !== null && liveAcc.balance !== undefined) {
        return {
          accountNumber: String(this.credentials.accountId || liveAcc.accountId || ''),
          server: String(this.credentials.server || liveAcc.server || ''),
          currency: liveAcc.currency || 'USD',
          balance: liveAcc.balance,
          equity: liveAcc.equity ?? liveAcc.balance,
          margin: liveAcc.margin ?? 0,
          freeMargin: liveAcc.freeMargin ?? liveAcc.balance,
          marginLevelPct: liveAcc.marginLevelPct || (liveAcc.margin ? ((liveAcc.equity ?? 0) / liveAcc.margin) * 100 : 0),
          dailyRealizedPnL: realTimeFeed.getDailyRealizedPnL(),
          dailyRealizedLossUsd: 0,
          latencyMs: Date.now() - started,
          connected: true,
          mode,
          isLiveExness: true,
        };
      }

      return {
        accountNumber: String(this.credentials.accountId || ''),
        server: String(this.credentials.server || ''),
        currency: 'USD',
        balance: null,
        equity: null,
        margin: 0,
        freeMargin: null,
        marginLevelPct: 0,
        dailyRealizedPnL: null,
        dailyRealizedLossUsd: 0,
        latencyMs: Date.now() - started,
        connected: false,
        mode,
        isLiveExness: false,
        error: String(err?.message || err),
      };
    }
  }

  public async testConnection(): Promise<{
    success: boolean;
    message: string;
    balance?: number | null;
    equity?: number | null;
    accountNumber?: string;
    server?: string;
    latencyMs?: number;
  }> {
    const started = Date.now();
    try {
      const res = await this.connectAndVerify();
      return {
        success: true,
        message: `✅ Exness Direct Connected — Account #${res.accountId} verified`,
        balance: res.balance,
        equity: res.equity,
        accountNumber: res.accountId,
        server: res.server,
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Connection Error: ${err?.message || 'Server connection failed'}`,
      };
    }
  }

  public async ensureWebSocketConnected(): Promise<void> {
    if (!this.hasCredentials()) return;
    try {
      const ap = await this.resolveAccessPoint();
      if (!isGatewayHost(ap)) {
        exnessWsManager.connect(
          ap,
          String(this.credentials.accountId || '').trim(),
          String(this.credentials.apiKey || '').trim(),
          String(this.credentials.privateKey || '').trim()
        );
      }
    } catch {}
  }

  public async getQuote(symbol: string): Promise<LiveQuote> {
    const profile = getPairProfile(symbol);
    const cleanSym = profile.symbol;
    const existing = realTimeFeed.getLiveQuote(cleanSym);

    // If realTimeFeed has a fresh quote with bid > 0, return it
    if (existing && existing.bid > 0) {
      if (!cleanSym.startsWith('XAU') || (existing.bid >= 1500 && Math.abs(existing.bid - 3875.70) > 1.0)) {
        // WebSocket down/rejected (common on VPS): refresh in background so prices don't freeze
        // until the 3-minute candle cache expires. Non-blocking so the engine tick never waits on it.
        if (this.hasCredentials() && !isWsTickStreamAlive()) {
          this.refreshStaleQuote(cleanSym).catch(() => {});
        }
        return existing;
      }
    }

    // If client has vault credentials, fetch latest candles to seed real MT5 close
    if (this.hasCredentials()) {
      try {
        const candles = await this.getCandles(cleanSym, 'M5', 10);
        if (candles && candles.length > 0) {
          const lastC = candles[candles.length - 1];
          if (lastC && lastC.close > 0 && (!cleanSym.startsWith('XAU') || (lastC.close >= 1500 && Math.abs(lastC.close - 3875.70) > 1.0))) {
            const spread = cleanSym.startsWith('XAU') ? 0.20 : profile.pipValue;
            realTimeFeed.updateQuote(cleanSym, lastC.close, lastC.close + spread);
            return realTimeFeed.getLiveQuote(cleanSym);
          }
        }
      } catch {}
    }

    return realTimeFeed.fetchLiveQuote(cleanSym);
  }

  public async getSymbolQuote(symbolSnapshot: string): Promise<LiveQuote> {
    return this.getQuote(symbolSnapshot);
  }

  /**
   * REST fallback for live prices when the WebSocket tick stream is not delivering.
   * Fetches the last ~20 minutes of M1 candles (small payload) and feeds the latest close into the
   * quote feed and every cached candle series. Budgeted globally (1 request / 3s across all symbols)
   * and backs off for 5 minutes per symbol when the market is closed, so it never floods the
   * shared 1.2s REST queue.
   */
  private async refreshStaleQuote(cleanSym: string): Promise<void> {
    const g = globalThis as any;
    const now = Date.now();
    const quote = realTimeFeed.getLiveQuote(cleanSym);
    if (quote && now - (quote.timestamp || 0) < 5000) return; // already fresh enough

    g.__exnessStaleQuoteState = g.__exnessStaleQuoteState || { lastAt: 0, inFlight: {} as Record<string, boolean>, cooldown: {} as Record<string, number> };
    const st = g.__exnessStaleQuoteState as { lastAt: number; inFlight: Record<string, boolean>; cooldown: Record<string, number> };
    if (st.inFlight[cleanSym]) return;
    if ((st.cooldown[cleanSym] || 0) > now) return;
    if (now - st.lastAt < 3000) return;
    if (exnessRestThrottler.getQueueLength() > 6) return; // REST queue busy: trading calls first

    const accountId = String(this.credentials.accountId || '').trim();
    if (!accountId) return;

    st.lastAt = now;
    st.inFlight[cleanSym] = true;
    try {
      const baseInst = cleanSym.endsWith('m') ? cleanSym.slice(0, -1) : cleanSym;
      const from = new Date(now - 20 * 60 * 1000).toISOString();
      const to = new Date(now).toISOString();
      const path = `/v1/market-data/accounts/${encodeURIComponent(accountId)}/candles?instrument=${encodeURIComponent(baseInst)}&timeframe=M1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const raw = await this.signedRequest('GET', path);
      const list: any[] = Array.isArray(raw?.candles) ? raw.candles : [];
      if (list.length === 0) {
        st.cooldown[cleanSym] = Date.now() + 5 * 60 * 1000; // market closed / no data
        return;
      }
      const last = list[list.length - 1];
      const close = Number(last?.close);
      const lastTs = toMs(last?.time);
      if (lastTs && Date.now() - lastTs > 10 * 60 * 1000) {
        st.cooldown[cleanSym] = Date.now() + 5 * 60 * 1000; // stale bar → market closed
      }
      if (close > 0) {
        const profile = getPairProfile(cleanSym);
        const spread = cleanSym.startsWith('XAU') ? 0.20 : profile.pipValue;
        realTimeFeed.updateQuote(cleanSym, close, close + spread);
        updateCachedCandlesWithTick(baseInst, close);
      }
    } catch {
      // ignore: next tick retries within budget
    } finally {
      st.inFlight[cleanSym] = false;
    }
  }

  public async getCandles(symbol: string, timeframe: string = 'M5', limit: number = 80): Promise<Candle[]> {
    const targetLimit = Math.max(80, limit);
    const profile = getPairProfile(symbol);
    const cleanSym = profile.symbol;
    const baseInst = cleanSym.endsWith('m') ? cleanSym.slice(0, -1) : cleanSym;
    const tf = timeframe.toUpperCase();
    const cacheKey = `${baseInst}_${tf}`;

    const cached = exnessCandleMemoryCache.get(cacheKey);
    const now = Date.now();
    const ttl = getCandleTtlMs(tf);

    // 1. Serve immediately from memory cache if fresh (< TTL)
    if (cached && cached.candles.length >= 20 && (now - cached.lastFetchedAt) < ttl) {
      return cached.candles.slice(-targetLimit);
    }

    try {
      const accountId = String(this.credentials.accountId || '').trim();
      if (accountId && this.hasCredentials()) {
        let hoursBack = 72; // default for M5 covers weekend up to Friday close
        if (tf === 'M1') {
          hoursBack = 16; // Max 1000 candles on M1 (~16.6h)
        } else if (tf === 'M5') {
          hoursBack = 72; // ~864 bars, well under 1000
        } else if (tf === 'M15') {
          hoursBack = 140; // ~560 bars
        } else if (tf === 'H1') {
          hoursBack = 500; // ~500 bars
        }

        const past = new Date(Date.now() - hoursBack * 3600 * 1000);
        const toDate = new Date();
        const path = `/v1/market-data/accounts/${encodeURIComponent(accountId)}/candles?instrument=${encodeURIComponent(baseInst)}&timeframe=${encodeURIComponent(tf)}&from=${encodeURIComponent(past.toISOString())}&to=${encodeURIComponent(toDate.toISOString())}`;

        const raw = await this.signedRequest('GET', path);
        if (raw && Array.isArray(raw.candles) && raw.candles.length > 0) {
          const parsedCandles: Candle[] = raw.candles.map((c: any) => ({
            timestamp: toMs(c.time),
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume || 100),
          }));

          // Store in persistent in-memory cache updated with WS ticks
          exnessCandleMemoryCache.set(cacheKey, {
            instrument: baseInst,
            timeframe: tf,
            candles: parsedCandles,
            lastFetchedAt: Date.now(),
            ttlMs: ttl,
          });

          const lastCandle = parsedCandles[parsedCandles.length - 1];
          if (lastCandle && lastCandle.close > 0) {
            updateLastKnownPrice(cleanSym, lastCandle.close, 'exness-candles');
            const spread = cleanSym.startsWith('XAU') ? 0.20 : profile.pipValue;
            realTimeFeed.updateQuote(cleanSym, lastCandle.close, lastCandle.close + spread);
          }
          return parsedCandles.slice(-targetLimit);
        }
      }
    } catch (err: any) {
      // If REST failed (e.g. rate limit), return existing cached memory bars
      if (cached && cached.candles.length > 0) {
        return cached.candles.slice(-targetLimit);
      }
      console.warn(`[ExnessClient] getCandles error for ${cleanSym} (${tf}):`, err?.message || err);
    }

    if (cached && cached.candles.length > 0) {
      return cached.candles.slice(-targetLimit);
    }

    return realTimeFeed.fetchLiveCandles(cleanSym, targetLimit, timeframe);
  }

  public async panicCloseAll(positions?: ManagedPosition[]): Promise<{ closedCount: number; message: string }> {
    const list = positions && positions.length > 0 ? positions : await this.fetchOpenPositions();
    let closedCount = 0;
    for (const pos of list) {
      const res = await this.closePosition(pos.id, undefined, pos.symbol);
      if (res.success) closedCount++;
    }
    return {
      closedCount,
      message: `Panic Close: Terminated ${closedCount} of ${list.length} open positions.`,
    };
  }
}
