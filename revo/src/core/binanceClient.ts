import crypto from 'crypto';

export interface BinanceSymbolFilter {
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

export interface Binance24hTicker {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  quoteVolume: number;
}

export interface BinanceKline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BinancePosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unRealizedProfit: number;
  liquidationPrice: number;
  leverage: number;
  marginType: 'isolated' | 'cross';
  isolatedMargin: number;
  // Local tracking for 60% partial close & breakeven lock
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

export interface BinanceAccountInfo {
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
  totalMarginBalance: number;
  availableBalance: number;
  positions: BinancePosition[];
  connected: boolean;
  isTestnet: boolean;
}

export const BINANCE_REST_BASE = 'https://fapi.binance.com';
export const BINANCE_TESTNET_REST_BASE = 'https://testnet.binancefuture.com';

export const BINANCE_WS_BASE = 'wss://fstream.binance.com/ws';
export const BINANCE_TESTNET_WS_BASE = 'wss://stream.binancefuture.com/ws';

// In-memory cache for exchange info & tickers keyed by environment (REAL vs DEMO)
const cachedExchangeInfo = new Map<'REAL' | 'DEMO', { timestamp: number; symbols: BinanceSymbolFilter[] }>();
const CACHE_EXCHANGE_INFO_TTL = 30 * 60 * 1000; // 30 minutes

const cachedTickers = new Map<'REAL' | 'DEMO', { timestamp: number; data: Record<string, Binance24hTicker> }>();
const CACHE_TICKERS_TTL = 3 * 1000; // 3 seconds

// Server time offset cache per baseUrl to prevent -1021 timestamp errors on drifting clocks
const serverTimeOffsetCache = new Map<string, { offsetMs: number; syncedAt: number }>();
const SERVER_TIME_TTL_MS = 5 * 60 * 1000;

// Hedge mode cache per apiKey + env
const hedgeModeCache = new Map<string, { isHedge: boolean; syncedAt: number }>();
const HEDGE_MODE_TTL_MS = 60 * 1000;

// Fallback high-liquid L2 & Altcoin specs in case Binance API is temporarily unreachable
export const FALLBACK_SYMBOLS: BinanceSymbolFilter[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 3, tickSize: '0.10', stepSize: '0.001', minQty: '0.001', maxQty: '1000', minNotional: '5' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 3, tickSize: '0.01', stepSize: '0.001', minQty: '0.001', maxQty: '10000', minNotional: '5' },
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 2, tickSize: '0.01', stepSize: '0.01', minQty: '0.01', maxQty: '10000', minNotional: '5' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 2, tickSize: '0.01', stepSize: '0.01', minQty: '0.01', maxQty: '100000', minNotional: '5' },
  { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 1, tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'ARBUSDT', baseAsset: 'ARB', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 1, tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'OPUSDT', baseAsset: 'OP', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 1, tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'SUIUSDT', baseAsset: 'SUI', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 1, tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'SEIUSDT', baseAsset: 'SEI', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 0, tickSize: '0.0001', stepSize: '1', minQty: '1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'APTUSDT', baseAsset: 'APT', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 3, quantityPrecision: 2, tickSize: '0.001', stepSize: '0.01', minQty: '0.01', maxQty: '100000', minNotional: '5' },
  { symbol: 'FETUSDT', baseAsset: 'FET', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 0, tickSize: '0.0001', stepSize: '1', minQty: '1', maxQty: '1000000', minNotional: '5' },
  { symbol: 'RENDERUSDT', baseAsset: 'RENDER', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 3, quantityPrecision: 1, tickSize: '0.001', stepSize: '0.1', minQty: '0.1', maxQty: '100000', minNotional: '5' },
  { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 5, quantityPrecision: 0, tickSize: '0.00001', stepSize: '1', minQty: '1', maxQty: '10000000', minNotional: '5' },
  { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 7, quantityPrecision: 0, tickSize: '0.0000001', stepSize: '1', minQty: '1', maxQty: '100000000', minNotional: '5' },
  { symbol: 'WIFUSDT', baseAsset: 'WIF', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 4, quantityPrecision: 1, tickSize: '0.0001', stepSize: '0.1', minQty: '0.1', maxQty: '1000000', minNotional: '5' },
];

/**
 * Rounds a quantity down to the symbol's exact stepSize and quantityPrecision
 * to guarantee that Binance never throws LOT_SIZE rejection.
 */
export function formatQuantityByStepSize(qty: number, stepSizeStr: string, precision: number): string {
  const step = parseFloat(stepSizeStr) || Math.pow(10, -precision);
  if (step <= 0) return qty.toFixed(precision);
  const factor = 1 / step;
  const stepped = Math.floor(qty * factor + 1e-9) / factor;
  return stepped.toFixed(precision);
}

/**
 * Rounds a price to the symbol's exact tickSize and pricePrecision
 */
export function formatPriceByTickSize(price: number, tickSizeStr: string, precision: number): string {
  const tick = parseFloat(tickSizeStr) || Math.pow(10, -precision);
  if (tick <= 0) return price.toFixed(precision);
  const factor = 1 / tick;
  const ticked = Math.round(price * factor) / factor;
  return ticked.toFixed(precision);
}

/**
 * Signs query string or body with HMAC-SHA256
 */
export function signBinanceRequest(params: Record<string, any>, apiSecret: string): string {
  const queryString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  return `${queryString}&signature=${signature}`;
}

export class BinanceFuturesClient {
  private apiKey: string;
  private apiSecret: string;
  private isTestnet: boolean;
  private baseUrl: string;

  constructor(apiKey: string = '', apiSecret: string = '', isTestnet: boolean = false) {
    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.isTestnet = isTestnet;
    this.baseUrl = isTestnet ? BINANCE_TESTNET_REST_BASE : BINANCE_REST_BASE;
  }

  private get envKey(): 'REAL' | 'DEMO' {
    return this.isTestnet ? 'DEMO' : 'REAL';
  }

  private async syncServerTime(force: boolean = false): Promise<number> {
    const cached = serverTimeOffsetCache.get(this.baseUrl);
    if (!force && cached && Date.now() - cached.syncedAt < SERVER_TIME_TTL_MS) {
      return cached.offsetMs;
    }
    try {
      const t0 = Date.now();
      const res = await fetch(`${this.baseUrl}/fapi/v1/time`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        const t1 = Date.now();
        if (typeof data.serverTime === 'number') {
          const offsetMs = data.serverTime - Math.round((t0 + t1) / 2);
          serverTimeOffsetCache.set(this.baseUrl, { offsetMs, syncedAt: t1 });
          return offsetMs;
        }
      }
    } catch {}
    return cached?.offsetMs ?? 0;
  }

  private async signedFetch(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, any> = {},
    timeoutMs: number = 7000
  ): Promise<{ ok: boolean; status: number; json: any }> {
    let offsetMs = await this.syncServerTime(false);

    for (let attempt = 0; attempt < 2; attempt++) {
      const timestamp = Date.now() + offsetMs;
      const fullParams = { ...params, timestamp, recvWindow: 10000 };
      const signedQuery = signBinanceRequest(fullParams, this.apiSecret);
      const url = method === 'GET' || method === 'DELETE'
        ? `${this.baseUrl}${path}?${signedQuery}`
        : `${this.baseUrl}${path}`;

      const res = await fetch(url, {
        method,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': method === 'POST' ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: method === 'POST' ? signedQuery : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok && json?.code === -1021 && attempt === 0) {
        offsetMs = await this.syncServerTime(true);
        continue;
      }
      return { ok: res.ok, status: res.status, json };
    }

    throw new Error('Binance signed request failed after timestamp resync');
  }

  /**
   * Fetches all active USDT Perpetual contracts and parses their precision & step filters.
   */
  async getExchangeInfo(): Promise<BinanceSymbolFilter[]> {
    const now = Date.now();
    const cached = cachedExchangeInfo.get(this.envKey);
    if (cached && now - cached.timestamp < CACHE_EXCHANGE_INFO_TTL) {
      return cached.symbols;
    }

    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(7000),
      });

      if (!res.ok) {
        throw new Error(`Binance exchangeInfo HTTP ${res.status}`);
      }

      const data = await res.json();
      const rawSymbols = data.symbols || [];

      // Filter: USDT perpetual contracts currently TRADING
      const usdtPerps: BinanceSymbolFilter[] = rawSymbols
        .filter((s: any) => s.status === 'TRADING' && s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT')
        .map((s: any) => {
          const lotSize = s.filters?.find((f: any) => f.filterType === 'LOT_SIZE') || {};
          const priceFilter = s.filters?.find((f: any) => f.filterType === 'PRICE_FILTER') || {};
          const minNotionalFilter = s.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL') || {};

          return {
            symbol: s.symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            status: s.status,
            pricePrecision: s.pricePrecision ?? 2,
            quantityPrecision: s.quantityPrecision ?? 1,
            tickSize: priceFilter.tickSize || '0.01',
            stepSize: lotSize.stepSize || '0.1',
            minQty: lotSize.minQty || '0.1',
            maxQty: lotSize.maxQty || '1000000',
            minNotional: minNotionalFilter.notional || '5',
          };
        });

      if (usdtPerps.length > 0) {
        cachedExchangeInfo.set(this.envKey, { timestamp: now, symbols: usdtPerps });
        return usdtPerps;
      }
    } catch (err) {
      console.warn(`[BinanceClient.getExchangeInfo:${this.envKey}] Failed to fetch live exchange info, using fallback list:`, err);
    }

    return cached?.symbols || FALLBACK_SYMBOLS;
  }

  /**
   * Fetches 24hr tickers for all symbols with volume & 24h change %.
   */
  async get24hrTickers(): Promise<Record<string, Binance24hTicker>> {
    const now = Date.now();
    const cached = cachedTickers.get(this.envKey);
    if (cached && now - cached.timestamp < CACHE_TICKERS_TTL) {
      return cached.data;
    }

    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/ticker/24hr`, {
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) throw new Error(`Binance ticker/24hr HTTP ${res.status}`);
      const array: any[] = await res.json();
      const map: Record<string, Binance24hTicker> = {};

      for (const item of array) {
        if (item.symbol.endsWith('USDT')) {
          map[item.symbol] = {
            symbol: item.symbol,
            lastPrice: parseFloat(item.lastPrice || '0'),
            priceChangePercent: parseFloat(item.priceChangePercent || '0'),
            highPrice: parseFloat(item.highPrice || '0'),
            lowPrice: parseFloat(item.lowPrice || '0'),
            volume: parseFloat(item.volume || '0'),
            quoteVolume: parseFloat(item.quoteVolume || '0'),
          };
        }
      }

      cachedTickers.set(this.envKey, { timestamp: now, data: map });
      return map;
    } catch (err) {
      console.warn(`[BinanceClient.get24hrTickers:${this.envKey}] Failed, returning cached/empty map:`, err);
      return cached?.data || {};
    }
  }

  /**
   * Fetches candlestick klines for charting and technical analysis
   */
  async getKlines(symbol: string, interval: string = '5m', limit: number = 100): Promise<BinanceKline[]> {
    // Map standard timeframe
    let binanceInterval = interval.toLowerCase();
    if (interval === 'M1') binanceInterval = '1m';
    else if (interval === 'M5') binanceInterval = '5m';
    else if (interval === 'M15') binanceInterval = '15m';
    else if (interval === 'H1') binanceInterval = '1h';

    const url = `${this.baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new Error(`Binance klines HTTP ${res.status}: ${res.statusText}`);
    }

    const raw = await res.json();
    return raw.map((k: any) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
  }

  /**
   * Fetches live Premium Index (funding rate & mark price)
   */
  async getPremiumIndex(symbol?: string): Promise<{ symbol: string; markPrice: number; lastFundingRate: number; nextFundingTime: number }> {
    const url = symbol
      ? `${this.baseUrl}/fapi/v1/premiumIndex?symbol=${symbol}`
      : `${this.baseUrl}/fapi/v1/premiumIndex?symbol=BTCUSDT`;
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Binance premiumIndex HTTP ${res.status}`);
    const data = await res.json();
    return {
      symbol: data.symbol,
      markPrice: parseFloat(data.markPrice || '0'),
      lastFundingRate: parseFloat(data.lastFundingRate || '0'),
      nextFundingTime: data.nextFundingTime || 0,
    };
  }

  /**
   * Checks whether account uses Hedge Mode (dualSidePosition=true) vs One-Way Mode.
   */
  async isHedgeMode(): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret) return false;
    const key = `${this.apiKey}:${this.envKey}`;
    const cached = hedgeModeCache.get(key);
    if (cached && Date.now() - cached.syncedAt < HEDGE_MODE_TTL_MS) {
      return cached.isHedge;
    }
    try {
      const { ok, json } = await this.signedFetch('GET', '/fapi/v1/positionSide/dual', {}, 5000);
      if (ok && typeof json?.dualSidePosition === 'boolean') {
        hedgeModeCache.set(key, { isHedge: json.dualSidePosition, syncedAt: Date.now() });
        return json.dualSidePosition;
      }
    } catch {}
    return cached?.isHedge ?? false;
  }

  /**
   * Fetches authenticated account info: USDT balance, margin, open positions
   */
  async getAccountInfo(): Promise<BinanceAccountInfo> {
    if (!this.apiKey || !this.apiSecret) {
      return {
        totalWalletBalance: 0,
        totalUnrealizedProfit: 0,
        totalMarginBalance: 0,
        availableBalance: 0,
        positions: [],
        connected: false,
        isTestnet: this.isTestnet,
      };
    }

    const { ok, status, json: data } = await this.signedFetch('GET', '/fapi/v2/account', {}, 6000);

    if (!ok) {
      throw new Error(data?.msg || `Binance account error HTTP ${status}`);
    }

    const usdtAsset = (data.assets || []).find((a: any) => a.asset === 'USDT') || {};
    const walletBalance = parseFloat(usdtAsset.walletBalance || data.totalWalletBalance || '0');
    const unrealizedProfit = parseFloat(usdtAsset.unrealizedProfit || data.totalUnrealizedProfit || '0');
    const marginBalance = parseFloat(usdtAsset.marginBalance || data.totalMarginBalance || '0');
    const availableBalance = parseFloat(usdtAsset.availableBalance || data.availableBalance || '0');

    // Extract active open positions (positionAmt !== 0)
    const activePositions: BinancePosition[] = (data.positions || [])
      .filter((p: any) => parseFloat(p.positionAmt || '0') !== 0)
      .map((p: any) => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice || '0'),
        unRealizedProfit: parseFloat(p.unrealizedProfit || '0'),
        liquidationPrice: parseFloat(p.liquidationPrice || '0'),
        leverage: parseInt(p.leverage, 10) || 10,
        marginType: p.isolated ? 'isolated' : 'cross',
        isolatedMargin: parseFloat(p.isolatedMargin || '0'),
      }));

    return {
      totalWalletBalance: walletBalance,
      totalUnrealizedProfit: unrealizedProfit,
      totalMarginBalance: marginBalance,
      availableBalance,
      positions: activePositions,
      connected: true,
      isTestnet: this.isTestnet,
    };
  }

  /**
   * Sets leverage for a given symbol
   */
  async setLeverage(symbol: string, leverage: number): Promise<{ symbol: string; leverage: number }> {
    const { ok, status, json } = await this.signedFetch(
      'POST',
      '/fapi/v1/leverage',
      { symbol, leverage: Math.max(1, Math.round(leverage)) },
      6000
    );

    if (!ok) {
      throw new Error(json?.msg || `Set leverage failed HTTP ${status}`);
    }

    return { symbol: json.symbol, leverage: json.leverage };
  }

  /**
   * Sets margin type (ISOLATED vs CROSSED)
   */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<boolean> {
    const { ok, status, json: err } = await this.signedFetch(
      'POST',
      '/fapi/v1/marginType',
      { symbol, marginType },
      6000
    );

    if (!ok) {
      // -4046: No need to change margin type; -4048: Margin type cannot be changed if there exists position
      if (err?.code === -4046 || err?.code === -4048) return true;
      throw new Error(err?.msg || `Set margin type failed HTTP ${status}`);
    }

    return true;
  }

  /**
   * Places an order (MARKET / LIMIT / STOP_MARKET / TAKE_PROFIT_MARKET)
   */
  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type?: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    reduceOnly?: boolean;
    closePosition?: boolean;
    price?: string;
    stopPrice?: string;
    positionSide?: 'BOTH' | 'LONG' | 'SHORT';
  }): Promise<any> {
    const orderType = (params.type || 'MARKET').toUpperCase();
    const hedge = await this.isHedgeMode();

    const orderPayload: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: orderType,
    };

    if (params.quantity) {
      orderPayload.quantity = params.quantity;
    }

    if (hedge) {
      orderPayload.positionSide = params.positionSide || (
        params.reduceOnly || params.closePosition
          ? (params.side === 'SELL' ? 'LONG' : 'SHORT')
          : (params.side === 'BUY' ? 'LONG' : 'SHORT')
      );
    } else if (params.reduceOnly && !params.closePosition) {
      orderPayload.reduceOnly = 'true';
    }

    if (params.closePosition) {
      orderPayload.closePosition = 'true';
    }

    if (params.price && orderType === 'LIMIT') {
      orderPayload.price = params.price;
      orderPayload.timeInForce = 'GTC';
    }
    if (params.stopPrice && orderType !== 'MARKET' && orderType !== 'LIMIT') {
      orderPayload.stopPrice = params.stopPrice;
      orderPayload.workingType = 'MARK_PRICE';
    }

    const { ok, status, json } = await this.signedFetch('POST', '/fapi/v1/order', orderPayload, 7000);

    if (!ok) {
      throw new Error(json?.msg || `Order failed HTTP ${status}`);
    }

    return json;
  }

  /**
   * Sets margin mode + leverage, places MARKET entry, and attaches best-effort SL/TP orders.
   */
  async placeMarketOrderWithProtection(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: string;
    leverage?: number;
    marginMode?: 'ISOLATED' | 'CROSSED';
    stopLossPrice?: number;
    takeProfitPrice?: number;
  }): Promise<any> {
    if (params.marginMode) {
      await this.setMarginType(params.symbol, params.marginMode).catch(() => {});
    }
    if (params.leverage && params.leverage > 0) {
      await this.setLeverage(params.symbol, params.leverage).catch(() => {});
    }

    const entryOrder = await this.placeOrder({
      symbol: params.symbol,
      side: params.side,
      type: 'MARKET',
      quantity: params.quantity,
    });

    const filters = await this.getExchangeInfo().catch(() => FALLBACK_SYMBOLS);
    const filter = filters.find((f) => f.symbol === params.symbol) || FALLBACK_SYMBOLS.find((f) => f.symbol === params.symbol);
    const closeSide: 'BUY' | 'SELL' = params.side === 'BUY' ? 'SELL' : 'BUY';
    const positionSide: 'LONG' | 'SHORT' = params.side === 'BUY' ? 'LONG' : 'SHORT';

    if (params.stopLossPrice && params.stopLossPrice > 0) {
      const slStr = filter
        ? formatPriceByTickSize(params.stopLossPrice, filter.tickSize, filter.pricePrecision)
        : String(params.stopLossPrice);
      await this.placeOrder({
        symbol: params.symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: slStr,
        closePosition: true,
        positionSide,
      }).catch((e) => {
        console.warn(`[BinanceClient] Non-fatal SL order warning on ${params.symbol}:`, e?.message);
      });
    }

    if (params.takeProfitPrice && params.takeProfitPrice > 0) {
      const tpStr = filter
        ? formatPriceByTickSize(params.takeProfitPrice, filter.tickSize, filter.pricePrecision)
        : String(params.takeProfitPrice);
      await this.placeOrder({
        symbol: params.symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: tpStr,
        closePosition: true,
        positionSide,
      }).catch((e) => {
        console.warn(`[BinanceClient] Non-fatal TP order warning on ${params.symbol}:`, e?.message);
      });
    }

    return entryOrder;
  }

  /**
   * Closes a position (or partial closes) via reduceOnly market order
   */
  async closePosition(symbol: string, currentPositionAmt: number, quantityToClose?: number): Promise<any> {
    let amt = Number(currentPositionAmt) || 0;
    if (amt === 0) {
      const account = await this.getAccountInfo();
      const livePos = account.positions.find((p) => p.symbol === symbol && Math.abs(p.positionAmt) > 0);
      if (!livePos) {
        throw new Error(`No open position found on Binance for ${symbol}.`);
      }
      amt = livePos.positionAmt;
    }

    const isLong = amt > 0;
    const side = isLong ? 'SELL' : 'BUY';
    const totalAbsQty = Math.abs(amt);
    const qty = quantityToClose && quantityToClose > 0 && quantityToClose < totalAbsQty ? quantityToClose : totalAbsQty;

    // Get filter for stepSize formatting
    const filters = await this.getExchangeInfo();
    const filter = filters.find((f) => f.symbol === symbol);
    const formattedQty = filter
      ? formatQuantityByStepSize(qty, filter.stepSize, filter.quantityPrecision)
      : qty.toString();

    return this.placeOrder({
      symbol,
      side,
      type: 'MARKET',
      quantity: formattedQty,
      reduceOnly: true,
      positionSide: isLong ? 'LONG' : 'SHORT',
    });
  }
}
