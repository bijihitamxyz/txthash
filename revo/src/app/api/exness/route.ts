import { NextRequest, NextResponse } from 'next/server';
import {
  ExnessClient,
  realTimeFeed,
  coalesceSnapshotRequest,
  LiveQuote,
  validateExnessCredentials,
  normalizeGatewayHost,
} from '@/core/exnessClient';
import {
  loadVaultCredentials,
  saveVaultCredentials,
  ExnessVaultCredentials,
} from '@/core/exnessVault';
import { testAiPing } from '@/core/aiJudge';
import { ensureSchedulerStarted } from '@/lib/engineScheduler';
import { stateSync } from '@/lib/stateSync';
import { Candle } from '@/core/indicatorEngine';

export const dynamic = 'force-dynamic';

const SYMBOLS = ['XAUUSDm', 'EURUSDm', 'GBPUSDm', 'USDJPYm'];

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
      demoInitialBalance: state.credentials.demoInitialBalance ?? 0,
      realAccountId: state.credentials.realAccountId,
      realServer: state.credentials.realServer,
      realApiKey: state.credentials.realApiKey ? '••••••••' : '',
      realApiSecret: state.credentials.realApiSecret ? '••••••••' : '',
      realInitialBalance: state.credentials.realInitialBalance ?? 0,
      aiProvider: state.credentials.aiProvider,
      aiBaseUrl: state.credentials.aiBaseUrl,
      aiModel: state.credentials.aiModel,
      aiApiKey: state.credentials.aiApiKey ? '••••••••' : '',
      updatedAt: state.credentials.updatedAt,
    },
  };
}

/**
 * Creates an ExnessClient from the server-side AES vault.
 * Throws if no Exness credentials are configured.
 */
async function getVaultClient(): Promise<ExnessClient> {
  const vaultCreds = await loadVaultCredentials();
  if (!vaultCreds) {
    throw new Error('Akun Exness belum terhubung. Masukkan Account ID, API Key (exnsk-) dan Ed25519 Private Key di Vault.');
  }
  return new ExnessClient(vaultCreds);
}

async function safeFetchPositions(client: ExnessClient) {
  try {
    return { positions: await client.fetchOpenPositions(), error: undefined as string | undefined };
  } catch (err: any) {
    return { positions: [] as any[], error: String(err?.message || err) };
  }
}

/**
 * Builds unified snapshot containing REAL Exness account info + positions, live quotes, candles, and telemetry.
 * Strict zero dummy balance: balance, equity, dailyPnl are null when disconnected.
 */
async function buildUnifiedSnapshot(targetSymbol: string = 'XAUUSDm') {
  return coalesceSnapshotRequest(async () => {
    const vaultCreds = await loadVaultCredentials();
    const client = new ExnessClient(vaultCreds || undefined);

    let acc;
    let positions: any[] = [];
    let positionsError: string | undefined;
    if (vaultCreds) {
      acc = await client.getAccountInfo();
      if (acc.connected) {
        client.ensureWebSocketConnected().catch(() => {});
        const posRes = await safeFetchPositions(client);
        positions = posRes.positions;
        positionsError = posRes.error;
      }
    } else {
      acc = {
        accountNumber: '',
        server: '',
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
        mode: 'DEMO' as const,
        isLiveExness: false,
        error: 'Akun Exness belum terhubung. Silakan isi kredensial di Vault.',
      };
    }

    const quotes: Record<string, LiveQuote> = {};
    const candles: Record<string, Candle[]> = {};

    await Promise.all(
      SYMBOLS.map(async (sym) => {
        const q = await client.getQuote(sym);
        quotes[sym] = q;
        const c = await client.getCandles(sym, 'M5', 80);
        candles[sym] = c;
      })
    );

    const activeQuote = quotes[targetSymbol] || quotes['XAUUSDm'] || Object.values(quotes)[0];
    const activeCandles = candles[targetSymbol] || candles['XAUUSDm'] || [];
    const botState = await stateSync.getRuntimeState().catch(() => null);
    const telemetry = botState?.telemetryLogs || [];

    const isConn = Boolean(acc.connected);
    const snapshot = {
      ok: isConn,
      success: isConn,
      connected: isConn,
      error: acc.error || positionsError,
      isLiveExness: Boolean(acc.isLiveExness && isConn),
      mode: acc.mode,
      accountId: acc.accountNumber,
      accountNumber: acc.accountNumber,
      server: acc.server,
      balance: isConn ? acc.balance : null,
      equity: isConn ? acc.equity : null,
      margin: isConn ? acc.margin : 0,
      freeMargin: isConn ? acc.freeMargin : null,
      marginLevelPct: isConn ? acc.marginLevelPct : 0,
      currency: acc.currency,
      latencyMs: acc.latencyMs,
      dailyPnl: isConn ? acc.dailyRealizedPnL : null,
      dailyRealizedLossUsd: isConn ? acc.dailyRealizedLossUsd : 0,
      account: {
        ...acc,
        balance: isConn ? acc.balance : null,
        equity: isConn ? acc.equity : null,
        freeMargin: isConn ? acc.freeMargin : null,
        dailyRealizedPnL: isConn ? acc.dailyRealizedPnL : null,
        connected: isConn,
      },
      quote: activeQuote,
      quotes,
      candles: activeCandles,
      allCandles: candles,
      positions: isConn ? positions : [],
      openPositions: isConn ? positions : [],
      telemetry,
      timestamp: Date.now(),
    };

    return snapshot;
  });
}

export async function GET(req: NextRequest) {
  try {
    ensureSchedulerStarted();
    const { searchParams } = new URL(req.url);
    const symbol = searchParams.get('symbol') || 'XAUUSDm';
    const snapshot = await buildUnifiedSnapshot(symbol);

    return NextResponse.json(
      {
        ...snapshot,
        data: snapshot,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err) },
      { status: 200 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    ensureSchedulerStarted();

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const { action, credentials, symbol, payload } = body;
    const rawAction = String(action || body.type || '').trim();
    const cleanAction = rawAction.toLowerCase().replace(/[-_\s]/g, '');

    // 1. CONNECT ACTION
    if (cleanAction === 'connect') {
      const incomingCreds: Partial<ExnessVaultCredentials> = credentials || payload || body;
      const accountId = String(incomingCreds.accountId || '').trim();
      const apiKey = String(incomingCreds.apiKey || '').trim();
      const privateKey = String(incomingCreds.privateKey || '').trim();
      const mode = incomingCreds.mode === 'REAL' ? 'REAL' : 'DEMO';
      let server = normalizeGatewayHost(incomingCreds.server);

      // 1. accountId validation (must be valid numeric login e.g. 464129221 or 30000143146)
      if (!accountId || !/^\d+$/.test(accountId)) {
        return NextResponse.json(
          {
            ok: false,
            connected: false,
            error: 'Account ID Exness tidak valid! Masukkan nomor login MT5 berupa angka (contoh: 464129221 atau 30000143146).',
          },
          { status: 401 }
        );
      }

      // 2. apiKey validation: MUST start with "exnsk-" and be at least 36 characters long
      if (!apiKey || !apiKey.startsWith('exnsk-') || apiKey.length < 36) {
        return NextResponse.json(
          {
            ok: false,
            connected: false,
            error: "API Key Exness tidak valid! Gunakan Public Key resmi berawalan 'exnsk-' dari menu API Management Exness.",
          },
          { status: 401 }
        );
      }

      // 3. privateKey validation: MUST be valid Ed25519 key (128-char hex, 64-char hex seed, Base64, or PKCS#8 PEM)
      const credValidation = validateExnessCredentials({ accountId, apiKey, privateKey });
      if (!credValidation.valid) {
        return NextResponse.json(
          {
            ok: false,
            connected: false,
            error: credValidation.error || 'Private Key Ed25519 tidak valid! Gunakan 128-char Hex, 64-char Hex seed, Base64, atau format PEM PKCS#8 resmi Exness.',
          },
          { status: 401 }
        );
      }

      const vaultRecord: ExnessVaultCredentials = {
        accountId,
        mode,
        server,
        apiKey,
        privateKey,
        updatedAt: Date.now(),
      };

      const client = new ExnessClient(vaultRecord);
      try {
        const verifyRes = await client.connectAndVerify(vaultRecord);
        if (!verifyRes.connected) {
          return NextResponse.json(
            {
              ok: false,
              connected: false,
              error: 'Gagal memverifikasi akun ke Exness gateway.',
            },
            { status: 401 }
          );
        }

        // Save to AES-256 Vault safely ONLY after strict verification succeeds
        await saveVaultCredentials(vaultRecord);

        return NextResponse.json(
          {
            ok: true,
            success: true,
            message: `Connected successfully to Exness (${mode} Mode)`,
            connected: verifyRes.connected,
            mode: verifyRes.mode,
            accountId: verifyRes.accountId,
            server: verifyRes.server,
            balance: verifyRes.balance,
            equity: verifyRes.equity,
            freeMargin: verifyRes.freeMargin,
            currency: verifyRes.currency,
          },
          { status: 200 }
        );
      } catch (err: any) {
        return NextResponse.json(
          {
            ok: false,
            connected: false,
            error: err?.message || 'Autentikasi Exness gagal.',
          },
          { status: 401 }
        );
      }
    }

    // 2. OPEN MARKET ORDER (openOrder | open | placeOrder | trade | order) -> REAL Exness order
    if (['openorder', 'open', 'placeorder', 'trade', 'order'].includes(cleanAction)) {
      const orderData = { ...(body || {}), ...(payload || {}) };
      const orderSymbol = body.symbol || payload?.symbol || symbol || 'XAUUSDm';
      const rawSide = String(body.side || body.type || body.direction || payload?.side || payload?.type || payload?.direction || 'BUY').toUpperCase();
      const side = rawSide === 'SELL' ? 'SELL' : 'BUY';
      const lot = Number(body.lot || body.lots || body.volume || payload?.lot || payload?.lots || payload?.volume || 0.01);
      const stopLoss = body.stopLoss ?? body.sl ?? body.stopLossPrice ?? payload?.stopLoss ?? payload?.sl ?? payload?.stopLossPrice;
      const takeProfit = body.takeProfit ?? body.tp ?? body.takeProfitPrice ?? payload?.takeProfit ?? payload?.tp ?? payload?.takeProfitPrice;
      const comment = body.comment || payload?.comment || orderData.comment || 'Quant AI Execution';

      const client = await getVaultClient();
      const result = await client.openMarketOrder({
        symbol: orderSymbol,
        side,
        lot,
        stopLoss,
        takeProfit,
        comment,
      });

      const { positions: currentPositions, error: posError } = await safeFetchPositions(client);
      if (!posError) {
        await stateSync.updateRuntimeState({ positions: currentPositions }).catch(() => {});
      }

      return NextResponse.json(
        {
          ok: result.success,
          success: result.success,
          data: result,
          order: result,
          positions: currentPositions,
          openPositions: currentPositions,
          message: result.message,
          error: result.success ? undefined : result.message,
        },
        { status: 200 }
      );
    }

    // 3. CLOSE POSITION / PARTIAL CLOSE (closePosition | close | partialClose | close50) -> REAL Exness close
    if (['closeposition', 'close', 'partialclose', 'close50'].includes(cleanAction)) {
      const closeData = { ...(body || {}), ...(payload || {}) };
      const rawId = closeData.positionId || closeData.id || body.positionId || body.id;
      const positionId = String(rawId || '').trim();
      let volumeToClose = closeData.volumeToClose ?? closeData.volume ?? closeData.lot ?? body.volumeToClose ?? body.volume ?? body.lot;
      const sym = closeData.symbol || body.symbol || symbol;

      if (!positionId) {
        return NextResponse.json(
          { ok: false, success: false, error: 'Position ID is required' },
          { status: 200 }
        );
      }

      const client = await getVaultClient();
      const norm = (id: string) => String(id || '').replace(/^#+/, '').trim().toLowerCase();
      const targetNorm = norm(positionId);

      // Always resolve the position from the live Exness list
      const { positions: livePositions } = await safeFetchPositions(client);
      const curPos = livePositions.find((p: any) => norm(p.id) === targetNorm);

      if ((cleanAction === 'partialclose' || cleanAction === 'close50') && !volumeToClose && curPos) {
        volumeToClose = Number((curPos.volume * 0.5).toFixed(2));
      }
      if (cleanAction === 'closeposition' || cleanAction === 'close') {
        if (!curPos || !volumeToClose || Number(volumeToClose) >= curPos.volume) {
          volumeToClose = undefined;
        }
      }

      const closeRes = await client.closePosition({ positionId }, volumeToClose ? Number(volumeToClose) : undefined, sym || curPos?.symbol);
      const { positions: currentPositions, error: posError } = await safeFetchPositions(client);
      if (!posError) {
        await stateSync.updateRuntimeState({ positions: currentPositions }).catch(() => {});
      }

      return NextResponse.json(
        {
          ok: closeRes.success,
          success: closeRes.success,
          data: closeRes,
          message: closeRes.message,
          error: closeRes.success ? undefined : closeRes.message,
          positions: currentPositions,
          openPositions: currentPositions,
        },
        { status: 200 }
      );
    }

    // 4. MODIFY POSITION (modifyPosition | modify | updateSlTp) -> REAL Exness modify
    if (['modifyposition', 'modify', 'updatesltp'].includes(cleanAction)) {
      const modifyData = { ...(body || {}), ...(payload || {}) };
      const positionId = modifyData.positionId || modifyData.id || body.positionId || body.id;
      const stopLoss = modifyData.stopLoss ?? modifyData.sl ?? body.stopLoss ?? body.sl;
      const takeProfit = modifyData.takeProfit ?? modifyData.tp ?? body.takeProfit ?? body.tp;
      const sym = modifyData.symbol || body.symbol || symbol;

      if (!positionId) {
        return NextResponse.json(
          { ok: false, success: false, error: 'Position ID is required' },
          { status: 200 }
        );
      }

      const client = await getVaultClient();
      const modified = await client.modifyPosition({ positionId, stopLoss, takeProfit }, stopLoss, takeProfit, sym);
      const { positions: currentPositions, error: posError } = await safeFetchPositions(client);
      if (!posError) {
        await stateSync.updateRuntimeState({ positions: currentPositions }).catch(() => {});
      }

      return NextResponse.json(
        {
          ok: modified,
          success: modified,
          error: modified ? undefined : `Modify SL/TP #${positionId} ditolak oleh Exness.`,
          data: { success: modified, positionId, stopLoss, takeProfit },
          positions: currentPositions,
          openPositions: currentPositions,
        },
        { status: 200 }
      );
    }

    // 5. CLOSE ALL / PANIC CLOSE (closeAll | panicClose | panic) -> REAL Exness close all
    if (['closeall', 'panicclose', 'panic'].includes(cleanAction)) {
      const client = await getVaultClient();
      const panicRes = await client.closeAllPositions();
      const { positions: currentPositions } = await safeFetchPositions(client);
      await stateSync.updateRuntimeState({
        positions: currentPositions,
        isAutoTrading: false,
      }).catch(() => {});

      return NextResponse.json(
        {
          ok: true,
          success: true,
          data: panicRes,
          message: panicRes.message,
          positions: currentPositions,
          openPositions: currentPositions,
        },
        { status: 200 }
      );
    }

    // 6. CANDLES
    if (cleanAction === 'candles') {
      const targetSym = symbol || payload?.symbol || body?.symbol || 'XAUUSDm';
      const timeframe = payload?.timeframe || body?.timeframe || 'M5';
      const limit = payload?.limit || body?.limit || 80;
      const vaultCreds = await loadVaultCredentials();
      const client = new ExnessClient(vaultCreds || undefined);
      client.ensureWebSocketConnected().catch(() => {});
      const candles = await client.getCandles(targetSym, timeframe, limit);

      return NextResponse.json({ ok: true, success: true, data: candles }, { status: 200 });
    }

    // 7. QUOTE
    if (cleanAction === 'quote') {
      const targetSym = symbol || payload?.symbol || body?.symbol || 'XAUUSDm';
      const vaultCreds = await loadVaultCredentials();
      const client = new ExnessClient(vaultCreds || undefined);
      client.ensureWebSocketConnected().catch(() => {});
      const quote = await client.getQuote(targetSym);

      return NextResponse.json({ ok: true, success: true, data: quote }, { status: 200 });
    }

    // 8. AI TEST
    if (cleanAction === 'testai') {
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

    // 9. SYNC-STATE
    if (cleanAction === 'syncstate') {
      const updated = await stateSync.updateRuntimeState(payload || {});
      return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(updated) }, { status: 200 });
    }

    // 10. GET-STATE
    if (cleanAction === 'getstate') {
      const state = await stateSync.getRuntimeState();
      return NextResponse.json({ ok: true, success: true, data: sanitizeRuntimeState(state) }, { status: 200 });
    }

    // 11. UNIFIED SNAPSHOT FALLBACK
    const targetSym = symbol || payload?.symbol || body?.symbol || 'XAUUSDm';
    const snapshot = await buildUnifiedSnapshot(targetSym);

    return NextResponse.json(
      {
        ...snapshot,
        data: snapshot,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, success: false, error: String(err?.message || err || 'Internal Exness proxy error') },
      { status: 200 }
    );
  }
}
