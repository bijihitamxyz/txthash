/**
 * Bitget V2 Futures API Adapter (src/services/bitgetService.ts)
 * Comprehensive REST & WebSocket adapter supporting Bitget USDT-M Futures (REAL & DEMO).
 *
 * REST Base URL: https://api.bitget.com
 * REAL: productType = 'USDT-FUTURES', marginCoin = 'USDT'
 * DEMO: Primary attempt: productType = 'SUSDT-FUTURES', marginCoin = 'SUSDT', without 'paptrading' header.
 *       Fallback on 40099: productType = 'USDT-FUTURES', marginCoin = 'USDT' with 'paptrading': '1' header.
 *       Working strategy is cached in memory so subsequent polling requests hit 200 OK on first call.
 * Auth: HMAC-SHA256 Base64 signature over:
 *       timestamp + method.toUpperCase() + requestPath + (queryString ? '?' + queryString : '') + bodyString
 * Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE, Content-Type, locale, paptrading
 */

import crypto from 'crypto';

declare global {
  // eslint-disable-next-line no-var
  var __BITGET_SIMULATED_POSITIONS__: Map<string, BitgetPosition> | undefined;
}

function getBitgetSimulatedMap(): Map<string, BitgetPosition> {
  if (!globalThis.__BITGET_SIMULATED_POSITIONS__) {
    globalThis.__BITGET_SIMULATED_POSITIONS__ = new Map<string, BitgetPosition>();
    try {
      const { readDataFile } = eval("require")('@/lib/dataStore');
      const saved = readDataFile('bitget_paper_positions.json', '[]');
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) {
          for (const pos of arr) {
            if (pos && pos.symbol) {
              globalThis.__BITGET_SIMULATED_POSITIONS__.set(pos.symbol, pos);
            }
          }
        }
      }
    } catch {}
  }
  return globalThis.__BITGET_SIMULATED_POSITIONS__;
}

export function getSimulatedPositions(): BitgetPosition[] {
  return Array.from(getBitgetSimulatedMap().values());
}

export function getSimulatedPosition(symbol: string): BitgetPosition | undefined {
  const norm = fromBitgetSymbol(symbol);
  return getBitgetSimulatedMap().get(norm);
}

export function saveSimulatedPosition(pos: BitgetPosition): void {
  const norm = fromBitgetSymbol(pos.symbol);
  const map = getBitgetSimulatedMap();
  map.set(norm, { ...pos, symbol: norm });
  persistSimulatedPositions();
}

export function removeSimulatedPosition(symbol: string): void {
  const norm = fromBitgetSymbol(symbol);
  const map = getBitgetSimulatedMap();
  map.delete(norm);
  persistSimulatedPositions();
}

export function clearAllSimulatedPositions(): void {
  const map = getBitgetSimulatedMap();
  map.clear();
  persistSimulatedPositions();
}

function persistSimulatedPositions(): void {
  try {
    const { writeDataFileAsync } = eval("require")('@/lib/dataStore');
    const arr = Array.from(getBitgetSimulatedMap().values());
    writeDataFileAsync('bitget_paper_positions.json', JSON.stringify(arr)).catch(() => {});
  } catch {}
}

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

/**
 * Formats quantity to the symbol step size
 */
export function formatBitgetQuantity(qty: number, stepSizeStr: string = '0.001', precision: number = 3): string {
  const step = parseFloat(stepSizeStr) || Math.pow(10, -precision);
  if (step <= 0) return qty.toFixed(precision);
  const factor = 1 / step;
  const stepped = Math.floor(qty * factor + 1e-9) / factor;
  return stepped.toFixed(precision);
}

/**
 * Maps standard symbol (e.g. BTCUSDT) to Bitget contract symbol (e.g. BTCSUSDT in Demo SUSDT-FUTURES).
 */
export function toBitgetSymbol(symbol: string, isDemo: boolean = false): string {
  if (!symbol) return '';
  const clean = symbol.trim().toUpperCase();
  if (isDemo) {
    if (clean.endsWith('SUSDT')) return clean;
    if (clean.endsWith('USDT')) {
      return clean.slice(0, -4) + 'SUSDT';
    }
    return clean;
  } else {
    if (clean.endsWith('SUSDT')) {
      return clean.slice(0, -5) + 'USDT';
    }
    return clean;
  }
}

/**
 * Normalizes Bitget contract symbols (e.g. BTCSUSDT or SBTCSUSDT) back to standard BTCUSDT.
 */
export function fromBitgetSymbol(symbol: string): string {
  if (!symbol) return '';
  let clean = symbol.trim().toUpperCase();
  // Strip leading 'S' if prefix demo (e.g. SBTCSUSDT -> BTCSUSDT)
  if (clean.startsWith('S') && clean.endsWith('SUSDT') && clean.length > 6) {
    clean = clean.slice(1);
  }
  if (clean.endsWith('SUSDT')) {
    clean = clean.slice(0, -5) + 'USDT';
  }
  return clean;
}

export interface BitgetDemoStrategy {
  productType: string;
  marginCoin: string;
  sendPaptrading: boolean;
}

export const DEFAULT_BITGET_DEMO_STRATEGY: BitgetDemoStrategy = {
  productType: 'USDT-FUTURES',
  marginCoin: 'USDT',
  sendPaptrading: true,
};

export const FALLBACK_BITGET_DEMO_STRATEGY: BitgetDemoStrategy = {
  productType: 'SUSDT-FUTURES',
  marginCoin: 'SUSDT',
  sendPaptrading: false,
};

export const TERTIARY_BITGET_DEMO_STRATEGY: BitgetDemoStrategy = {
  productType: 'USDT-FUTURES',
  marginCoin: 'USDT',
  sendPaptrading: false,
};

/**
 * Module-level in-memory cache for remembered working DEMO strategies.
 * Keyed by API key (or '__default__' when no API key is specified).
 */
const demoStrategyCache = new Map<string, BitgetDemoStrategy>();

export function getBitgetDemoStrategyCache(): Map<string, BitgetDemoStrategy> {
  return demoStrategyCache;
}

export function clearBitgetDemoStrategyCache(): void {
  demoStrategyCache.clear();
}

export class BitgetFuturesService {
  public readonly apiKey: string;
  public readonly secretKey: string;
  public readonly passphrase: string;
  private _accountType: 'REAL' | 'DEMO' = 'DEMO';
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

  public static getCachedStrategy(apiKey?: string): BitgetDemoStrategy | undefined {
    const key = apiKey && apiKey.trim() ? apiKey.trim() : '__default__';
    return demoStrategyCache.get(key);
  }

  public static setCachedStrategy(strategy: BitgetDemoStrategy, apiKey?: string): void {
    const key = apiKey && apiKey.trim() ? apiKey.trim() : '__default__';
    demoStrategyCache.set(key, { ...strategy });
  }

  public static clearStrategyCache(): void {
    demoStrategyCache.clear();
  }

  constructor(
    apiKey: string = '',
    secretKey: string = '',
    passphrase: string = '',
    accountType: 'REAL' | 'DEMO' | boolean = 'DEMO'
  ) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.passphrase = passphrase.trim();
    this._accountType = (accountType === true || accountType === 'DEMO') ? 'DEMO' : 'REAL';
    this.baseUrl = BITGET_REST_BASE;

    this.syncEnvironment();
  }

  private getCacheKey(): string {
    return this.apiKey && this.apiKey.trim() ? this.apiKey.trim() : '__default__';
  }

  public getWorkingDemoStrategy(): BitgetDemoStrategy {
    const key = this.getCacheKey();
    return demoStrategyCache.get(key) || { ...DEFAULT_BITGET_DEMO_STRATEGY };
  }

  public saveWorkingDemoStrategy(strategy: BitgetDemoStrategy): void {
    const key = this.getCacheKey();
    demoStrategyCache.set(key, { ...strategy });
  }

  private syncEnvironment(): void {
    if (this._accountType === 'DEMO') {
      const working = this.getWorkingDemoStrategy();
      this.productType = working.productType;
      this.marginCoin = working.marginCoin;
    } else {
      this.productType = 'USDT-FUTURES';
      this.marginCoin = 'USDT';
    }
  }

  public toBitgetSymbol(symbol: string): string {
    return toBitgetSymbol(symbol, this.productType === 'SUSDT-FUTURES' || this.isTestnet);
  }

  public fromBitgetSymbol(symbol: string): string {
    return fromBitgetSymbol(symbol);
  }

  private getDemoStrategyCandidates(): BitgetDemoStrategy[] {
    const primary = this.getWorkingDemoStrategy();
    const presets: BitgetDemoStrategy[] = [
      DEFAULT_BITGET_DEMO_STRATEGY,   // productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT', sendPaptrading: false
      FALLBACK_BITGET_DEMO_STRATEGY,  // productType: 'USDT-FUTURES', marginCoin: 'USDT', sendPaptrading: true
      TERTIARY_BITGET_DEMO_STRATEGY,  // productType: 'USDT-FUTURES', marginCoin: 'USDT', sendPaptrading: false
    ];

    const candidates: BitgetDemoStrategy[] = [{ ...primary }];
    for (const preset of presets) {
      const exists = candidates.some(
        (c) =>
          c.productType === preset.productType &&
          c.marginCoin === preset.marginCoin &&
          c.sendPaptrading === preset.sendPaptrading
      );
      if (!exists) {
        candidates.push({ ...preset });
      }
    }
    return candidates;
  }

  /**
   * Generates authenticated headers for Bitget V2 API requests
   */
  private getHeaders(
    method: string,
    requestPath: string,
    queryString: string = '',
    bodyString: string = '',
    sendPaptradingHeader: boolean = false
  ): Record<string, string> {
    const timestamp = Date.now().toString();
    const signature = signBitgetV2(
      timestamp,
      method,
      requestPath,
      queryString,
      bodyString,
      this.secretKey
    );

    const headers: Record<string, string> = {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': this.passphrase,
      'Content-Type': 'application/json',
      'locale': 'en-US',
    };

    if (sendPaptradingHeader) {
      headers['paptrading'] = '1';
    }

    return headers;
  }

  /**
   * Replaces productType, marginCoin, and aligns symbol in query or body parameter objects
   */
  private replaceEnvironmentParams(
    params: Record<string, any> | undefined,
    productType: string,
    marginCoin: string
  ): Record<string, any> | undefined {
    if (!params) return params;
    const updated = { ...params };
    if ('productType' in updated) {
      updated.productType = productType;
    }
    if ('marginCoin' in updated) {
      updated.marginCoin = marginCoin;
    }
    if ('symbol' in updated && typeof updated.symbol === 'string') {
      const isSusdt = marginCoin === 'SUSDT' || productType === 'SUSDT-FUTURES';
      updated.symbol = toBitgetSymbol(updated.symbol, isSusdt);
    }
    return updated;
  }

  /**
   * Checks if a Bitget response represents code 40099 ("exchange environment is incorrect")
   */
  private isCode40099(json: any, rawText: string): boolean {
    const code = json?.code !== undefined ? String(json.code) : '';
    if (code === '40099') return true;
    const msg = String(json?.msg || json?.message || '');
    if (msg.toLowerCase().includes('exchange environment is incorrect')) return true;
    if (rawText && (rawText.includes('"code":"40099"') || rawText.includes('"code":40099') || rawText.includes('40099'))) {
      return true;
    }
    return false;
  }

  /**
   * Executes a single low-level HTTP request to Bitget API
   */
  private async executeHttpRequest(
    method: 'GET' | 'POST' | 'DELETE',
    requestPath: string,
    queryParams: Record<string, any> = {},
    bodyData?: Record<string, any>,
    sendPaptradingHeader: boolean = false
  ): Promise<{ ok: boolean; status: number; json: any; rawText: string }> {
    const urlParams = new URLSearchParams();
    for (const [key, val] of Object.entries(queryParams)) {
      if (val !== undefined && val !== null && val !== '') {
        urlParams.append(key, String(val));
      }
    }
    const queryString = urlParams.toString();
    const fullUrl = queryString ? `${this.baseUrl}${requestPath}?${queryString}` : `${this.baseUrl}${requestPath}`;
    const bodyString = bodyData ? JSON.stringify(bodyData) : '';

    const headers = this.apiKey && this.secretKey
      ? this.getHeaders(method, requestPath, queryString, bodyString, sendPaptradingHeader)
      : {
          'Content-Type': 'application/json',
          'locale': 'en-US',
          ...(sendPaptradingHeader ? { 'paptrading': '1' } : {}),
        };

    const res = await fetch(fullUrl, {
      method,
      headers,
      body: method === 'GET' ? undefined : (bodyString || undefined),
    });

    let rawText = '';
    let json: any = null;
    try {
      rawText = await res.text();
      json = JSON.parse(rawText);
    } catch {
      // Body is not valid JSON
    }

    return {
      ok: res.ok,
      status: res.status,
      json,
      rawText,
    };
  }

  /**
   * Generic request executor with Bitget V2 DEMO environment routing & automatic fallback
   */
  public async request<T = any>(
    method: 'GET' | 'POST' | 'DELETE',
    requestPath: string,
    queryParams: Record<string, any> = {},
    bodyData?: Record<string, any>
  ): Promise<T> {
    // For public market endpoints with an explicit productType (e.g. USDT-FUTURES tickers/klines/contracts),
    // execute directly without demo strategy swapping
    if (requestPath.startsWith('/api/v2/mix/market/') && queryParams.productType) {
      const res = await this.executeHttpRequest(method, requestPath, queryParams, bodyData, false);
      if (res.ok && res.json && (res.json.code === '00000' || res.json.code === 0)) {
        return res.json.data as T;
      }
      if (res.json?.data) return res.json.data as T;
      throw new Error(res.json?.msg || res.json?.message || `Bitget API market error (${res.status})`);
    }

    const isDemo = (this.mode === 'DEMO' || this.accountType === 'DEMO' || this.isTestnet === true);

    const candidates = isDemo
      ? this.getDemoStrategyCandidates()
      : [{ productType: 'USDT-FUTURES', marginCoin: 'USDT', sendPaptrading: false }];

    let lastRes: { ok: boolean; status: number; json: any; rawText: string } | null = null;
    let successfulStrategy: BitgetDemoStrategy | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const strat = candidates[i];
      this.productType = strat.productType;
      this.marginCoin = strat.marginCoin;

      const curQueryParams = this.replaceEnvironmentParams(queryParams, strat.productType, strat.marginCoin) || {};
      const curBodyData = this.replaceEnvironmentParams(bodyData, strat.productType, strat.marginCoin);

      const res = await this.executeHttpRequest(
        method,
        requestPath,
        curQueryParams,
        curBodyData,
        strat.sendPaptrading
      );
      lastRes = res;

      // Check if response indicates environment or marginCoin mismatch (e.g. 40099 or currency as margin)
      const isMarginCoinMismatch = res.rawText && (
        res.rawText.includes('does not support SUSDT currency as margin') ||
        res.rawText.includes('currency as margin') ||
        res.rawText.includes('exchange environment is incorrect') ||
        res.rawText.includes('40099')
      );
      const isEnvError = this.isCode40099(res.json, res.rawText) || isMarginCoinMismatch;

      if (!isEnvError && (res.ok || res.status < 400)) {
        successfulStrategy = strat;
        break;
      }

      // If error occurred and another fallback candidate is available, log warning and retry
      if (i < candidates.length - 1) {
        const nextStrat = candidates[i + 1];
        console.warn(
          `[BitgetService] Received Bitget environment error ` +
          `with [productType='${strat.productType}', marginCoin='${strat.marginCoin}', paptrading=${strat.sendPaptrading ? "'1'" : 'none'}]. ` +
          `Falling back to [productType='${nextStrat.productType}', marginCoin='${nextStrat.marginCoin}', paptrading=${nextStrat.sendPaptrading ? "'1'" : 'none'}]...`
        );
      }
    }

    // Cache the working DEMO strategy in memory for subsequent polling requests
    if (isDemo && successfulStrategy && lastRes?.ok) {
      this.saveWorkingDemoStrategy(successfulStrategy);
    }

    if (!lastRes) {
      throw new Error('Bitget request failed: No response received');
    }

    if (!lastRes.ok) {
      const errText = lastRes.json?.msg || lastRes.rawText || `HTTP ${lastRes.status}`;
      throw new Error(`Bitget HTTP ${lastRes.status}: ${errText}`);
    }

    if (lastRes.json && lastRes.json.code && lastRes.json.code !== '00000') {
      throw new Error(`Bitget error [${lastRes.json.code}]: ${lastRes.json.msg || 'Operation failed'}`);
    }

    return (lastRes.json?.data !== undefined ? lastRes.json.data : lastRes.json) as T;
  }

  /**
   * Account balance & verification (Method 1: account balance verification)
   * Endpoint: /api/v2/mix/account/accounts
   */
  async getAccountInfo(): Promise<BitgetAccountInfo> {
    if (!this.apiKey || !this.secretKey || !this.passphrase) {
      return {
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        totalMarginBalance: 0,
        availableBalance: 0,
        positions: [],
        connected: false,
        accountType: this.accountType,
      };
    }

    try {
      const accounts = await this.request<any[]>('GET', '/api/v2/mix/account/accounts', {
        productType: this.productType,
      });

      const matched = Array.isArray(accounts)
        ? (accounts.find((a: any) => a.marginCoin?.toUpperCase() === this.marginCoin.toUpperCase()) ||
           accounts.find((a: any) => a.marginCoin?.toUpperCase() === 'SUSDT') ||
           accounts.find((a: any) => a.marginCoin?.toUpperCase() === 'USDT') ||
           accounts[0] || {})
        : accounts || {};

      const equity = parseFloat(matched.accountEquity || matched.equity || matched.available || '0');
      const available = parseFloat(matched.available || matched.maxOpenPosAvailable || '0');
      const unrealizedPnl = parseFloat(matched.unrealizedPL || matched.crossUnrealizedPL || '0');
      const marginBalance = parseFloat(matched.marginBalance || matched.accountEquity || '0');

      let positions: BitgetPosition[] = [];
      try {
        positions = await this.getOpenPositions();
      } catch (posErr) {
        console.warn('[BitgetService.getAccountInfo] Positions warning:', posErr);
      }

      let totalUnrealized = unrealizedPnl;
      if (positions.length > 0) {
        totalUnrealized = positions.reduce((sum, p) => sum + (p.unRealizedProfit || 0), 0);
      }
      const finalBal = equity > 0 ? equity : (this.accountType === 'DEMO' ? 1000.00 : 0);
      const finalMarginBal = (marginBalance > 0 ? marginBalance : finalBal) + totalUnrealized;

      return {
        totalWalletBalance: Number(finalBal.toFixed(2)),
        totalUnrealizedProfit: Number(totalUnrealized.toFixed(2)),
        totalMarginBalance: Number(finalMarginBal.toFixed(2)),
        availableBalance: Number((available > 0 ? available : finalBal).toFixed(2)),
        positions,
        connected: true,
        accountType: this.accountType,
      };
    } catch (err: any) {
      throw new Error(err.message || 'Bitget account verification failed');
    }
  }

  /**
   * Kline/Candle fetching (Method 2: kline/candle fetching)
   * Endpoint: /api/v2/mix/market/candles
   * ALWAYS uses standard USDT symbol (e.g. BTCUSDT, SOLUSDT) with productType='USDT-FUTURES'
   * so scanning NEVER throws "Parameter *SUSDT does not exist"
   */
  async getKlines(symbol: string, interval: string = '5m', limit: number = 100): Promise<BitgetKline[]> {
    // Map intervals to Bitget granularity: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d
    let granularity = '5m';
    const norm = interval.toLowerCase();
    if (norm === '1m' || norm === 'm1') granularity = '1m';
    else if (norm === '5m' || norm === 'm5') granularity = '5m';
    else if (norm === '15m' || norm === 'm15') granularity = '15m';
    else if (norm === '30m' || norm === 'm30') granularity = '30m';
    else if (norm === '1h' || norm === 'h1') granularity = '1h';
    else if (norm === '4h' || norm === 'h4') granularity = '4h';
    else if (norm === '1d' || norm === 'd1') granularity = '1D';

    const standardSymbol = fromBitgetSymbol(symbol);

    try {
      const data = await this.request<any[][]>('GET', '/api/v2/mix/market/candles', {
        symbol: standardSymbol,
        productType: 'USDT-FUTURES',
        granularity,
        limit: Math.min(limit, 200),
      });

      if (Array.isArray(data) && data.length > 0) {
        const klines: BitgetKline[] = data.map((row) => ({
          timestamp: parseInt(row[0], 10),
          open: parseFloat(row[1]),
          high: parseFloat(row[2]),
          low: parseFloat(row[3]),
          close: parseFloat(row[4]),
          volume: parseFloat(row[5] || '0'),
        }));
        klines.sort((a, b) => a.timestamp - b.timestamp);
        return klines;
      }
    } catch (err: any) {
      console.warn(`[BitgetService.getKlines] Primary market candle fetch error for ${standardSymbol}:`, err?.message || err);
    }

    return [];
  }

  /**
   * Open positions fetching (Method 3: open positions fetching)
   * Endpoint: /api/v2/mix/position/all-position
   * In DEMO mode, merges remote positions with the Persistent Simulated/Paper Position Ledger
   */
  async fetchOpenPositions(): Promise<BitgetPosition[]> {
    return this.getOpenPositions();
  }

  async getOpenPositions(): Promise<BitgetPosition[]> {
    const isDemo = this.accountType === 'DEMO' || this.isTestnet;
    let remotePositions: BitgetPosition[] = [];

    if (this.apiKey && this.secretKey) {
      try {
        const data = await this.request<any[]>('GET', '/api/v2/mix/position/all-position', {
          productType: this.productType,
          marginCoin: this.marginCoin,
        });

        if (Array.isArray(data)) {
          const active = data.filter((p) => parseFloat(p.total || p.available || '0') > 0);

          remotePositions = active.map((p) => {
            const total = parseFloat(p.total || '0');
            const holdSide = (p.holdSide || 'long').toLowerCase() as 'long' | 'short';
            const isLong = holdSide === 'long';

            return {
              symbol: fromBitgetSymbol(p.symbol),
              rawSymbol: p.symbol,
              positionAmt: isLong ? total : -total,
              entryPrice: parseFloat(p.openPriceAvg || p.averageOpenPrice || '0'),
              markPrice: parseFloat(p.markPrice || '0'),
              unRealizedProfit: parseFloat(p.unrealizedPL || '0'),
              liquidationPrice: parseFloat(p.liquidationPrice || '0'),
              leverage: parseInt(p.leverage, 10) || 10,
              marginType: (p.marginMode || 'isolated').toLowerCase() === 'isolated' ? 'isolated' : 'cross',
              isolatedMargin: parseFloat(p.margin || p.marginSize || '0'),
              holdSide,
              total,
              available: parseFloat(p.available || '0'),
            };
          });
        }
      } catch (err) {
        console.warn('[BitgetService.getOpenPositions] Failed:', err);
      }
    }

    if (!isDemo) {
      return remotePositions;
    }

    // In DEMO mode: Merge with Persistent Simulated/Paper Position Ledger
    const simPositions = getSimulatedPositions();
    if (simPositions.length === 0) {
      return remotePositions;
    }

    // Continuously update markPrice and unRealizedProfit on simulated positions using live tickers
    try {
      const tickers = await this.get24hrTickers();
      for (const sp of simPositions) {
        const t = tickers[sp.symbol];
        if (t && t.lastPrice > 0) {
          sp.markPrice = t.lastPrice;
          const isLong = sp.positionAmt > 0;
          const size = Math.abs(sp.positionAmt);
          sp.unRealizedProfit = Number((isLong ? (t.lastPrice - sp.entryPrice) * size : (sp.entryPrice - t.lastPrice) * size).toFixed(4));
        }
      }
    } catch {}

    const resultMap = new Map<string, BitgetPosition>();
    // First populate with simulated positions
    for (const sp of simPositions) {
      resultMap.set(sp.symbol, { ...sp });
    }
    // Remote positions override/update simulated positions if present on exchange
    for (const rp of remotePositions) {
      const existing = resultMap.get(rp.symbol);
      resultMap.set(rp.symbol, {
        ...rp,
        initialQuantity: existing?.initialQuantity || Math.abs(rp.positionAmt),
        partialClosed: existing?.partialClosed ?? rp.partialClosed,
        isBreakevenLocked: existing?.isBreakevenLocked ?? rp.isBreakevenLocked,
        takeProfit1Price: existing?.takeProfit1Price ?? rp.takeProfit1Price,
        stopLossPrice: existing?.stopLossPrice ?? rp.stopLossPrice,
        trailingStopPrice: existing?.trailingStopPrice ?? rp.trailingStopPrice,
        highestPriceSinceEntry: existing?.highestPriceSinceEntry || rp.entryPrice,
        lowestPriceSinceEntry: existing?.lowestPriceSinceEntry || rp.entryPrice,
      });
    }

    return Array.from(resultMap.values());
  }

  /**
   * Helper to record executed simulated order in paper position ledger when in Demo mode
   */
  private async recordSimulatedOrder(
    params: {
      symbol: string;
      side: 'BUY' | 'SELL';
      size: string;
      marginMode?: 'isolated' | 'crossed';
      stopLossPrice?: number;
      takeProfitPrice?: number;
      reduceOnly?: boolean;
      clientOid?: string;
    },
    standardSymbol: string
  ): Promise<any> {
    const isBuy = params.side === 'BUY';
    const sizeNum = parseFloat(params.size) || 1;

    // If reduceOnly, handle partial or full closure
    if (params.reduceOnly) {
      const existing = getSimulatedPosition(standardSymbol);
      if (existing) {
        const isLong = existing.positionAmt > 0;
        const totalAbs = Math.abs(existing.positionAmt);
        const remaining = totalAbs - sizeNum;
        if (remaining <= 0.0001) {
          removeSimulatedPosition(standardSymbol);
        } else {
          existing.positionAmt = isLong ? remaining : -remaining;
          existing.total = remaining;
          existing.available = remaining;
          existing.partialClosed = true;
          existing.isBreakevenLocked = true;
          saveSimulatedPosition(existing);
        }
      }
      return {
        orderId: `sim_close_${Date.now()}`,
        clientOid: params.clientOid || `bg_sim_${Date.now()}`,
        simulated: true,
      };
    }

    // New open position: use exact live price if passed, or fetch live ticker without aggressive step rounding
    let currentPrice = params.price && params.price > 0 ? params.price : 0;
    if (currentPrice <= 0) {
      try {
        const tickers = await this.get24hrTickers();
        if (tickers[standardSymbol]?.lastPrice && tickers[standardSymbol].lastPrice > 0) {
          currentPrice = tickers[standardSymbol].lastPrice;
        }
      } catch {}
    }
    if (currentPrice <= 0) {
      currentPrice = 1.0;
    }

    const userMargin = typeof params.margin === 'number' && params.margin > 0 ? params.margin : 25.0;
    const userLev = typeof params.leverage === 'number' && params.leverage > 0 ? params.leverage : 10;

    const pos: BitgetPosition = {
      symbol: standardSymbol,
      rawSymbol: standardSymbol,
      positionAmt: isBuy ? sizeNum : -sizeNum,
      entryPrice: currentPrice,
      markPrice: currentPrice,
      unRealizedProfit: 0,
      liquidationPrice: isBuy ? currentPrice * (1 - 0.9 / userLev) : currentPrice * (1 + 0.9 / userLev),
      leverage: userLev,
      marginType: params.marginMode === 'crossed' ? 'cross' : 'isolated',
      isolatedMargin: userMargin,
      holdSide: isBuy ? 'long' : 'short',
      total: sizeNum,
      available: sizeNum,
      initialQuantity: sizeNum,
      partialClosed: false,
      isBreakevenLocked: false,
      stopLossPrice: params.stopLossPrice,
      takeProfit1Price: params.takeProfitPrice,
      highestPriceSinceEntry: currentPrice,
      lowestPriceSinceEntry: currentPrice,
      openTime: Date.now(),
    };

    saveSimulatedPosition(pos);
    console.log(`[BitgetService] Simulated Position Ledger saved ${standardSymbol}: ${params.side} ${sizeNum} @ $${currentPrice} (Margin: $${userMargin}, Lev: ${userLev}x)`);

    return {
      orderId: `sim_${Date.now()}`,
      clientOid: params.clientOid || `bg_sim_${Date.now()}`,
      symbol: standardSymbol,
      simulated: true,
      orderType: 'market',
    };
  }

  /**
   * Alias for placeMarketOrder (Method 4: place order)
   */
  async placeOrder(params: any): Promise<any> {
    return this.placeMarketOrder(params);
  }

  /**
   * Market order entry with SL/TP (Method 4: market order entry with SL/TP)
   * Endpoint: /api/v2/mix/order/place-order
   * In DEMO mode:
   *  Attempt 1 (Unified Demo): productType: 'USDT-FUTURES', symbol: standard ('ETHUSDT'), marginCoin: 'USDT', header 'paptrading': '1'
   *  Attempt 2 (SUSDT Demo Contract): productType: 'SUSDT-FUTURES', symbol: 'ETHSUSDT', marginCoin: 'SUSDT' (NO paptrading header)
   *  Fallback: Persistent Simulated/Paper Position Ledger
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
    const isBuy = params.side === 'BUY';
    const standardSymbol = fromBitgetSymbol(params.symbol);
    const isDemo = this.accountType === 'DEMO' || this.isTestnet;

    if (!this.apiKey || !this.secretKey) {
      return await this.recordSimulatedOrder(params, standardSymbol);
    }

    const baseBody: Record<string, any> = {
      marginMode: params.marginMode || 'isolated',
      size: params.size,
      side: isBuy ? 'buy' : 'sell',
      orderType: 'market',
      tradeSide: params.reduceOnly ? 'close' : 'open',
      reduceOnly: params.reduceOnly ? 'YES' : 'NO',
      clientOid: params.clientOid || `bg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    };

    if (params.stopLossPrice && params.stopLossPrice > 0) {
      baseBody.presetStopLossPrice = params.stopLossPrice.toString();
    }
    if (params.takeProfitPrice && params.takeProfitPrice > 0) {
      baseBody.presetTakeProfitPrice = params.takeProfitPrice.toString();
    }

    if (isDemo) {
      // Attempt 1 (Unified Demo): productType: 'USDT-FUTURES', symbol: standardSymbol ('ETHUSDT'), marginCoin: 'USDT', header 'paptrading': '1'
      try {
        const body1 = {
          ...baseBody,
          productType: 'USDT-FUTURES',
          symbol: standardSymbol,
          marginCoin: 'USDT',
        };
        const res1 = await this.executeHttpRequest('POST', '/api/v2/mix/order/place-order', {}, body1, true);
        if (res1.ok && res1.json && (res1.json.code === '00000' || res1.json.code === 0)) {
          return res1.json.data;
        }
        throw new Error(res1.json?.msg || res1.json?.message || `Bitget HTTP ${res1.status}: ${res1.rawText}`);
      } catch (err1: any) {
        console.warn(`[BitgetService] Demo Attempt 1 (Unified Demo USDT) failed for ${standardSymbol} (${err1?.message}). Trying Attempt 2 (SUSDT Demo Contract)...`);

        // Attempt 2 (SUSDT Demo Contract): convert symbol to S-suffix ('ETHSUSDT', 'BTCSUSDT', 'BNBSUSDT', 'SOLUSDT', 'XRPSUSDT'), productType: 'SUSDT-FUTURES', marginCoin: 'SUSDT' (NO paptrading header)
        try {
          const susdtSymbol = toBitgetSymbol(standardSymbol, true);
          const body2 = {
            ...baseBody,
            productType: 'SUSDT-FUTURES',
            symbol: susdtSymbol,
            marginCoin: 'SUSDT',
          };
          const res2 = await this.executeHttpRequest('POST', '/api/v2/mix/order/place-order', {}, body2, false);
          if (res2.ok && res2.json && (res2.json.code === '00000' || res2.json.code === 0)) {
            return res2.json.data;
          }
          throw new Error(res2.json?.msg || res2.json?.message || `Bitget HTTP ${res2.status}: ${res2.rawText}`);
        } catch (err2: any) {
          console.warn(`[BitgetService] Bitget Demo order error for ${standardSymbol} (${err2?.message}). Fallback to Simulated Position Ledger.`);
          return await this.recordSimulatedOrder(params, standardSymbol);
        }
      }
    } else {
      // Real Live Account
      try {
        const realBody = {
          ...baseBody,
          productType: 'USDT-FUTURES',
          symbol: standardSymbol,
          marginCoin: 'USDT',
        };
        const res = await this.executeHttpRequest('POST', '/api/v2/mix/order/place-order', {}, realBody, false);
        if (res.ok && res.json && (res.json.code === '00000' || res.json.code === 0)) {
          return res.json.data;
        }
        throw new Error(res.json?.msg || res.json?.message || `Bitget HTTP ${res.status}: ${res.rawText}`);
      } catch (realErr: any) {
        throw realErr;
      }
    }
  }

  /**
   * 50% Stage-1 partial close (Method 5: 50% Stage-1 partial close)
   * Submits a market reduceOnly close order for 50% volume and updates simulated ledger
   */
  async partialClosePosition(
    symbol: string,
    currentPositionAmt: number,
    quantityToClose?: number
  ): Promise<any> {
    const standardSymbol = fromBitgetSymbol(symbol);
    const isLong = currentPositionAmt > 0;
    const closeSide = isLong ? 'SELL' : 'BUY';
    const totalAbs = Math.abs(currentPositionAmt);
    const closeQty = quantityToClose && quantityToClose < totalAbs ? quantityToClose : totalAbs * 0.5;
    const formattedSize = closeQty.toFixed(3);

    // Update simulated ledger if position exists there
    const simPos = getSimulatedPosition(standardSymbol);
    if (simPos) {
      const remaining = Math.abs(simPos.positionAmt) - closeQty;
      if (remaining <= 0.0001 || !quantityToClose || quantityToClose >= totalAbs) {
        removeSimulatedPosition(standardSymbol);
      } else {
        const curLong = simPos.positionAmt > 0;
        simPos.positionAmt = curLong ? remaining : -remaining;
        simPos.total = remaining;
        simPos.available = remaining;
        simPos.partialClosed = true;
        simPos.isBreakevenLocked = true;
        saveSimulatedPosition(simPos);
      }
    }

    if (this.apiKey && this.secretKey) {
      try {
        return await this.placeMarketOrder({
          symbol: standardSymbol,
          side: closeSide,
          size: formattedSize,
          reduceOnly: true,
        });
      } catch (err) {
        if (simPos) return { success: true, simulated: true };
        throw err;
      }
    }

    return { success: true, simulated: true };
  }

  /**
   * Closes a position completely or partially (Method 5b)
   */
  async closePosition(
    symbol: string,
    currentPositionAmt: number,
    quantityToClose?: number
  ): Promise<any> {
    return this.partialClosePosition(symbol, currentPositionAmt, quantityToClose || Math.abs(currentPositionAmt));
  }

  /**
   * Stage-2 trailing stop update (Method 6: Stage-2 trailing stop update)
   * Places or updates plan/TPSL trigger orders and updates simulated ledger
   * Endpoint: /api/v2/mix/order/place-tpsl-order
   */
  async updateTrailingStop(params: {
    symbol: string;
    holdSide: 'long' | 'short';
    triggerPrice: number;
    planType?: 'pos_loss' | 'pos_profit' | 'moving_plan';
    size?: string;
  }): Promise<any> {
    const standardSymbol = fromBitgetSymbol(params.symbol);

    // Update simulated ledger if position exists there
    const simPos = getSimulatedPosition(standardSymbol);
    if (simPos) {
      simPos.stopLossPrice = params.triggerPrice;
      simPos.trailingStopPrice = params.triggerPrice;
      saveSimulatedPosition(simPos);
    }

    if (!this.apiKey || !this.secretKey) {
      return { success: true, simulated: true };
    }

    const body: Record<string, any> = {
      symbol: standardSymbol,
      productType: this.productType,
      marginCoin: this.marginCoin,
      planType: params.planType || 'pos_loss',
      triggerPrice: params.triggerPrice.toString(),
      triggerType: 'mark_price',
      holdSide: params.holdSide,
    };

    if (params.size) {
      body.size = params.size;
    }

    try {
      return await this.request('POST', '/api/v2/mix/order/place-tpsl-order', {}, body);
    } catch (err: any) {
      const isDemo = this.productType === 'SUSDT-FUTURES' || this.isTestnet;
      if (isDemo) {
        const altSymbol = toBitgetSymbol(params.symbol, true);
        try {
          return await this.request('POST', '/api/v2/mix/order/place-tpsl-order', {}, { ...body, symbol: altSymbol });
        } catch {
          if (simPos) return { success: true, simulated: true };
        }
      }
      if (simPos) return { success: true, simulated: true };
      throw err;
    }
  }

  /**
   * Emergency panic close (Method 7: emergency panic close)
   * Closes all active positions immediately across exchange & clears simulated ledger
   * Endpoint: /api/v2/mix/order/close-positions
   */
  async panicCloseAll(positions?: BitgetPosition[]): Promise<{ closedCount: number; errors: string[] }> {
    clearAllSimulatedPositions();

    const activePositions = positions || (await this.getOpenPositions());
    let closedCount = 0;
    const errors: string[] = [];

    for (const pos of activePositions) {
      const standardSymbol = fromBitgetSymbol(pos.symbol);
      try {
        await this.request('POST', '/api/v2/mix/order/close-positions', {}, {
          symbol: standardSymbol,
          productType: this.productType,
        });
        closedCount++;
      } catch (batchErr: any) {
        try {
          const isLong = pos.positionAmt > 0;
          await this.placeMarketOrder({
            symbol: standardSymbol,
            side: isLong ? 'SELL' : 'BUY',
            size: Math.abs(pos.positionAmt).toString(),
            reduceOnly: true,
          });
          closedCount++;
        } catch (mktErr: any) {
          errors.push(`${pos.symbol}: ${mktErr.message || batchErr.message}`);
        }
      }
    }

    return { closedCount, errors };
  }

  /**
   * 24h Tickers for all active pairs
   * Endpoint: /api/v2/mix/market/tickers
   * ALWAYS uses USDT-FUTURES so all standard symbols are returned
   */
  async get24hrTickers(): Promise<Record<string, Bitget24hTicker>> {
    try {
      const map: Record<string, Bitget24hTicker> = {};
      const data = await this.request<any[]>('GET', '/api/v2/mix/market/tickers', {
        productType: 'USDT-FUTURES',
      });

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.symbol) {
            const rawPrice = parseFloat(item.lastPr || item.lastPrice || '0');
            const rawChange = parseFloat(item.change24h || item.priceChangePercent || '0');
            // Bitget change24h is a decimal ratio (e.g. -0.00066 -> -0.066%), so multiply by 100 for %
            const priceChangePercent = item.change24h !== undefined ? rawChange * 100 : rawChange;
            const highPrice = parseFloat(item.high24h || '0');
            const lowPrice = parseFloat(item.low24h || '0');
            const volume = parseFloat(item.baseVolume || item.volume || '0');
            const quoteVolume = parseFloat(item.usdtVolume || item.quoteVolume || '0') || (volume * rawPrice);

            const tickerObj: Bitget24hTicker = {
              symbol: item.symbol,
              lastPrice: rawPrice,
              priceChangePercent,
              highPrice,
              lowPrice,
              volume,
              quoteVolume,
            };

            map[item.symbol] = tickerObj;

            // Also index by normalized standard symbol (e.g. BTCUSDT, SOLUSDT)
            const normSym = fromBitgetSymbol(item.symbol);
            if (normSym && normSym !== item.symbol) {
              map[normSym] = {
                ...tickerObj,
                symbol: normSym,
              };
            }
          }
        }
      }

      return map;
    } catch (err) {
      console.warn('[BitgetService.get24hrTickers] Failed:', err);
      return {};
    }
  }

  /**
   * Contracts / Exchange Info
   * Endpoint: /api/v2/mix/market/contracts
   * ALWAYS queries USDT-FUTURES so all 300+ standard contracts are listed
   */
  async getContracts(): Promise<BitgetSymbolFilter[]> {
    try {
      const data = await this.request<any[]>('GET', '/api/v2/mix/market/contracts', {
        productType: 'USDT-FUTURES',
      });

      if (!Array.isArray(data)) return [];

      return data
        .filter((c: any) => c.symbolStatus === 'normal' || c.status === 'online')
        .map((c: any) => {
          const normSym = fromBitgetSymbol(c.symbol);
          return {
            symbol: normSym,
            baseAsset: c.baseCoin ? c.baseCoin.replace(/^S/, '') : normSym.replace('USDT', ''),
            quoteAsset: 'USDT',
            status: 'TRADING',
            pricePrecision: parseInt(c.pricePlace || '2', 10),
            quantityPrecision: parseInt(c.volumePlace || '3', 10),
            tickSize: c.priceEndStep ? (Math.pow(10, -parseInt(c.pricePlace || '2', 10))).toString() : '0.01',
            stepSize: c.sizeMultiplier ? c.sizeMultiplier.toString() : '0.001',
            minQty: c.minTradeNum ? c.minTradeNum.toString() : '0.001',
            maxQty: c.maxTradeNum ? c.maxTradeNum.toString() : '1000000',
            minNotional: '5',
          };
        });
    } catch (err) {
      console.warn('[BitgetService.getContracts] Failed:', err);
      return [];
    }
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
