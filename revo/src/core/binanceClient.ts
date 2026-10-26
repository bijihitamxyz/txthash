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

// In-memory cache for exchange info & tickers to prevent rate limits
let cachedExchangeInfo: { timestamp: number; symbols: BinanceSymbolFilter[] } | null = null;
const CACHE_EXCHANGE_INFO_TTL = 30 * 60 * 1000; // 30 minutes

let cachedTickers: { timestamp: number; data: Record<string, Binance24hTicker> } | null = null;
const CACHE_TICKERS_TTL = 3 * 1000; // 3 seconds

// Fallback high-liquid L2 & Altcoin specs in case Binance API is temporarily unreachable
export const FALLBACK_SYMBOLS: BinanceSymbolFilter[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 3, tickSize: '0.10', stepSize: '0.001', minQty: '0.001', maxQty: '1000', minNotional: '5' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 3, tickSize: '0.01', stepSize: '0.001', minQty: '0.001', maxQty: '10000', minNotional: '5' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING', pricePrecision: 2, quantityPrecision: 2, tickSize: '0.01', stepSize: '0.01', minQty: '0.01', maxQty: '100000', minNotional: '5' },
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

  /**
   * Fetches all active USDT Perpetual contracts and parses their precision & step filters.
   */
  async getExchangeInfo(): Promise<BinanceSymbolFilter[]> {
    const now = Date.now();
    if (cachedExchangeInfo && now - cachedExchangeInfo.timestamp < CACHE_EXCHANGE_INFO_TTL) {
      return cachedExchangeInfo.symbols;
    }

    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`, {
        headers: { 'Content-Type': 'application/json' },
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
        cachedExchangeInfo = { timestamp: now, symbols: usdtPerps };
        return usdtPerps;
      }
    } catch (err) {
      console.warn('[BinanceClient.getExchangeInfo] Failed to fetch live exchange info, using fallback list:', err);
    }

    return FALLBACK_SYMBOLS;
  }

  /**
   * Fetches 24hr tickers for all symbols with volume & 24h change %.
   */
  async get24hrTickers(): Promise<Record<string, Binance24hTicker>> {
    const now = Date.now();
    if (cachedTickers && now - cachedTickers.timestamp < CACHE_TICKERS_TTL) {
      return cachedTickers.data;
    }

    try {
      const res = await fetch(`${this.baseUrl}/fapi/v1/ticker/24hr`, {
        headers: { 'Content-Type': 'application/json' },
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

      cachedTickers = { timestamp: now, data: map };
      return map;
    } catch (err) {
      console.warn('[BinanceClient.get24hrTickers] Failed, returning empty map:', err);
      return cachedTickers?.data || {};
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
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });

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
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
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

    const timestamp = Date.now();
    const params = { timestamp, recvWindow: 5000 };
    const signedQuery = signBinanceRequest(params, this.apiSecret);
    const url = `${this.baseUrl}/fapi/v2/account?${signedQuery}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.msg || `Binance account error HTTP ${res.status}`);
    }

    const data = await res.json();

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
    const timestamp = Date.now();
    const params = { symbol, leverage, timestamp, recvWindow: 5000 };
    const signedQuery = signBinanceRequest(params, this.apiSecret);
    const url = `${this.baseUrl}/fapi/v1/leverage`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: signedQuery,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.msg || `Set leverage failed HTTP ${res.status}`);
    }

    const json = await res.json();
    return { symbol: json.symbol, leverage: json.leverage };
  }

  /**
   * Sets margin type (ISOLATED vs CROSSED)
   */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<boolean> {
    const timestamp = Date.now();
    const params = { symbol, marginType, timestamp, recvWindow: 5000 };
    const signedQuery = signBinanceRequest(params, this.apiSecret);
    const url = `${this.baseUrl}/fapi/v1/marginType`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: signedQuery,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Code -4046 means margin type is already set to that type, ignore safely
      if (err.code === -4046) return true;
      throw new Error(err.msg || `Set margin type failed HTTP ${res.status}`);
    }

    return true;
  }

  /**
   * Places an order (MARKET / LIMIT / STOP_MARKET)
   */
  async placeOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type?: 'MARKET' | 'LIMIT' | 'STOP_MARKET';
    quantity: string;
    reduceOnly?: boolean;
    price?: string;
    stopPrice?: string;
  }): Promise<any> {
    const timestamp = Date.now();
    const orderPayload: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type || 'MARKET',
      quantity: params.quantity,
      timestamp,
      recvWindow: 5000,
    };

    if (params.reduceOnly) {
      orderPayload.reduceOnly = 'true';
    }
    if (params.price) {
      orderPayload.price = params.price;
      orderPayload.timeInForce = 'GTC';
    }
    if (params.stopPrice) {
      orderPayload.stopPrice = params.stopPrice;
    }

    const signedQuery = signBinanceRequest(orderPayload, this.apiSecret);
    const url = `${this.baseUrl}/fapi/v1/order`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: signedQuery,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.msg || `Order failed HTTP ${res.status}`);
    }

    return await res.json();
  }

  /**
   * Closes a position (or partial closes) via reduceOnly market order
   */
  async closePosition(symbol: string, currentPositionAmt: number, quantityToClose?: number): Promise<any> {
    const isLong = currentPositionAmt > 0;
    const side = isLong ? 'SELL' : 'BUY';
    const totalAbsQty = Math.abs(currentPositionAmt);
    const qty = quantityToClose && quantityToClose < totalAbsQty ? quantityToClose : totalAbsQty;

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
    });
  }
}
