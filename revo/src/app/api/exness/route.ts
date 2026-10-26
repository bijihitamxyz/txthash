import { NextRequest, NextResponse } from 'next/server';
import { ExnessClient, realTimeFeed, generateFallbackCandles } from '@/core/exnessClient';
import { testAiPing } from '@/core/aiJudge';
import { ManagedPosition } from '@/core/trailingManager';
import { ensureSchedulerStarted } from '@/lib/engineScheduler';
import { stateSync } from '@/lib/stateSync';
import { getActiveExnessCredentials } from '@/lib/cryptoVault';

export const dynamic = 'force-dynamic';

export const PAIR_BASELINES = {
  XAUUSDm: { price: 4018.00, digits: 2, pip: 0.10 },
  EURUSDm: { price: 1.08500, digits: 5, pip: 0.0001 },
  GBPUSDm: { price: 1.29500, digits: 5, pip: 0.0001 },
  USDJPYm: { price: 156.840, digits: 3, pip: 0.01 },
};

// 30-second TTL cache for external network calls to eliminate polling timeouts (< 15ms response)
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}
const accountCache = new Map<string, CacheEntry<any>>();
const quoteCache = new Map<string, CacheEntry<any>>();
const candlesCache = new Map<string, CacheEntry<any>>();
const CACHE_TTL_MS = 30000;

function sanitizeRuntimeState(state: any) {
  if (!state || !state.credentials) return state;
  return {
    ...state,
    credentials: {
      accountMode: state.credentials.accountMode,
      demoAccountId: state.credentials.demoAccountId,
      demoServer: state.credentials.demoServer,
      demoApiKey: state.credentials.demoApiKey ? '••••••••' : '',
      demoApiSecret: state.credentials.demoApiSecret ? '••••••••' : '',
      demoInitialBalance: state.credentials.demoInitialBalance ?? 100.0,
      realAccountId: state.credentials.realAccountId,
      realServer: state.credentials.realServer,
      realApiKey: state.credentials.realApiKey ? '••••••••' : '',
      realApiSecret: state.credentials.realApiSecret ? '••••••••' : '',
      realInitialBalance: state.credentials.realInitialBalance ?? 100.0,
      aiProvider: state.credentials.aiProvider,
      aiBaseUrl: state.credentials.aiBaseUrl,
      aiModel: state.credentials.aiModel,
      aiApiKey: state.credentials.aiApiKey ? '••••••••' : '',
      updatedAt: state.credentials.updatedAt,
    },
  };
}

export async function GET() {
  try {
    ensureSchedulerStarted();
    const runtimeState = await stateSync.getRuntimeState();
    return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(runtimeState) }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, success: false, error: String(err?.message || err) }, { status: 200 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Ensure background scheduler is active in Node.js process
    ensureSchedulerStarted();

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const { action, credentials, symbol, payload } = body;

    // Load persisted state credentials as baseline
    const runtimeState = await stateSync.getRuntimeState();
    const activeCreds = getActiveExnessCredentials(runtimeState.credentials);

    // Extract auth headers to avoid browser CORS issues on Termux
    const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
    const apiKeyHeader = req.headers.get('x-api-key') || req.headers.get('X-API-Key') || req.headers.get('X-Api-Key');
    const accountIdHeader = req.headers.get('x-exness-account') || req.headers.get('X-Exness-Account');
    const serverHeader = req.headers.get('x-exness-server') || req.headers.get('X-Exness-Server');

    let resolvedApiKey = (apiKeyHeader || '').trim();
    if (!resolvedApiKey && authHeader && authHeader.startsWith('Bearer ')) {
      resolvedApiKey = authHeader.substring(7).trim();
    }
    if (!resolvedApiKey && credentials?.apiKey) {
      resolvedApiKey = String(credentials.apiKey).trim();
    }
    if (!resolvedApiKey && credentials?.token) {
      resolvedApiKey = String(credentials.token).trim();
    }
    if (!resolvedApiKey && credentials?.password) {
      resolvedApiKey = String(credentials.password).trim();
    }
    if (!resolvedApiKey && activeCreds.apiKey) {
      resolvedApiKey = String(activeCreds.apiKey).trim();
    }

    const resolvedAccountId = (credentials?.accountId || accountIdHeader || activeCreds.accountId || '30000143146').trim();
    const resolvedServer = (credentials?.server || serverHeader || activeCreds.server || (activeCreds.mode === 'REAL' ? 'Exness-Real' : 'Exness-Trial')).trim();
    const resolvedSecret = (credentials?.secret || credentials?.demoApiSecret || credentials?.realApiSecret || activeCreds.secret || '').trim();

    const client = new ExnessClient({
      accountId: resolvedAccountId,
      server: resolvedServer,
      apiKey: resolvedApiKey,
      token: resolvedApiKey,
      password: resolvedApiKey,
      secret: resolvedSecret,
      initialBalance: credentials?.initialBalance || activeCreds.initialBalance,
      currentBalance: payload?.currentBalance || payload?.balance,
    });

    const normalizedAction = String(action || '').toUpperCase();

    switch (normalizedAction) {
      case 'GET_ACCOUNT':
      case 'ACCOUNT': {
        // STRICT: Never allow GET_ACCOUNT to succeed if Exness API Key is missing!
        if (!resolvedApiKey) {
          return NextResponse.json(
            {
              ok: false,
              success: false,
              error: 'Exness API Key (Full Access Token) is required. Please configure your API key in the Credential Vault.',
            },
            { status: 200 }
          );
        }

        const currentPositions = Array.isArray(payload?.positions)
          ? payload.positions
          : (runtimeState.positions || []);
        realTimeFeed.syncPositions(currentPositions);

        if (typeof payload?.currentBalance === 'number' && payload.currentBalance > 0) {
          realTimeFeed.syncLedgerState(payload.currentBalance, payload.dailyPnl, payload.dailyRealizedLossUsd);
        } else if (typeof credentials?.currentBalance === 'number' && credentials.currentBalance > 0) {
          realTimeFeed.syncLedgerState(credentials.currentBalance);
        }

        const isDemo = activeCreds.mode === 'DEMO' || resolvedServer.toLowerCase().includes('trial') || resolvedServer.toLowerCase().includes('demo');
        const cacheKey = `${resolvedAccountId}_${resolvedServer}`;
        const cached = accountCache.get(cacheKey);

        if (!isDemo && cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          return NextResponse.json({
            ok: true,
            success: true,
            data: {
              ...cached.data,
              openPositions: currentPositions,
            },
          }, { status: 200 });
        }

        const info = await client.getAccountInfo();
        if (!info.connected) {
          return NextResponse.json(
            {
              ok: false,
              success: false,
              error: 'Authentication failed: Invalid Exness API Key or account inaccessible',
            },
            { status: 200 }
          );
        }

        if (!isDemo && info.connected) {
          accountCache.set(cacheKey, { data: info, timestamp: Date.now() });
        }

        // Single authoritative source of truth:
        // Client-side Zustand store remains single source of truth for active positions in Demo mode.
        const openPositions = info.isLiveExness ? realTimeFeed.getPositions() : currentPositions;
        return NextResponse.json(
          {
            ok: true,
            success: true,
            data: {
              ...info,
              accountNumber: info.accountNumber || resolvedAccountId,
              openPositions,
            },
          },
          { status: 200 }
        );
      }

      case 'PLACE_ORDER':
      case 'ORDER': {
        if (!resolvedApiKey) {
          return NextResponse.json(
            { ok: false, success: false, error: 'Exness API Key is required to place market orders' },
            { status: 200 }
          );
        }

        const orderSymbol = payload?.symbol || symbol || body?.symbol || 'XAUUSDm';
        const side = String(payload?.side || payload?.type || body?.side || 'BUY').toUpperCase() as 'BUY' | 'SELL';
        const volume = Number(payload?.volume ?? payload?.lots ?? body?.volume ?? 0.01);
        const stopLossPrice = payload?.stopLossPrice ?? payload?.sl ?? body?.stopLossPrice ?? body?.sl;
        const takeProfitPrice = payload?.takeProfitPrice ?? payload?.tp ?? body?.takeProfitPrice ?? body?.tp;
        const comment = payload?.comment || body?.comment || 'Exness-Quant-Hybrid-EA';

        const orderResult = await client.placeMarketOrder({
          symbol: orderSymbol,
          side,
          volume,
          stopLossPrice,
          takeProfitPrice,
          comment,
        });

        // Sync with stateSync positions
        const currentPositions = realTimeFeed.getPositions();
        await stateSync.updateRuntimeState({ positions: currentPositions });

        return NextResponse.json(
          { ok: orderResult.success, success: orderResult.success, data: orderResult },
          { status: 200 }
        );
      }

      case 'MODIFY_POSITION':
      case 'MODIFY': {
        const positionId = payload?.positionId || body?.positionId;
        const stopLoss = payload?.stopLoss ?? payload?.sl ?? body?.stopLoss ?? body?.sl;
        const takeProfit = payload?.takeProfit ?? payload?.tp ?? body?.takeProfit ?? body?.tp;
        const sym = payload?.symbol || body?.symbol || symbol;

        if (!positionId) {
          return NextResponse.json({ ok: false, success: false, error: 'Position ID is required' }, { status: 200 });
        }

        const modified = await client.modifyPosition(positionId, stopLoss, takeProfit, sym);
        const currentPositions = realTimeFeed.getPositions();
        await stateSync.updateRuntimeState({ positions: currentPositions });

        return NextResponse.json(
          { ok: modified, success: modified, data: { success: modified, positionId, stopLoss, takeProfit } },
          { status: 200 }
        );
      }

      case 'CLOSE_POSITION':
      case 'CLOSE': {
        const positionId = payload?.positionId || body?.positionId;
        const volumeToClose = payload?.volumeToClose ?? payload?.volume ?? body?.volumeToClose ?? body?.volume;
        const sym = payload?.symbol || body?.symbol || symbol;

        if (!positionId) {
          return NextResponse.json({ ok: false, success: false, error: 'Position ID is required' }, { status: 200 });
        }

        const closeResult = await client.closePosition(positionId, volumeToClose, sym);
        const currentPositions = realTimeFeed.getPositions();
        await stateSync.updateRuntimeState({ positions: currentPositions });

        return NextResponse.json(
          { ok: closeResult.success, success: closeResult.success, data: closeResult },
          { status: 200 }
        );
      }

      case 'PANIC_CLOSE':
      case 'PANIC': {
        const positionsToClose: ManagedPosition[] = payload?.positions || runtimeState.positions || realTimeFeed.getPositions() || [];
        const panicResult = await client.panicCloseAll(positionsToClose);
        await stateSync.updateRuntimeState({
          positions: [],
          isAutoTrading: false,
        });
        return NextResponse.json({ ok: true, success: true, data: panicResult }, { status: 200 });
      }

      case 'TEST-CONNECTION':
      case 'TEST-EXNESS': {
        if (!resolvedApiKey) {
          return NextResponse.json(
            {
              ok: false,
              success: false,
              error: 'Validation Error: Exness API Key (Full Access Token) is required. Never show Connected without an API Key!',
              message: 'Validation Error: Exness API Key (Full Access Token) is required',
            },
            { status: 200 }
          );
        }

        const testClient = new ExnessClient({
          accountId: resolvedAccountId,
          server: resolvedServer,
          apiKey: resolvedApiKey,
          token: resolvedApiKey,
          password: resolvedApiKey,
          secret: resolvedSecret,
          initialBalance: credentials?.initialBalance || activeCreds.initialBalance,
        });
        const testResult = await testClient.testConnection();
        return NextResponse.json(
          {
            ok: testResult.success,
            success: testResult.success,
            data: testResult,
            message: testResult.message,
            error: testResult.success ? undefined : testResult.message,
          },
          { status: 200 }
        );
      }

      case 'TEST-AI': {
        const aiPayload = payload || credentials || body || {};
        const result = await testAiPing({
          baseUrl: aiPayload.baseUrl || aiPayload.aiBaseUrl || 'https://api.openai.com/v1',
          apiKey: aiPayload.apiKey || aiPayload.aiApiKey || '',
          model: aiPayload.model || aiPayload.aiModel || 'gpt-4o-mini',
        });
        return NextResponse.json(
          { ok: result.success, success: result.success, data: result, message: result.message },
          { status: 200 }
        );
      }

      case 'CANDLES': {
        const targetSym = symbol || 'XAUUSDm';
        const timeframe = payload?.timeframe || 'M5';
        const limit = payload?.limit || 250;
        const cacheKey = `${targetSym}_${timeframe}`;
        const isDemo = activeCreds.mode === 'DEMO' || resolvedServer.toLowerCase().includes('trial');

        if (isDemo) {
          const candles = realTimeFeed.getCandles(targetSym, timeframe);
          return NextResponse.json({ ok: true, success: true, data: candles }, { status: 200 });
        }

        const cached = candlesCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          return NextResponse.json({ ok: true, success: true, data: cached.data }, { status: 200 });
        }

        try {
          const candles = await client.getCandles(targetSym, timeframe, limit);
          if (Array.isArray(candles) && candles.length >= 20) {
            candlesCache.set(cacheKey, { data: candles, timestamp: Date.now() });
            return NextResponse.json({ ok: true, success: true, data: candles }, { status: 200 });
          }
          const fallback = generateFallbackCandles(targetSym, 50);
          return NextResponse.json({ ok: true, success: true, data: fallback }, { status: 200 });
        } catch {
          const fallback = generateFallbackCandles(targetSym, 50);
          return NextResponse.json({ ok: true, success: true, data: fallback }, { status: 200 });
        }
      }

      case 'QUOTE': {
        const targetSym = symbol || 'XAUUSDm';
        const isDemo = activeCreds.mode === 'DEMO' || resolvedServer.toLowerCase().includes('trial');
        if (isDemo) {
          const quote = realTimeFeed.getLiveQuote(targetSym);
          return NextResponse.json({ ok: true, success: true, data: quote }, { status: 200 });
        }
        const cached = quoteCache.get(targetSym);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          return NextResponse.json({ ok: true, success: true, data: cached.data }, { status: 200 });
        }
        const quote = await client.getQuote(targetSym);
        quoteCache.set(targetSym, { data: quote, timestamp: Date.now() });
        return NextResponse.json({ ok: true, success: true, data: quote }, { status: 200 });
      }

      case 'SYNC-STATE': {
        const updated = await stateSync.updateRuntimeState(payload || {});
        if (payload?.credentials) {
          const newActive = getActiveExnessCredentials(updated.credentials);
          if (newActive.initialBalance > 0 && realTimeFeed.getAccountBalance() === 0) {
            realTimeFeed.syncAccountInitialBalance(newActive.initialBalance);
          }
        }
        const syncBal = typeof payload?.currentBalance === 'number' && payload.currentBalance > 0
          ? payload.currentBalance
          : (typeof payload?.balance === 'number' && payload.balance > 0 ? payload.balance : null);
        if (syncBal !== null) {
          realTimeFeed.syncLedgerState(syncBal, payload.dailyPnl, payload.dailyRealizedLossUsd);
        }
        if (Array.isArray(payload?.positions)) {
          realTimeFeed.syncPositions(payload.positions);
        }
        return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(updated) }, { status: 200 });
      }

      case 'GET-STATE': {
        const state = await stateSync.getRuntimeState();
        return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(state) }, { status: 200 });
      }

      default:
        return NextResponse.json({ ok: false, success: false, error: `Unknown action: ${action}` }, { status: 200 });
    }
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err || 'Internal Exness proxy error') },
      { status: 200 }
    );
  }
}
