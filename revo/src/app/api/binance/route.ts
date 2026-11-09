import { NextRequest, NextResponse } from 'next/server';
import { BinanceFuturesClient } from '@/core/binanceClient';
import { BitgetFuturesService } from '@/services/bitgetService';
import { saveServerCryptoVault, loadServerCryptoVault, CryptoVaultData } from '@/lib/cryptoVault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action') || 'EXCHANGE_INFO';

    if (action === 'GET_STATE') {
      const { engineScheduler } = await import('@/lib/engineScheduler');
      const { stateSync } = await import('@/lib/stateSync');
      const state = await stateSync.getRuntimeState();
      const isAuto = engineScheduler.isCryptoAutoTrading() && Boolean(state.cryptoIsAutoTrading);
      return NextResponse.json({
        success: true,
        isAutoTrading: isAuto,
        marginUsdt: state.cryptoMarginUsdt ?? engineScheduler.cryptoMarginUsdt,
        leverage: state.cryptoLeverage ?? engineScheduler.cryptoLeverage,
        marginMode: state.cryptoMarginMode ?? engineScheduler.cryptoMarginMode,
        maxConcurrentCoins: state.cryptoMaxConcurrentCoins ?? engineScheduler.cryptoMaxConcurrentCoins,
      });
    }

    const exchange = (searchParams.get('exchange') || 'BINANCE').toUpperCase();
    const isTestnet = searchParams.get('isTestnet') === 'true' || searchParams.get('accountType') === 'DEMO';
    const accountType: 'REAL' | 'DEMO' = isTestnet ? 'DEMO' : 'REAL';

    if (exchange === 'BITGET') {
      const bitget = new BitgetFuturesService('', '', '', accountType);

      if (action === 'EXCHANGE_INFO') {
        const symbols = await bitget.getContracts();
        return NextResponse.json({ success: true, exchange: 'BITGET', count: symbols.length, symbols });
      }

      if (action === 'TICKERS') {
        const tickers = await bitget.get24hrTickers();
        return NextResponse.json({ success: true, exchange: 'BITGET', tickers });
      }

      if (action === 'KLINES') {
        const symbol = searchParams.get('symbol') || 'BTCUSDT';
        const interval = searchParams.get('interval') || '5m';
        const limit = parseInt(searchParams.get('limit') || '100', 10);
        const klines = await bitget.getKlines(symbol, interval, limit);
        return NextResponse.json({ success: true, exchange: 'BITGET', symbol, interval, klines });
      }
    }

    // Default: Binance
    const client = new BinanceFuturesClient('', '', isTestnet);

    if (action === 'EXCHANGE_INFO') {
      const symbols = await client.getExchangeInfo();
      return NextResponse.json({ success: true, exchange: 'BINANCE', count: symbols.length, symbols });
    }

    if (action === 'TICKERS') {
      const tickers = await client.get24hrTickers();
      return NextResponse.json({ success: true, exchange: 'BINANCE', tickers });
    }

    if (action === 'KLINES') {
      const symbol = searchParams.get('symbol') || 'BTCUSDT';
      const interval = searchParams.get('interval') || '5m';
      const limit = parseInt(searchParams.get('limit') || '100', 10);
      const klines = await client.getKlines(symbol, interval, limit);
      return NextResponse.json({ success: true, exchange: 'BINANCE', symbol, interval, klines });
    }

    if (action === 'PREMIUM_INDEX') {
      const symbol = searchParams.get('symbol') || 'BTCUSDT';
      const premium = await client.getPremiumIndex(symbol);
      return NextResponse.json({ success: true, exchange: 'BINANCE', premium });
    }

    return NextResponse.json({ success: false, error: `Unknown GET action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error('[API GET /api/binance ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Crypto API error' },
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

    if (action === 'SYNC_STATE' || action === 'TOGGLE_AUTO_TRADING') {
      const isAuto = typeof body.isAutoTrading === 'boolean' ? body.isAutoTrading : false;
      const { engineScheduler } = await import('@/lib/engineScheduler');
      engineScheduler.setCryptoAutoTrading(isAuto);

      const marginUsdt = typeof body.marginUsdt === 'number' ? body.marginUsdt : (typeof body.margin === 'number' ? body.margin : undefined);
      const leverage = typeof body.leverage === 'number' ? body.leverage : undefined;
      const marginMode = body.marginMode;
      const maxConcurrentCoins = typeof body.maxConcurrentCoins === 'number' ? body.maxConcurrentCoins : undefined;

      engineScheduler.setCryptoTradeSettings({
        marginUsdt,
        leverage,
        marginMode,
        maxConcurrentCoins,
      });

      const { stateSync } = await import('@/lib/stateSync');
      await stateSync.updateRuntimeState({
        cryptoIsAutoTrading: isAuto,
        cryptoMarginUsdt: marginUsdt,
        cryptoLeverage: leverage,
        cryptoMarginMode: marginMode,
        cryptoMaxConcurrentCoins: maxConcurrentCoins,
      });

      return NextResponse.json({
        success: true,
        isAutoTrading: isAuto,
        marginUsdt: engineScheduler.cryptoMarginUsdt,
        leverage: engineScheduler.cryptoLeverage,
        marginMode: engineScheduler.cryptoMarginMode,
        maxConcurrentCoins: engineScheduler.cryptoMaxConcurrentCoins,
      });
    }

    if (action === 'GET_STATE') {
      const { engineScheduler } = await import('@/lib/engineScheduler');
      const { stateSync } = await import('@/lib/stateSync');
      const state = await stateSync.getRuntimeState();
      const isAuto = engineScheduler.isCryptoAutoTrading() && Boolean(state.cryptoIsAutoTrading);
      return NextResponse.json({
        success: true,
        isAutoTrading: isAuto,
        marginUsdt: state.cryptoMarginUsdt ?? engineScheduler.cryptoMarginUsdt,
        leverage: state.cryptoLeverage ?? engineScheduler.cryptoLeverage,
        marginMode: state.cryptoMarginMode ?? engineScheduler.cryptoMarginMode,
        maxConcurrentCoins: state.cryptoMaxConcurrentCoins ?? engineScheduler.cryptoMaxConcurrentCoins,
      });
    }

    // Handle Server Crypto Vault operations
    if (action === 'LOAD_SERVER_VAULT') {
      const vault = await loadServerCryptoVault();
      return NextResponse.json({ success: true, vault });
    }

    if (action === 'SAVE_SERVER_VAULT') {
      if (body.vault) {
        await saveServerCryptoVault(body.vault as CryptoVaultData);
        return NextResponse.json({ success: true, message: 'Crypto vault saved to server' });
      }
      return NextResponse.json({ success: false, error: 'Missing vault payload' }, { status: 400 });
    }

    const exchange: 'BINANCE' | 'BITGET' = (
      body.exchange ||
      body.credentials?.exchange ||
      (body.credentials?.passphrase ? 'BITGET' : 'BINANCE')
    ).toUpperCase() as 'BINANCE' | 'BITGET';

    const {
      apiKey = '',
      apiSecret = '',
      secretKey = '',
      passphrase = '',
      isTestnet = false,
      accountType: rawAccountType,
    } = body.credentials || {};

    const effectiveSecret = secretKey || apiSecret;
    const accountType: 'REAL' | 'DEMO' = rawAccountType || (isTestnet ? 'DEMO' : 'REAL');

    // 1. TEST CONNECTION (Binance or Bitget)
    if (action === 'TEST_CONNECTION') {
      if (exchange === 'BITGET') {
        if (!apiKey.trim() || !effectiveSecret.trim() || !passphrase.trim()) {
          return NextResponse.json({
            success: false,
            message: 'Bitget API Key, Secret Key, and Passphrase are all required.',
          });
        }

        try {
          const startTime = Date.now();
          const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
          const account = await bitget.getAccountInfo();
          const latencyMs = Date.now() - startTime;

          return NextResponse.json({
            success: true,
            exchange: 'BITGET',
            message: `Connected successfully to Bitget Futures (${accountType === 'REAL' ? 'Live Real' : 'Demo Paper Trading'}).`,
            balance: account.totalWalletBalance,
            availableBalance: account.availableBalance,
            openPositionsCount: account.positions.length,
            latencyMs,
          });
        } catch (err: any) {
          return NextResponse.json({
            success: false,
            exchange: 'BITGET',
            message: `Bitget authentication error: ${err.message || 'Invalid API Key, Secret, or Passphrase'}`,
          });
        }
      }

      // Binance Test Connection
      if (!apiKey.trim() || !effectiveSecret.trim()) {
        return NextResponse.json({
          success: false,
          message: 'Binance API Key and API Secret are required.',
        });
      }

      try {
        const startTime = Date.now();
        const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
        const account = await client.getAccountInfo();
        const latencyMs = Date.now() - startTime;

        return NextResponse.json({
          success: true,
          exchange: 'BINANCE',
          message: `Connected successfully to Binance Futures (${accountType === 'DEMO' ? 'Testnet' : 'Live Real'}).`,
          balance: account.totalWalletBalance,
          availableBalance: account.availableBalance,
          openPositionsCount: account.positions.length,
          latencyMs,
        });
      } catch (err: any) {
        return NextResponse.json({
          success: false,
          exchange: 'BINANCE',
          message: `Binance authentication error: ${err.message || 'Invalid API Key/Secret or permission denied'}`,
        });
      }
    }

    // 2. GET ACCOUNT INFO
    if (action === 'ACCOUNT') {
      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const account = await bitget.getAccountInfo();
        return NextResponse.json({ success: true, exchange: 'BITGET', data: account });
      }

      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const account = await client.getAccountInfo();
      return NextResponse.json({ success: true, exchange: 'BINANCE', data: account });
    }

    // 3. SET LEVERAGE (Binance)
    if (action === 'SET_LEVERAGE') {
      const { symbol, leverage } = body.payload || {};
      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const res = await client.setLeverage(symbol, leverage);
      return NextResponse.json({ success: true, data: res });
    }

    // 4. SET MARGIN TYPE (Binance)
    if (action === 'SET_MARGIN_TYPE') {
      const { symbol, marginType } = body.payload || {};
      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const res = await client.setMarginType(symbol, marginType);
      return NextResponse.json({ success: true, data: res });
    }

    // 5. PLACE ORDER (Binance or Bitget)
    if (action === 'ORDER' || action === 'PLACE_ORDER') {
      const { symbol, side, type, quantity, price, stopPrice, reduceOnly, margin, leverage, marginMode } = body.payload || {};

      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const order = await bitget.placeMarketOrder({
          symbol,
          side: side === 'BUY' || side === 'LONG' ? 'BUY' : 'SELL',
          size: String(quantity),
          price: price ? parseFloat(price) : undefined,
          margin: typeof margin === 'number' ? margin : (margin ? parseFloat(margin) : undefined),
          leverage: typeof leverage === 'number' ? leverage : (leverage ? parseInt(leverage, 10) : undefined),
          marginMode: marginMode?.toLowerCase() === 'cross' ? 'crossed' : 'isolated',
          reduceOnly: Boolean(reduceOnly),
          stopLossPrice: stopPrice ? parseFloat(stopPrice) : undefined,
        });
        return NextResponse.json({ success: true, exchange: 'BITGET', data: order });
      }

      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const order = await client.placeOrder({
        symbol,
        side,
        type,
        quantity,
        price,
        stopPrice,
        reduceOnly,
      });
      return NextResponse.json({ success: true, exchange: 'BINANCE', data: order });
    }

    // 6. CLOSE / PARTIAL CLOSE POSITION
    if (action === 'CLOSE_POSITION') {
      const { symbol, positionAmt, quantityToClose } = body.payload || {};

      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const res = await bitget.closePosition(symbol, Number(positionAmt || 0), quantityToClose ? Number(quantityToClose) : undefined);
        return NextResponse.json({ success: true, exchange: 'BITGET', data: res });
      }

      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const res = await client.closePosition(symbol, positionAmt, quantityToClose);
      return NextResponse.json({ success: true, exchange: 'BINANCE', data: res });
    }

    // 7. PANIC CLOSE ALL
    if (action === 'PANIC_CLOSE') {
      const { engineScheduler } = await import('@/lib/engineScheduler');
      engineScheduler.setPanicClosingLock(5000);
      engineScheduler.setCryptoAutoTrading(false);

      const { stateSync } = await import('@/lib/stateSync');
      await stateSync.updateRuntimeState({ cryptoIsAutoTrading: false });

      const { clearAllSimulatedPositions } = await import('@/services/bitgetService');
      clearAllSimulatedPositions();

      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const res = await bitget.panicCloseAll(body.payload?.positions);
        return NextResponse.json({ success: true, exchange: 'BITGET', data: res });
      }

      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const positions = body.payload?.positions || [];
      const results = [];
      for (const p of positions) {
        try {
          const r = await client.closePosition(p.symbol, p.positionAmt);
          results.push(r);
        } catch (e: any) {
          results.push({ error: e.message });
        }
      }
      return NextResponse.json({ success: true, exchange: 'BINANCE', data: results });
    }

    // 8. UPDATE TRAILING STOP
    if (action === 'UPDATE_TRAILING_STOP') {
      const { symbol, triggerPrice, holdSide, side, planType } = body.payload || {};
      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const res = await bitget.updateTrailingStop({
          symbol,
          holdSide: holdSide || (side === 'BUY' ? 'long' : 'short'),
          triggerPrice: Number(triggerPrice),
          planType: planType || 'pos_loss',
        });
        return NextResponse.json({ success: true, exchange: 'BITGET', data: res });
      }

      return NextResponse.json({ success: true, exchange: 'BINANCE', message: 'Stop updated in memory' });
    }

    return NextResponse.json({ success: false, error: `Unknown POST action: ${action}` }, { status: 400 });
  } catch (err: any) {
    console.error('[API POST /api/binance ERROR]:', err);
    return NextResponse.json(
      { success: false, error: err?.message || 'Crypto operation failed' },
      { status: 500 }
    );
  }
}
