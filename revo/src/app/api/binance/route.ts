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

    const rawExchange = searchParams.get('exchange');
    const rawIsTestnet = searchParams.get('isTestnet');
    const rawAccountType = searchParams.get('accountType');

    let exchange = rawExchange ? rawExchange.toUpperCase() : '';
    let accountType: 'REAL' | 'DEMO' | null =
      rawAccountType === 'DEMO' || rawIsTestnet === 'true'
        ? 'DEMO'
        : rawAccountType === 'REAL' || rawIsTestnet === 'false'
        ? 'REAL'
        : null;

    if (!exchange || !accountType) {
      const vault = await loadServerCryptoVault().catch(() => null);
      if (!exchange) {
        exchange = (vault?.activeCryptoExchange || 'BINANCE').toUpperCase();
      }
      if (!accountType) {
        const vaultCreds = exchange === 'BITGET' ? vault?.bitget : vault?.binance;
        accountType = vaultCreds?.accountType || (exchange === 'BITGET' ? 'REAL' : 'DEMO');
      }
    }

    const isTestnet = accountType === 'DEMO';

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

    if (action === 'SYNC_ACTIVE_ROOM') {
      const activeRoom = body.activeRoom === 'CRYPTO' || body.activeRoom === 'ROOM_2_BINANCE' ? 'CRYPTO' : 'FOREX';
      const { engineScheduler } = await import('@/lib/engineScheduler');
      engineScheduler.setActiveRoom(activeRoom);
      const { stateSync } = await import('@/lib/stateSync');
      await stateSync.updateRuntimeState({ activeRoom });
      return NextResponse.json({ success: true, activeRoom });
    }

    if (action === 'SYNC_STATE' || action === 'TOGGLE_AUTO_TRADING') {
      const requestedAuto = typeof body.isAutoTrading === 'boolean' ? body.isAutoTrading : false;
      if (requestedAuto) {
        const { readCentralAiConfig } = await import('@/core/centralAiConfig');
        const centralCfg = await readCentralAiConfig();
        if (centralCfg.engineSwitches?.cryptoMaintenance || centralCfg.engineSwitches?.emergencyKillSwitch) {
          return NextResponse.json(
            {
              success: false,
              maintenance: true,
              error: centralCfg.engineSwitches?.cryptoMaintenance
                ? 'Crypto Room sedang dalam mode Maintenance / Upgrade oleh Admin.'
                : 'Emergency Kill-Switch sedang aktif oleh Admin.',
            },
            { status: 503 }
          );
        }
      }
      const isAuto = requestedAuto;
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

    const serverVault = action !== 'TEST_CONNECTION'
      ? await loadServerCryptoVault().catch(() => null)
      : null;

    const rawExchange =
      body.exchange ||
      body.credentials?.exchange ||
      (body.credentials?.passphrase ? 'BITGET' : undefined) ||
      serverVault?.activeCryptoExchange ||
      'BINANCE';

    const exchange: 'BINANCE' | 'BITGET' = String(rawExchange).toUpperCase() === 'BITGET' ? 'BITGET' : 'BINANCE';
    const vaultCreds = exchange === 'BITGET' ? serverVault?.bitget : serverVault?.binance;

    const reqCreds = body.credentials || {};
    const apiKey = String(reqCreds.apiKey || (action !== 'TEST_CONNECTION' ? vaultCreds?.apiKey : '') || '').trim();
    const effectiveSecret = String(
      reqCreds.secretKey ||
      reqCreds.apiSecret ||
      (action !== 'TEST_CONNECTION' ? vaultCreds?.secretKey : '') ||
      ''
    ).trim();
    const passphrase = String(
      reqCreds.passphrase ||
      (action !== 'TEST_CONNECTION' && exchange === 'BITGET' ? (vaultCreds as any)?.passphrase : '') ||
      ''
    ).trim();

    const rawAccountType = reqCreds.accountType || body.accountType;
    const explicitIsTestnet = typeof reqCreds.isTestnet === 'boolean'
      ? reqCreds.isTestnet
      : typeof body.isTestnet === 'boolean'
      ? body.isTestnet
      : undefined;

    const accountType: 'REAL' | 'DEMO' =
      rawAccountType === 'DEMO' || rawAccountType === 'REAL'
        ? rawAccountType
        : typeof explicitIsTestnet === 'boolean'
        ? (explicitIsTestnet ? 'DEMO' : 'REAL')
        : vaultCreds?.accountType || (exchange === 'BITGET' ? 'REAL' : 'DEMO');

    const PRIVATE_ACTIONS = ['ACCOUNT', 'ORDER', 'PLACE_ORDER', 'CLOSE_POSITION', 'PANIC_CLOSE', 'UPDATE_TRAILING_STOP', 'SET_LEVERAGE', 'SET_MARGIN_TYPE'];
    if (exchange === 'BITGET' && PRIVATE_ACTIONS.includes(action) && (!apiKey || !effectiveSecret || !passphrase)) {
      return NextResponse.json(
        { success: false, exchange: 'BITGET', error: 'Bitget API Key, Secret Key, dan Passphrase wajib diisi di Vault.' },
        { status: 400 }
      );
    }
    if (exchange === 'BINANCE' && PRIVATE_ACTIONS.includes(action) && (!apiKey || !effectiveSecret)) {
      return NextResponse.json(
        { success: false, exchange: 'BINANCE', error: 'Binance API Key dan Secret Key wajib diisi di Vault.' },
        { status: 400 }
      );
    }

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
            message: `Connected successfully to Bitget Futures (${accountType === 'REAL' ? 'Live Real' : 'Bitget Demo Trading'}).`,
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

    // 3. SET LEVERAGE (Binance or Bitget)
    if (action === 'SET_LEVERAGE') {
      const { symbol, leverage } = body.payload || {};
      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const res = await bitget.setLeverage(symbol, Number(leverage));
        return NextResponse.json({ success: true, exchange: 'BITGET', data: res });
      }
      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const res = await client.setLeverage(symbol, leverage);
      return NextResponse.json({ success: true, data: res });
    }

    // 4. SET MARGIN TYPE (Binance or Bitget)
    if (action === 'SET_MARGIN_TYPE') {
      const { symbol, marginType } = body.payload || {};
      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const mode = String(marginType || '').toLowerCase().startsWith('cross') ? 'crossed' : 'isolated';
        const res = await bitget.setMarginMode(symbol, mode);
        return NextResponse.json({ success: true, exchange: 'BITGET', data: res });
      }
      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const res = await client.setMarginType(symbol, marginType);
      return NextResponse.json({ success: true, data: res });
    }

    // 5. PLACE ORDER (Binance or Bitget)
    if (action === 'ORDER' || action === 'PLACE_ORDER') {
      const { symbol, side, type, quantity, price, stopPrice, takeProfitPrice, reduceOnly, margin, leverage, marginMode } = body.payload || {};
      if (!reduceOnly) {
        const { readCentralAiConfig } = await import('@/core/centralAiConfig');
        const centralCfg = await readCentralAiConfig();
        if (centralCfg.engineSwitches?.cryptoMaintenance || centralCfg.engineSwitches?.emergencyKillSwitch) {
          return NextResponse.json(
            {
              success: false,
              maintenance: true,
              error: centralCfg.engineSwitches?.cryptoMaintenance
                ? 'Crypto Room sedang dalam mode Maintenance / Upgrade oleh Admin.'
                : 'Emergency Kill-Switch sedang aktif oleh Admin.',
            },
            { status: 503 }
          );
        }
      }

      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        if (!reduceOnly) {
          const { withCryptoOrderLock } = await import('@/lib/cryptoOrderLock');
          const { stateSync } = await import('@/lib/stateSync');
          const { engineScheduler } = await import('@/lib/engineScheduler');
          return await withCryptoOrderLock(async () => {
            const runtimeState = await stateSync.getRuntimeState();
            const rawMax = runtimeState.cryptoMaxConcurrentCoins ?? engineScheduler.cryptoMaxConcurrentCoins ?? 5;
            const maxPositions = Math.max(1, Math.min(5, Number(rawMax) || 5));
            const currentOpenPositions = await bitget.getOpenPositions();
            if (currentOpenPositions.length >= maxPositions) {
              return NextResponse.json(
                {
                  success: false,
                  error: `Max open positions reached (${currentOpenPositions.length}/${maxPositions}). Order blocked.`,
                },
                { status: 409 }
              );
            }
            const order = await bitget.placeMarketOrder({
              symbol,
              side: side === 'BUY' || side === 'LONG' ? 'BUY' : 'SELL',
              size: String(quantity),
              price: price ? parseFloat(price) : undefined,
              margin: typeof margin === 'number' ? margin : (margin ? parseFloat(margin) : undefined),
              leverage: typeof leverage === 'number' ? leverage : (leverage ? parseInt(leverage, 10) : undefined),
              marginMode: String(marginMode || '').toLowerCase().startsWith('cross') ? 'crossed' : 'isolated',
              reduceOnly: false,
              stopLossPrice: stopPrice ? parseFloat(stopPrice) : undefined,
              takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : undefined,
            });
            return NextResponse.json({ success: true, exchange: 'BITGET', data: order });
          });
        }

        const order = await bitget.placeMarketOrder({
          symbol,
          side: side === 'BUY' || side === 'LONG' ? 'BUY' : 'SELL',
          size: String(quantity),
          price: price ? parseFloat(price) : undefined,
          margin: typeof margin === 'number' ? margin : (margin ? parseFloat(margin) : undefined),
          leverage: typeof leverage === 'number' ? leverage : (leverage ? parseInt(leverage, 10) : undefined),
          marginMode: String(marginMode || '').toLowerCase().startsWith('cross') ? 'crossed' : 'isolated',
          reduceOnly: Boolean(reduceOnly),
          stopLossPrice: stopPrice ? parseFloat(stopPrice) : undefined,
          takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : undefined,
        });
        return NextResponse.json({ success: true, exchange: 'BITGET', data: order });
      }

      const client = new BinanceFuturesClient(apiKey, effectiveSecret, accountType === 'DEMO');
      const orderType = String(type || 'MARKET').toUpperCase();
      const normalizedSide: 'BUY' | 'SELL' = side === 'BUY' || side === 'LONG' ? 'BUY' : 'SELL';
      if (!reduceOnly) {
        const { withCryptoOrderLock } = await import('@/lib/cryptoOrderLock');
        const { stateSync } = await import('@/lib/stateSync');
        const { engineScheduler } = await import('@/lib/engineScheduler');
        return await withCryptoOrderLock(async () => {
          const runtimeState = await stateSync.getRuntimeState();
          const rawMax = runtimeState.cryptoMaxConcurrentCoins ?? engineScheduler.cryptoMaxConcurrentCoins ?? 5;
          const maxPositions = Math.max(1, Math.min(5, Number(rawMax) || 5));
          const acct = await client.getAccountInfo();
          if (acct.positions.length >= maxPositions) {
            return NextResponse.json(
              {
                success: false,
                error: `Max open positions reached (${acct.positions.length}/${maxPositions}). Order blocked.`,
              },
              { status: 409 }
            );
          }
          const order = orderType === 'MARKET'
            ? await client.placeMarketOrderWithProtection({
                symbol,
                side: normalizedSide,
                quantity: String(quantity),
                leverage: typeof leverage === 'number' ? leverage : (leverage ? parseInt(leverage, 10) : undefined),
                marginMode: String(marginMode || '').toLowerCase().startsWith('cross') ? 'CROSSED' : 'ISOLATED',
                stopLossPrice: stopPrice ? parseFloat(stopPrice) : undefined,
                takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : undefined,
              })
            : await client.placeOrder({
                symbol,
                side: normalizedSide,
                type: orderType as any,
                quantity,
                price,
                stopPrice,
                reduceOnly,
              });
          return NextResponse.json({ success: true, exchange: 'BINANCE', data: order });
        });
      }

      const order = await client.placeOrder({
        symbol,
        side: normalizedSide,
        type: orderType as any,
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

      if (exchange === 'BITGET') {
        const bitget = new BitgetFuturesService(apiKey, effectiveSecret, passphrase, accountType);
        const res = await bitget.panicCloseAll();
        return NextResponse.json({ success: res.errors.length === 0, exchange: 'BITGET', data: res, error: res.errors.join('; ') || undefined });
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
