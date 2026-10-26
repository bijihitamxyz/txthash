import { NextRequest, NextResponse } from 'next/server';
import { BinanceFuturesClient } from '@/core/binanceClient';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action') || 'EXCHANGE_INFO';
    const isTestnet = searchParams.get('isTestnet') === 'true';

    const client = new BinanceFuturesClient('', '', isTestnet);

    if (action === 'EXCHANGE_INFO') {
      const symbols = await client.getExchangeInfo();
      return NextResponse.json({ success: true, count: symbols.length, symbols });
    }

    if (action === 'TICKERS') {
      const tickers = await client.get24hrTickers();
      return NextResponse.json({ success: true, tickers });
    }

    if (action === 'KLINES') {
      const symbol = searchParams.get('symbol') || 'BTCUSDT';
      const interval = searchParams.get('interval') || '5m';
      const limit = parseInt(searchParams.get('limit') || '100', 10);
      const klines = await client.getKlines(symbol, interval, limit);
      return NextResponse.json({ success: true, symbol, interval, klines });
    }

    if (action === 'PREMIUM_INDEX') {
      const symbol = searchParams.get('symbol') || 'BTCUSDT';
      const premium = await client.getPremiumIndex(symbol);
      return NextResponse.json({ success: true, premium });
    }

    return NextResponse.json({ success: false, error: `Unknown GET action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error('[API GET /api/binance ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Binance API error' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const action = body.action;
    const { apiKey = '', apiSecret = '', isTestnet = false } = body.credentials || {};

    const client = new BinanceFuturesClient(apiKey, apiSecret, isTestnet);

    // 1. TEST CONNECTION
    if (action === 'TEST_CONNECTION') {
      if (!apiKey || !apiSecret) {
        return NextResponse.json({
          success: false,
          message: 'Binance API Key and API Secret are required.',
        });
      }
      try {
        const startTime = Date.now();
        const account = await client.getAccountInfo();
        const latencyMs = Date.now() - startTime;
        return NextResponse.json({
          success: true,
          message: `Connected successfully to Binance Futures (${isTestnet ? 'Testnet' : 'Live Real'}).`,
          balance: account.totalWalletBalance,
          availableBalance: account.availableBalance,
          openPositionsCount: account.positions.length,
          latencyMs,
        });
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          message: `Binance authentication error: ${err.message || 'Invalid API Key/Secret or permission denied'}`,
        });
      }
    }

    // 2. GET ACCOUNT INFO
    if (action === 'ACCOUNT') {
      const account = await client.getAccountInfo();
      return NextResponse.json({ success: true, data: account });
    }

    // 3. SET LEVERAGE
    if (action === 'SET_LEVERAGE') {
      const { symbol, leverage } = body.payload || {};
      const res = await client.setLeverage(symbol, leverage);
      return NextResponse.json({ success: true, data: res });
    }

    // 4. SET MARGIN TYPE
    if (action === 'SET_MARGIN_TYPE') {
      const { symbol, marginType } = body.payload || {};
      const res = await client.setMarginType(symbol, marginType);
      return NextResponse.json({ success: true, data: res });
    }

    // 5. PLACE ORDER
    if (action === 'ORDER') {
      const { symbol, side, type, quantity, price, stopPrice, reduceOnly } = body.payload || {};
      const order = await client.placeOrder({
        symbol,
        side,
        type,
        quantity,
        price,
        stopPrice,
        reduceOnly,
      });
      return NextResponse.json({ success: true, data: order });
    }

    // 6. CLOSE / PARTIAL CLOSE POSITION
    if (action === 'CLOSE_POSITION') {
      const { symbol, positionAmt, quantityToClose } = body.payload || {};
      const res = await client.closePosition(symbol, positionAmt, quantityToClose);
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Unknown POST action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error('[API POST /api/binance ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Binance operation failed' },
      { status: 500 }
    );
  }
}
