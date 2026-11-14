/**
 * Bitget V2 Futures API Adapter (src/services/bitgetService.ts)
 * REST adapter for Bitget USDT-M Futures — 100% live exchange connection (no simulated ledger).
 *
 * REST Base URL: https://api.bitget.com
 * REAL: productType = 'USDT-FUTURES', marginCoin = 'USDT'
 * DEMO: Official Bitget Demo Trading (requires a Demo API Key created in Bitget's demo mode):
 *       productType = 'USDT-FUTURES', marginCoin = 'USDT' + header 'paptrading: 1'.
 *       Legacy fallback on 40099: productType = 'SUSDT-FUTURES', marginCoin = 'SUSDT'.
 * Auth: HMAC-SHA256 Base64 signature over:
 *       timestamp + method.toUpperCase() + requestPath + (queryString ? '?' + queryString : '') + bodyString
 * Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, Content-Type, locale, paptrading
 * Timestamp is synced against /api/v2/public/time to avoid 40008 "request timestamp expired" on drifting clocks.
 */

import crypto from 'crypto';

export const BITGET_REST_BASE = 'https://api.bitget.com';
export const BITGET_WS_PUBLIC = 'wss://ws.bitget.com/v2/ws/public';
export const BITGET_WS_PRIVATE = 'wss://ws.bitget.com/v2/ws/private';
export const BITGET_WS_PAP_PUBLIC = 'wss://wspap.bitget.com/v2/ws/public';
export const BITGET_WS_PAP_PRIVATE = 'wss://wspap.bitget.com/v2/ws/private';

export interface BitgetSymbolFilter {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
}

export interface Bitget24hTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

export interface BitgetKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BitgetPosition {
  symbol: string;
  rawSymbol?: string;
  positionAmt: number; // positive = long, negative = short
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  isolatedMargin: number;
  holdSide: 'long' | 'short';
  total: number;
  available: number;
  initialQuantity?: number;
  partialClosed?: boolean;
  isBreakevenLocked?: boolean;
  takeProfit1Price?: number;
  stopLossPrice?: number;
  trailingStopPrice?: number;
  highestPriceSinceEntry?: number;
  lowestPriceSinceEntry?: number;
  openTime?: number;
}

export interface BitgetAccountInfo {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
  positions: BitgetPosition[];
  connected: boolean;
  accountType: 'REAL' | 'DEMO';
}

export type BitgetPosMode = 'one_way_mode' | 'hedge_mode';

/**
 * Computes Bitget V2 HMAC-SHA256 signature in Base64
 * Formula: HMAC-SHA256(secretKey, timestamp + method.toUpperCase() + requestPath + (queryString ? '?' + queryString : '') + bodyString)
 */
export function signBitgetV2(
  timestamp: string | number,
  method: string,
  requestPath: string,
  queryString: string = '',
  bodyString: string = '',
  secretKey: string
): string {
  const query = queryString ? (queryString.startsWith('?') ? queryString : `?${queryString}`) : '';
  const message = `${timestamp}${method.toUpperCase()}${requestPath}${query}${bodyString}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

function decimalsOf(stepStr: string): number {
  const s = String(stepStr);
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10) || 0;
  const idx = s.indexOf('.');
  return idx >= 0 ? s.length - idx - 1 : 0;
}

/**
 * Formats quantity (floored) to the symbol step size
 */
export function formatBitgetQuantity(qty: number, stepSizeStr: string = '0.001', precision: number = 3): string {
  const step = parseFloat(stepSizeStr) || Math.pow(10, -precision);
  if (step <= 0) return qty.toFixed(precision);
  const stepped = Math.floor(qty / step + 1e-9) * step;
  return stepped.toFixed(Math.max(precision, decimalsOf(stepSizeStr)));
}

/**
 * Maps standard symbol (e.g. BTCUSDT) to Bitget contract symbol (e.g. BTCSUSDT in legacy SUSDT-FUTURES demo).
 */
export function toBitgetSymbol(symbol: string, isLegacyDemo: boolean = false): string {
  if (!symbol) return '';
  const clean = symbol.trim().toUpperCase();
  if (isLegacyDemo) {
    if (clean.endsWith('SUSDT')) return clean;
    if (clean.endsWith('USDT')) return clean.slice(0, -4) + 'SUSDT';
    return clean;
  }
  if (clean.endsWith('SUSDT')) return clean.slice(0, -5) + 'USDT';
  return clean;
}

/**
 * Normalizes Bitget contract symbols (e.g. BTCSUSDT or SBTCSUSDT) back to standard BTCUSDT.
 */
export function fromBitgetSymbol(symbol: string): string {
  if (!symbol) return '';
  let clean = symbol.trim().toUpperCase();
  if (clean.startsWith('S') && clean.endsWith('SUSDT') && clean.length > 6) {
    clean = clean.slice(1);
  }
  if (clean.endsWith('SUSDT')) {
    clean = clean.slice(0, -5) + 'USDT';
  }
  return clean;
}

// ─── Environment profiles ──────────────────────────────────────────────────
export interface BitgetEnvProfile {
  productType: string;
  marginCoin: string;
  sendPaptrading: boolean;
}

const REAL_PROFILE: BitgetEnvProfile = { productType: 'USDT-FUTURES', marginCoin: 'USDT', sendPaptrading: false };
const DEMO_PROFILE: BitgetEnvProfile = { productType: 'USDT-FUTURES', marginCoin: 'USDT', sendPaptrading: true };
const DEMO_LEGACY_PROFILE: BitgetEnvProfile = { productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT', sendPaptrading: false };

/** Remembered working profile per API key. */
const workingProfileCache = new Map<string, BitgetEnvProfile>();
/** Position mode cache per API key + env. */
const posModeCache = new Map<string, { mode: BitgetPosMode; ts: number }>();
const POS_MODE_TTL_MS = 60_000;

// ─── Contract spec cache (public) ──────────────────────────────────────────
interface BitgetContractSpec {
  symbol: string;
  pricePlace: number;
  priceEndStep: number;
  volumePlace: number;
  sizeMultiplier: number;
  minTradeNum: number;
  minTradeUSDT: number;
  maxLever: number;
}
let contractSpecCache: { ts: number; map: Map<string, BitgetContractSpec> } | null = null;
const CONTRACT_TTL_MS = 10 * 60_000;

// ─── Server time sync ──────────────────────────────────────────────────────
let serverTimeOffsetMs = 0;
let serverTimeSyncedAt = 0;
const SERVER_TIME_TTL_MS = 5 * 60_000;

// ─── Network Circuit Breaker ────────────────────────────────────────────────
// When api.bitget.com is unreachable (ISP block / connect timeout), skip all
// outbound Bitget requests for 30s and emit a single 1-line warning instead of
// flooding the terminal with multi-line undici stack traces every heartbeat.
const BITGET_CIRCUIT_BACKOFF_MS = 30_000;
const BITGET_FETCH_TIMEOUT_MS = 15_000;
let bitgetCircuitOpenUntil = 0;

const BITGET_NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

function getBitgetNetworkErrorCode(err: any): string | null {
  const code = err?.cause?.code || err?.code || err?.cause?.cause?.code;
  if (code && BITGET_NETWORK_ERROR_CODES.has(String(code))) return String(code);
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'ETIMEDOUT';
  const msg = String(err?.cause?.message || err?.message || '');
  if (/connect timeout/i.test(msg)) return 'UND_ERR_CONNECT_TIMEOUT';
  if (/aborted/i.test(msg)) return 'ECONNABORTED';
  return null;
}

export class BitgetCircuitOpenError extends Error {
  public readonly retryInMs: number;
  constructor(retryInMs: number) {
    super(`Bitget circuit open (network unreachable), retry in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'BitgetCircuitOpenError';
    this.retryInMs = retryInMs;
  }
}

export class BitgetApiError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number = 0) {
    super(message);
    this.name = 'BitgetApiError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isBitgetCircuitOpen(): boolean {
  return Date.now() < bitgetCircuitOpenUntil;
}

/** Compact 1-line error description (no stack traces). */
function describeBitgetError(err: any): string {
  if (err instanceof BitgetCircuitOpenError) return err.message;
  const code = getBitgetNetworkErrorCode(err);
  return code ? `${code} (${err?.cause?.message || err?.message || 'network error'})` : (err?.message || String(err));
}

/** Human friendly hints for the most common Bitget auth/env error codes. */
const BITGET_ERROR_HINTS: Record<string, string> = {
  '40006': 'API Key tidak valid',
  '40037': 'API Key tidak ditemukan',
  '40009': 'Signature salah — periksa Secret Key',
  '40012': 'Passphrase salah',
  '40008': 'Timestamp kedaluwarsa — jam perangkat tidak sinkron',
  '40005': 'Timestamp tidak valid — jam perangkat tidak sinkron',
  '40014': 'API Key tidak punya izin Futures Trade',
  '40018': 'IP tidak ada di whitelist API Key',
  '40099': 'Environment salah — Demo API Key harus dipakai di mode DEMO dan Real API Key di mode REAL',
  '22002': 'Tidak ada posisi untuk ditutup',
  '40774': 'Mode posisi tidak cocok (one-way vs hedge)',
  '45110': 'Ukuran order di bawah minimum',
  '43012': 'Saldo tidak cukup',
};

function buildApiError(json: any, status: number, rawText: string): BitgetApiError {
  const code = json?.code !== undefined ? String(json.code) : String(status);
  const msg = json?.msg || json?.message || rawText || `HTTP ${status}`;
  const hint = BITGET_ERROR_HINTS[code];
  return new BitgetApiError(code, `Bitget [${code}] ${msg}${hint ? ` (${hint})` : ''}`, status);
}

function isEnvMismatch(json: any, rawText: string): boolean {
  const code = json?.code !== undefined ? String(json.code) : '';
  if (code === '40099') return true;
  const msg = String(json?.msg || rawText || '').toLowerCase();
  return msg.includes('exchange environment is incorrect') || msg.includes('currency as margin');
}

export class BitgetFuturesService {
  public readonly apiKey: string;
  public readonly secretKey: string;
  public readonly passphrase: string;
  private _accountType: 'REAL' | 'DEMO' = 'REAL';
  public readonly baseUrl: string;
  public productType: string = 'USDT-FUTURES';
  public marginCoin: string = 'USDT';

  public get accountType(): 'REAL' | 'DEMO' {
    return this._accountType;
  }

  public set accountType(val: 'REAL' | 'DEMO' | boolean) {
    this._accountType = (val === true || val === 'DEMO') ? 'DEMO' : 'REAL';
    this.syncEnvironment();
  }

  public get mode(): 'REAL' | 'DEMO' {
    return this._accountType;
  }

  public set mode(val: 'REAL' | 'DEMO' | boolean) {
    this.accountType = val as any;
  }

  public get isTestnet(): boolean {
    return this._accountType === 'DEMO';
  }

  public set isTestnet(val: boolean) {
    this.accountType = val ? 'DEMO' : 'REAL';
  }

  public static clearStrategyCache(): void {
    workingProfileCache.clear();
    posModeCache.clear();
  }

  constructor(
    apiKey: string = '',
    secretKey: string = '',
    passphrase: string = '',
    accountType: 'REAL' | 'DEMO' | boolean = 'REAL'
  ) {
    this.apiKey = (apiKey || '').trim();
    this.secretKey = (secretKey || '').trim();
    this.passphrase = (passphrase || '').trim();
    this._accountType = (accountType === true || accountType === 'DEMO') ? 'DEMO' : 'REAL';
    this.baseUrl = BITGET_REST_BASE;
    this.syncEnvironment();
  }

  public get hasCredentials(): boolean {
    return Boolean(this.apiKey && this.secretKey && this.passphrase);
  }

  private get profileCacheKey(): string {
    return `${this.apiKey}:${this._accountType}`;
  }

  private get envKey(): string {
    return `${this.apiKey}|${this.productType}|${this.activeProfile.sendPaptrading ? 'PAP' : 'LIVE'}`;
  }

  private get activeProfile(): BitgetEnvProfile {
    const cached = this.apiKey ? workingProfileCache.get(this.profileCacheKey) : undefined;
    if (cached) return cached;
    return this._accountType === 'REAL' ? REAL_PROFILE : DEMO_PROFILE;
  }

  private syncEnvironment(): void {
    const p = this.activeProfile;
    this.productType = p.productType;
    this.marginCoin = p.marginCoin;
  }

  private get isLegacyDemo(): boolean {
    return this.productType === 'SUSDT-FUTURES';
  }

  public toBitgetSymbol(symbol: string): string {
    return toBitgetSymbol(symbol, this.isLegacyDemo);
  }

  public fromBitgetSymbol(symbol: string): string {
    return fromBitgetSymbol(symbol);
  }

  // ─── Low-level HTTP ──────────────────────────────────────────────────────

  private async rawFetch(
    method: 'GET' | 'POST',
    requestPath: string,
    queryParams: Record<string, any> = {},
    bodyData: Record<string, any> | undefined,
    opts: { signed: boolean; paptrading: boolean }
  ): Promise<{ ok: boolean; status: number; json: any; rawText: string }> {
    const circuitRemainingMs = bitgetCircuitOpenUntil - Date.now();
    if (circuitRemainingMs > 0) {
      throw new BitgetCircuitOpenError(circuitRemainingMs);
    }

    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(queryParams)) {
      if (val !== undefined && val !== null && val !== '') urlParams.append(key, String(val));
    }
    const queryString = urlParams.toString();
    const fullUrl = `${this.baseUrl}${requestPath}${queryString ? `?${queryString}` : ''}`;
    const bodyString = bodyData ? JSON.stringify(bodyData) : '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'locale': 'en-US',
    };
    if (opts.paptrading) headers['paptrading'] = '1';

    if (opts.signed) {
      await syncServerTime(this.baseUrl);
      const timestamp = String(Date.now() + serverTimeOffsetMs);
      headers['ACCESS-KEY'] = this.apiKey;
      headers['ACCESS-SIGN'] = signBitgetV2(timestamp, method, requestPath, queryString, bodyString, this.secretKey);
      headers['ACCESS-TIMESTAMP'] = timestamp;
      headers['ACCESS-PASSPHRASE'] = this.passphrase;
    }

    let res: Response;
    try {
      res = await fetch(fullUrl, {
        method,
        headers,
        body: method === 'GET' ? undefined : (bodyString || undefined),
        cache: 'no-store',
        signal: AbortSignal.timeout(BITGET_FETCH_TIMEOUT_MS),
      });
    } catch (fetchErr: any) {
      const netCode = getBitgetNetworkErrorCode(fetchErr);
      if (netCode) {
        const wasOpen = isBitgetCircuitOpen();
        bitgetCircuitOpenUntil = Date.now() + BITGET_CIRCUIT_BACKOFF_MS;
        if (!wasOpen) {
          console.warn(`[BitgetService] ${netCode} reaching ${new URL(fullUrl).host} — pausing Bitget requests for ${BITGET_CIRCUIT_BACKOFF_MS / 1000}s`);
        }
        throw new BitgetCircuitOpenError(BITGET_CIRCUIT_BACKOFF_MS);
      }
      throw fetchErr;
    }

    const rawText = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      // Body is not valid JSON
    }
    return { ok: res.ok, status: res.status, json, rawText };
  }

  private static isSuccess(res: { ok: boolean; json: any }): boolean {
    return res.ok && res.json && (res.json.code === '00000' || res.json.code === 0 || res.json.code === '0');
  }

  /** Unauthenticated public market endpoint. */
  public async publicRequest<T = any>(requestPath: string, queryParams: Record<string, any> = {}): Promise<T> {
    const res = await this.rawFetch('GET', requestPath, queryParams, undefined, { signed: false, paptrading: false });
    if (BitgetFuturesService.isSuccess(res)) return res.json.data as T;
    throw buildApiError(res.json, res.status, res.rawText);
  }

  /**
   * Authenticated private request. productType / marginCoin / symbol in params are rewritten to the
   * active environment. On 40099 env mismatch, automatically probes matching DEMO or REAL profiles and caches the working one.
   */
  public async request<T = any>(
    method: 'GET' | 'POST',
    requestPath: string,
    queryParams: Record<string, any> = {},
    bodyData?: Record<string, any>
  ): Promise<T> {
    if (!this.hasCredentials) {
      throw new BitgetApiError('NO_CREDENTIALS', 'Bitget API Key, Secret Key, dan Passphrase wajib diisi.');
    }

    const preferred = this.activeProfile;
    const candidatePool: BitgetEnvProfile[] =
      this._accountType === 'DEMO'
        ? [DEMO_PROFILE, DEMO_LEGACY_PROFILE]
        : [REAL_PROFILE];
    const profiles: BitgetEnvProfile[] = [
      preferred,
      ...candidatePool.filter((p) => p !== preferred),
    ];

    let lastRes: { ok: boolean; status: number; json: any; rawText: string } | null = null;

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const q = this.applyProfile(queryParams, profile) || {};
      const b = this.applyProfile(bodyData, profile);
      let res = await this.rawFetch(method, requestPath, q, b, { signed: true, paptrading: profile.sendPaptrading });

      // Retry once if local clock drifted (40008 / 40005)
      const errCode = res.json?.code !== undefined ? String(res.json.code) : '';
      if (!BitgetFuturesService.isSuccess(res) && (errCode === '40008' || errCode === '40005')) {
        serverTimeSyncedAt = 0;
        await syncServerTime(this.baseUrl);
        res = await this.rawFetch(method, requestPath, q, b, { signed: true, paptrading: profile.sendPaptrading });
      }

      lastRes = res;

      if (BitgetFuturesService.isSuccess(res)) {
        if (this.apiKey && workingProfileCache.get(this.profileCacheKey) !== profile) {
          workingProfileCache.set(this.profileCacheKey, profile);
        }
        this.productType = profile.productType;
        this.marginCoin = profile.marginCoin;
        return res.json.data as T;
      }

      if (!isEnvMismatch(res.json, res.rawText) || i === profiles.length - 1) break;
    }

    throw buildApiError(lastRes?.json, lastRes?.status || 0, lastRes?.rawText || '');
  }

  private applyProfile(params: Record<string, any> | undefined, profile: BitgetEnvProfile): Record<string, any> | undefined {
    if (!params) return params;
    const updated = { ...params };
    if ('productType' in updated) updated.productType = profile.productType;
    if ('marginCoin' in updated) updated.marginCoin = profile.marginCoin;
    if (typeof updated.symbol === 'string' && updated.symbol) {
      updated.symbol = toBitgetSymbol(updated.symbol, profile.productType === 'SUSDT-FUTURES');
    }
    return updated;
  }

  // ─── Account ─────────────────────────────────────────────────────────────

  private static parseNum(...candidates: any[]): number {
    for (const c of candidates) {
      if (c !== undefined && c !== null && c !== '') {
        const n = parseFloat(String(c));
        if (Number.isFinite(n) && n !== 0) return n;
      }
    }
    for (const c of candidates) {
      if (c !== undefined && c !== null && c !== '') {
        const n = parseFloat(String(c));
        if (Number.isFinite(n)) return n;
      }
    }
    return 0;
  }

  /**
   * Account balance & verification
   * Endpoint: /api/v2/mix/account/accounts
   */
  async getAccountInfo(): Promise<BitgetAccountInfo> {
    let accounts = await this.request<any[]>('GET', '/api/v2/mix/account/accounts', {
      productType: this.productType,
    });

    const extractAccountMetrics = (rawList: any[], targetCoin: string) => {
      const list = Array.isArray(rawList) ? rawList : [];
      const matched =
        list.find((a: any) => String(a.marginCoin || '').toUpperCase() === targetCoin.toUpperCase()) ||
        list.find((a: any) => ['USDT', 'SUSDT'].includes(String(a.marginCoin || '').toUpperCase())) ||
        list[0] ||
        {};
      const equity = BitgetFuturesService.parseNum(matched.accountEquity, matched.usdtEquity, matched.available);
      const unrealizedPnl = BitgetFuturesService.parseNum(matched.unrealizedPL, matched.crossedUnrealizedPL);
      const available = BitgetFuturesService.parseNum(matched.available);
      const maxAvailable = BitgetFuturesService.parseNum(matched.crossedMaxAvailable, matched.isolatedMaxAvailable, matched.maxTransferOut);
      return { equity, unrealizedPnl, available, maxAvailable };
    };

    let { equity, unrealizedPnl, available, maxAvailable } = extractAccountMetrics(accounts, this.marginCoin);

    // In DEMO mode, if the primary profile (e.g. USDT-FUTURES + paptrading:1) has 0 balance,
    // check the alternate Demo profile (e.g. SUSDT-FUTURES) in case the user's Demo funds are in SUSDT.
    if (this._accountType === 'DEMO' && equity <= 0 && available <= 0 && maxAvailable <= 0) {
      const altDemoProfile = this.activeProfile === DEMO_PROFILE ? DEMO_LEGACY_PROFILE : DEMO_PROFILE;
      try {
        const q = this.applyProfile({ productType: altDemoProfile.productType }, altDemoProfile) || {};
        const altRes = await this.rawFetch('GET', '/api/v2/mix/account/accounts', q, undefined, {
          signed: true,
          paptrading: altDemoProfile.sendPaptrading,
        });
        if (BitgetFuturesService.isSuccess(altRes) && Array.isArray(altRes.json?.data)) {
          const altMetrics = extractAccountMetrics(altRes.json.data, altDemoProfile.marginCoin);
          if (altMetrics.equity > 0 || altMetrics.available > 0 || altMetrics.maxAvailable > 0) {
            if (this.apiKey) {
              workingProfileCache.set(this.profileCacheKey, altDemoProfile);
            }
            this.productType = altDemoProfile.productType;
            this.marginCoin = altDemoProfile.marginCoin;
            accounts = altRes.json.data;
            equity = altMetrics.equity;
            unrealizedPnl = altMetrics.unrealizedPnl;
            available = altMetrics.available;
            maxAvailable = altMetrics.maxAvailable;
          }
        }
      } catch {
        // Ignore alternate Demo profile probe error and keep primary Demo profile
      }
    }

    let positions: BitgetPosition[] = [];
    try {
      positions = await this.getOpenPositions();
    } catch (posErr) {
      console.warn(`[BitgetService.getAccountInfo] Positions warning: ${describeBitgetError(posErr)}`);
    }

    const totalUnrealized = positions.length > 0
      ? positions.reduce((sum, p) => sum + (p.unRealizedProfit || 0), 0)
      : unrealizedPnl;

    const walletBalance = Math.max(0, equity - unrealizedPnl);

    return {
      totalWalletBalance: Number(walletBalance.toFixed(2)),
      totalUnrealizedProfit: Number(totalUnrealized.toFixed(2)),
      totalMarginBalance: Number((walletBalance + totalUnrealized).toFixed(2)),
      availableBalance: Number((maxAvailable > 0 ? maxAvailable : available).toFixed(2)),
      positions,
      connected: true,
      accountType: this.accountType,
    };
  }

  /**
   * Position mode (one-way vs hedge). Endpoint: /api/v2/mix/account/account
   */
  async getPositionMode(symbol: string = 'BTCUSDT'): Promise<BitgetPosMode> {
    const cached = posModeCache.get(this.envKey);
    if (cached && Date.now() - cached.ts < POS_MODE_TTL_MS) return cached.mode;

    try {
      const data = await this.request<any>('GET', '/api/v2/mix/account/account', {
        symbol: fromBitgetSymbol(symbol),
        productType: this.productType,
        marginCoin: this.marginCoin,
      });
      const mode: BitgetPosMode = data?.posMode === 'hedge_mode' ? 'hedge_mode' : 'one_way_mode';
      posModeCache.set(this.envKey, { mode, ts: Date.now() });
      return mode;
    } catch {
      return 'one_way_mode';
    }
  }

  async setLeverage(symbol: string, leverage: number, holdSide?: 'long' | 'short'): Promise<any> {
    const body: Record<string, any> = {
      symbol: fromBitgetSymbol(symbol),
      productType: this.productType,
      marginCoin: this.marginCoin,
      leverage: String(Math.max(1, Math.round(leverage))),
    };
    if (holdSide) body.holdSide = holdSide;
    return this.request('POST', '/api/v2/mix/account/set-leverage', {}, body);
  }

  async setMarginMode(symbol: string, marginMode: 'isolated' | 'crossed'): Promise<any> {
    return this.request('POST', '/api/v2/mix/account/set-margin-mode', {}, {
      symbol: fromBitgetSymbol(symbol),
      productType: this.productType,
      marginCoin: this.marginCoin,
      marginMode,
    });
  }

  // ─── Market data (public) ────────────────────────────────────────────────

  /**
   * Kline/Candle fetching. Endpoint: /api/v2/mix/market/candles
   * Always uses standard USDT symbol with productType='USDT-FUTURES' (live market data).
   */
  async getKlines(symbol: string, interval: string = '5m', limit: number = 100): Promise<BitgetKline[]> {
    const map: Record<string, string> = {
      '1m': '1m', m1: '1m', '5m': '5m', m5: '5m', '15m': '15m', m15: '15m', '30m': '30m', m30: '30m',
      '1h': '1H', h1: '1H', '4h': '4H', h4: '4H', '1d': '1D', d1: '1D',
    };
    const granularity = map[interval.toLowerCase()] || '5m';
    const standardSymbol = fromBitgetSymbol(symbol);

    try {
      const data = await this.publicRequest<any[][]>('/api/v2/mix/market/candles', {
        symbol: standardSymbol,
        productType: 'USDT-FUTURES',
        granularity,
        limit: Math.min(Math.max(limit, 1), 1000),
      });
      if (!Array.isArray(data)) return [];
      return data
        .map((row) => ({
          timestamp: parseInt(row[0], 10),
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5] || '0'),
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
    } catch (err) {
      if (!(err instanceof BitgetCircuitOpenError)) {
        console.warn(`[BitgetService.getKlines] ${standardSymbol}: ${describeBitgetError(err)}`);
      }
      return [];
    }
  }

  /**
   * 24h Tickers for all active pairs. Endpoint: /api/v2/mix/market/tickers
   */
  async get24hrTickers(): Promise<Record<string, Bitget24hTicker>> {
    try {
      const map: Record<string, Bitget24hTicker> = {};
      const data = await this.publicRequest<any[]>('/api/v2/mix/market/tickers', { productType: 'USDT-FUTURES' });
      if (!Array.isArray(data)) return map;

      for (const item of data) {
        if (!item.symbol) continue;
        const rawPrice = parseFloat(item.lastPr || item.lastPrice || '0');
        const rawChange = parseFloat(item.change24h || item.priceChangePercent || '0');
        // Bitget change24h is a decimal ratio (e.g. -0.00066 -> -0.066%), so multiply by 100 for %
        const priceChangePercent = item.change24h !== undefined ? rawChange * 100 : rawChange;
        const volume = parseFloat(item.baseVolume || item.volume || '0');
        const symbol = fromBitgetSymbol(item.symbol);
        map[symbol] = {
          symbol,
          lastPrice: rawPrice,
          priceChangePercent,
          highPrice: parseFloat(item.high24h || '0'),
          lowPrice: parseFloat(item.low24h || '0'),
          volume,
          quoteVolume: parseFloat(item.usdtVolume || item.quoteVolume || '0') || volume * rawPrice,
        };
      }
      return map;
    } catch (err) {
      if (!(err instanceof BitgetCircuitOpenError)) console.warn(`[BitgetService.get24hrTickers] ${describeBitgetError(err)}`);
      return {};
    }
  }

  private async loadContractSpecs(): Promise<Map<string, BitgetContractSpec>> {
    if (contractSpecCache && Date.now() - contractSpecCache.ts < CONTRACT_TTL_MS) return contractSpecCache.map;
    const data = await this.publicRequest<any[]>('/api/v2/mix/market/contracts', { productType: 'USDT-FUTURES' });
    const map = new Map<string, BitgetContractSpec>();
    for (const c of Array.isArray(data) ? data : []) {
      if (!c?.symbol) continue;
      const symbol = fromBitgetSymbol(c.symbol);
      map.set(symbol, {
        symbol,
        pricePlace: parseInt(c.pricePlace || '2', 10),
        priceEndStep: parseFloat(c.priceEndStep || '1') || 1,
        volumePlace: parseInt(c.volumePlace || '3', 10),
        sizeMultiplier: parseFloat(c.sizeMultiplier || '0') || Math.pow(10, -parseInt(c.volumePlace || '3', 10)),
        minTradeNum: parseFloat(c.minTradeNum || '0') || 0,
        minTradeUSDT: parseFloat(c.minTradeUSDT || '5') || 5,
        maxLever: parseInt(c.maxLever || '125', 10),
      });
    }
    contractSpecCache = { ts: Date.now(), map };
    return map;
  }

  private async getContractSpec(symbol: string): Promise<BitgetContractSpec | undefined> {
    try {
      return (await this.loadContractSpecs()).get(fromBitgetSymbol(symbol));
    } catch {
      return undefined;
    }
  }

  private formatSize(qty: number, spec?: BitgetContractSpec): string {
    if (!spec) return Number(qty.toFixed(4)).toString();
    const stepped = Math.floor(qty / spec.sizeMultiplier + 1e-9) * spec.sizeMultiplier;
    return stepped.toFixed(spec.volumePlace);
  }

  private formatPrice(price: number, spec?: BitgetContractSpec): string {
    if (!spec) return Number(price.toPrecision(8)).toString();
    const tick = spec.priceEndStep * Math.pow(10, -spec.pricePlace);
    const stepped = Math.round(price / tick) * tick;
    return stepped.toFixed(spec.pricePlace);
  }

  /**
   * Contracts / Exchange Info. Endpoint: /api/v2/mix/market/contracts
   */
  async getContracts(): Promise<BitgetSymbolFilter[]> {
    try {
      const data = await this.publicRequest<any[]>('/api/v2/mix/market/contracts', { productType: 'USDT-FUTURES' });
      if (!Array.isArray(data)) return [];

      return data
        .filter((c: any) => c.symbolStatus === 'normal' || c.status === 'online')
        .map((c: any) => {
          const normSym = fromBitgetSymbol(c.symbol);
          const pricePlace = parseInt(c.pricePlace || '2', 10);
          const volumePlace = parseInt(c.volumePlace || '3', 10);
          const tick = (parseFloat(c.priceEndStep || '1') || 1) * Math.pow(10, -pricePlace);
          return {
            symbol: normSym,
            baseAsset: c.baseCoin || normSym.replace('USDT', ''),
            quoteAsset: 'USDT',
            status: 'TRADING',
            pricePrecision: pricePlace,
            quantityPrecision: volumePlace,
            tickSize: tick.toFixed(pricePlace),
            stepSize: c.sizeMultiplier ? String(c.sizeMultiplier) : Math.pow(10, -volumePlace).toFixed(volumePlace),
            minQty: c.minTradeNum ? String(c.minTradeNum) : '0.001',
            maxQty: c.maxMarketOrderQty || c.maxOrderQty || '1000000',
            minNotional: c.minTradeUSDT ? String(c.minTradeUSDT) : '5',
          };
        });
    } catch (err) {
      if (!(err instanceof BitgetCircuitOpenError)) console.warn(`[BitgetService.getContracts] ${describeBitgetError(err)}`);
      return [];
    }
  }

  // ─── Positions ───────────────────────────────────────────────────────────

  async fetchOpenPositions(): Promise<BitgetPosition[]> {
    return this.getOpenPositions();
  }

  /**
   * Open positions straight from Bitget. Endpoint: /api/v2/mix/position/all-position
   */
  async getOpenPositions(): Promise<BitgetPosition[]> {
    const data = await this.request<any[]>('GET', '/api/v2/mix/position/all-position', {
      productType: this.productType,
      marginCoin: this.marginCoin,
    });
    if (!Array.isArray(data)) return [];

    const hedge = data.some((p) => p.posMode === 'hedge_mode');
    if (data.length > 0) {
      posModeCache.set(this.envKey, { mode: hedge ? 'hedge_mode' : 'one_way_mode', ts: Date.now() });
    }

    return data
      .filter((p) => parseFloat(p.total || '0') > 0)
      .map((p) => {
        const total = parseFloat(p.total || '0');
        const holdSide = String(p.holdSide || 'long').toLowerCase() === 'short' ? 'short' : 'long';
        const isLong = holdSide === 'long';
        const sl = parseFloat(p.stopLoss || '0');
        const tp = parseFloat(p.takeProfit || '0');
        const entryPrice = BitgetFuturesService.parseNum(p.openPriceAvg, p.averageOpenPrice);
        const leverage = parseInt(p.leverage, 10) || 1;
        const rawMargin = BitgetFuturesService.parseNum(p.marginSize, p.margin);
        const computedMargin =
          rawMargin > 0
            ? rawMargin
            : entryPrice > 0 && leverage > 0
              ? (total * entryPrice) / leverage
              : 0;
        return {
          symbol: fromBitgetSymbol(p.symbol),
          rawSymbol: p.symbol,
          positionAmt: isLong ? total : -total,
          entryPrice,
          markPrice: BitgetFuturesService.parseNum(p.markPrice),
          unRealizedProfit: BitgetFuturesService.parseNum(p.unrealizedPL),
          liquidationPrice: BitgetFuturesService.parseNum(p.liquidationPrice),
          leverage,
          marginType: String(p.marginMode || 'isolated').toLowerCase() === 'crossed' ? 'cross' : 'isolated',
          isolatedMargin: computedMargin,
          holdSide,
          total,
          available: BitgetFuturesService.parseNum(p.available),
          stopLossPrice: sl > 0 ? sl : undefined,
          takeProfit1Price: tp > 0 ? tp : undefined,
          openTime: p.cTime ? parseInt(p.cTime, 10) : undefined,
        } as BitgetPosition;
      });
  }

  // ─── Orders ──────────────────────────────────────────────────────────────

  async placeOrder(params: any): Promise<any> {
    return this.placeMarketOrder(params);
  }

  /**
   * Market order entry/exit with preset SL/TP. Endpoint: /api/v2/mix/order/place-order
   * Handles both one-way mode (reduceOnly) and hedge mode (tradeSide open/close).
   * Throws on any Bitget rejection — no simulated fallback.
   */
  async placeMarketOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    size: string;
    price?: number;
    margin?: number;
    leverage?: number;
    marginMode?: 'isolated' | 'crossed';
    stopLossPrice?: number;
    takeProfitPrice?: number;
    reduceOnly?: boolean;
    clientOid?: string;
  }): Promise<any> {
    const symbol = fromBitgetSymbol(params.symbol);
    const isBuy = params.side === 'BUY';
    const marginMode = params.marginMode || 'isolated';
    const spec = await this.getContractSpec(symbol);
    const posMode = await this.getPositionMode(symbol);
    const hedge = posMode === 'hedge_mode';

    const size = this.formatSize(parseFloat(params.size), spec);
    if (!(parseFloat(size) > 0)) {
      throw new BitgetApiError('INVALID_SIZE', `Ukuran order ${params.size} terlalu kecil untuk ${symbol} (step ${spec?.sizeMultiplier ?? '?'}).`);
    }
    if (spec && !params.reduceOnly && parseFloat(size) < spec.minTradeNum) {
      throw new BitgetApiError('INVALID_SIZE', `Ukuran order ${size} di bawah minimum ${spec.minTradeNum} untuk ${symbol}.`);
    }

    if (!params.reduceOnly) {
      try {
        await this.setMarginMode(symbol, marginMode);
      } catch (err) {
        // Fails when a position/order already exists for the symbol — keep current mode.
        console.warn(`[BitgetService] set-margin-mode ${symbol}: ${describeBitgetError(err)}`);
      }
      if (params.leverage && params.leverage > 0) {
        const lev = spec ? Math.min(params.leverage, spec.maxLever) : params.leverage;
        try {
          await this.setLeverage(symbol, lev, hedge && marginMode === 'isolated' ? (isBuy ? 'long' : 'short') : undefined);
        } catch (err) {
          console.warn(`[BitgetService] set-leverage ${symbol}: ${describeBitgetError(err)}`);
        }
      }
    }

    const buildOrderBody = (isHedge: boolean): Record<string, any> => {
      const body: Record<string, any> = {
        symbol,
        productType: this.productType,
        marginMode,
        marginCoin: this.marginCoin,
        size,
        orderType: 'market',
        clientOid: params.clientOid || `nx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      };

      if (isHedge) {
        // Hedge mode: closing a long = side 'buy' + tradeSide 'close'; closing a short = side 'sell' + tradeSide 'close'.
        // Callers pass the *opposite* side for reduceOnly closes (SELL closes long), so flip it here.
        body.tradeSide = params.reduceOnly ? 'close' : 'open';
        body.side = params.reduceOnly ? (isBuy ? 'sell' : 'buy') : (isBuy ? 'buy' : 'sell');
      } else {
        body.side = isBuy ? 'buy' : 'sell';
        if (params.reduceOnly) body.reduceOnly = 'YES';
      }

      if (!params.reduceOnly) {
        if (params.stopLossPrice && params.stopLossPrice > 0) {
          body.presetStopLossPrice = this.formatPrice(params.stopLossPrice, spec);
        }
        if (params.takeProfitPrice && params.takeProfitPrice > 0) {
          body.presetStopSurplusPrice = this.formatPrice(params.takeProfitPrice, spec);
        }
      }
      return body;
    };

    let body = buildOrderBody(hedge);
    try {
      const data = await this.request('POST', '/api/v2/mix/order/place-order', {}, body);
      return { ...data, symbol, size, side: body.side, tradeSide: body.tradeSide, posMode };
    } catch (err: any) {
      if (err instanceof BitgetApiError && err.code === '40774') {
        const flippedMode: BitgetPosMode = hedge ? 'one_way_mode' : 'hedge_mode';
        posModeCache.set(this.envKey, { mode: flippedMode, ts: Date.now() });
        body = buildOrderBody(!hedge);
        const data = await this.request('POST', '/api/v2/mix/order/place-order', {}, body);
        return { ...data, symbol, size, side: body.side, tradeSide: body.tradeSide, posMode: flippedMode };
      }
      throw err;
    }
  }

  /**
   * Partial close via reduce-only market order.
   */
  async partialClosePosition(symbol: string, currentPositionAmt: number, quantityToClose?: number): Promise<any> {
    const standardSymbol = fromBitgetSymbol(symbol);
    const totalAbs = Math.abs(currentPositionAmt);
    if (!(totalAbs > 0)) throw new BitgetApiError('NO_POSITION', `Tidak ada posisi ${standardSymbol} untuk ditutup.`);
    const closeQty = quantityToClose && quantityToClose > 0 ? Math.min(quantityToClose, totalAbs) : totalAbs * 0.5;

    if (closeQty >= totalAbs - 1e-12) {
      return this.closeFullPosition(standardSymbol, currentPositionAmt > 0 ? 'long' : 'short');
    }

    return this.placeMarketOrder({
      symbol: standardSymbol,
      side: currentPositionAmt > 0 ? 'SELL' : 'BUY',
      size: String(closeQty),
      reduceOnly: true,
    });
  }

  /**
   * Close entire position at market. Endpoint: /api/v2/mix/order/close-positions
   */
  async closeFullPosition(symbol: string, holdSide?: 'long' | 'short'): Promise<any> {
    const standardSymbol = fromBitgetSymbol(symbol);
    const posMode = await this.getPositionMode(standardSymbol);
    const body: Record<string, any> = { symbol: standardSymbol, productType: this.productType };
    if (posMode === 'hedge_mode' && holdSide) body.holdSide = holdSide;
    const data = await this.request<any>('POST', '/api/v2/mix/order/close-positions', {}, body);
    const failures = Array.isArray(data?.failureList) ? data.failureList : [];
    if (failures.length > 0 && !(Array.isArray(data?.successList) && data.successList.length > 0)) {
      const f = failures[0];
      throw new BitgetApiError(String(f.errorCode || 'CLOSE_FAILED'), `Bitget close ${standardSymbol} gagal: ${f.errorMsg || 'unknown error'}`);
    }
    return data;
  }

  /**
   * Closes a position completely or partially.
   */
  async closePosition(symbol: string, currentPositionAmt: number, quantityToClose?: number): Promise<any> {
    const standardSymbol = fromBitgetSymbol(symbol);
    let amt = Number(currentPositionAmt) || 0;
    if (amt === 0) {
      const live = (await this.getOpenPositions()).find((p) => p.symbol === standardSymbol);
      if (!live) throw new BitgetApiError('NO_POSITION', `Tidak ada posisi ${standardSymbol} di Bitget.`);
      amt = live.positionAmt;
    }
    return this.partialClosePosition(standardSymbol, amt, quantityToClose || Math.abs(amt));
  }

  /**
   * Updates the position-level stop loss (or take profit) on Bitget.
   * Primary: /api/v2/mix/order/place-pos-tpsl (replaces existing position TP/SL)
   * Fallback: /api/v2/mix/order/place-tpsl-order
   */
  async updateTrailingStop(params: {
    symbol: string;
    holdSide: 'long' | 'short';
    triggerPrice: number;
    planType?: 'pos_loss' | 'pos_profit' | 'moving_plan';
    size?: string;
  }): Promise<any> {
    const symbol = fromBitgetSymbol(params.symbol);
    if (!(params.triggerPrice > 0)) throw new BitgetApiError('INVALID_PRICE', 'Trigger price harus > 0.');
    const spec = await this.getContractSpec(symbol);
    const posMode = await this.getPositionMode(symbol);
    const holdSide = posMode === 'hedge_mode'
      ? params.holdSide
      : (params.holdSide === 'long' ? 'buy' : 'sell');
    const price = this.formatPrice(params.triggerPrice, spec);
    const planType = params.planType || 'pos_loss';

    if (planType === 'pos_loss' || planType === 'pos_profit') {
      const body: Record<string, any> = {
        symbol,
        productType: this.productType,
        marginCoin: this.marginCoin,
        holdSide,
      };
      if (planType === 'pos_loss') {
        body.stopLossTriggerPrice = price;
        body.stopLossTriggerType = 'mark_price';
      } else {
        body.stopSurplusTriggerPrice = price;
        body.stopSurplusTriggerType = 'mark_price';
      }
      try {
        return await this.request('POST', '/api/v2/mix/order/place-pos-tpsl', {}, body);
      } catch (err) {
        if (err instanceof BitgetCircuitOpenError) throw err;
        console.warn(`[BitgetService] place-pos-tpsl ${symbol}: ${describeBitgetError(err)} — trying place-tpsl-order`);
      }
    }

    const body: Record<string, any> = {
      symbol,
      productType: this.productType,
      marginCoin: this.marginCoin,
      planType,
      triggerPrice: price,
      triggerType: 'mark_price',
      holdSide,
    };
    if (params.size) body.size = this.formatSize(parseFloat(params.size), spec);
    return this.request('POST', '/api/v2/mix/order/place-tpsl-order', {}, body);
  }

  /**
   * Emergency panic close — closes every live Bitget position.
   * Endpoint: /api/v2/mix/order/close-positions
   */
  async panicCloseAll(_positions?: BitgetPosition[]): Promise<{ closedCount: number; errors: string[] }> {
    // Always use live exchange positions as the source of truth.
    const activePositions = await this.getOpenPositions();
    let closedCount = 0;
    const errors: string[] = [];

    for (const pos of activePositions) {
      try {
        await this.closeFullPosition(pos.symbol, pos.holdSide);
        closedCount++;
      } catch (closeErr: any) {
        try {
          await this.placeMarketOrder({
            symbol: pos.symbol,
            side: pos.positionAmt > 0 ? 'SELL' : 'BUY',
            size: String(Math.abs(pos.positionAmt)),
            reduceOnly: true,
          });
          closedCount++;
        } catch (mktErr: any) {
          errors.push(`${pos.symbol}: ${mktErr?.message || closeErr?.message}`);
        }
      }
    }

    return { closedCount, errors };
  }

  /**
   * Helper to build WebSocket stream URL
   */
  getWsUrl(isPrivate: boolean = false): string {
    if (this.accountType === 'DEMO') {
      return isPrivate ? BITGET_WS_PAP_PRIVATE : BITGET_WS_PAP_PUBLIC;
    }
    return isPrivate ? BITGET_WS_PRIVATE : BITGET_WS_PUBLIC;
  }
}

/** Syncs local clock offset with Bitget server time (cached 5 min). Never throws. */
async function syncServerTime(baseUrl: string): Promise<void> {
  if (Date.now() - serverTimeSyncedAt < SERVER_TIME_TTL_MS) return;
  serverTimeSyncedAt = Date.now();
  try {
    const t0 = Date.now();
    const res = await fetch(`${baseUrl}/api/v2/public/time`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const json: any = await res.json();
    const serverTime = parseInt(json?.data?.serverTime, 10);
    if (serverTime > 0) {
      const t1 = Date.now();
      serverTimeOffsetMs = serverTime - Math.round((t0 + t1) / 2);
      if (Math.abs(serverTimeOffsetMs) > 5000) {
        console.warn(`[BitgetService] Local clock drift ${serverTimeOffsetMs}ms vs Bitget — compensating.`);
      }
    }
  } catch {
    // keep previous offset
  }
}
