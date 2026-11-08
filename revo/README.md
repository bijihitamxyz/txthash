# NEMESIS X — Quant AI Auto-Trader (Forex, Gold & Crypto)

A production-ready, modular **Forex & Gold Automated Trading Web Application** built with **Next.js (App Router), TypeScript, TailwindCSS, and Zustand**.

Executes trades directly on **Exness (Demo & Real accounts)** using **Direct REST API & WebSocket (API Key / Bearer Token authentication)**—**STRICTLY NO MT4/MT5 desktop terminals or Python bridges required**.

---

## ⚡ Core Architecture

### 1. 3-Gate "Snap-Back Reversion" Algorithmic EA Engine
- **Setup Candle ($C_1$, index `len - 2`):** Pierces Upper or Lower Bollinger Bands with RSI extreme (`<= 30` or `>= 70`).
- **Trigger Candle ($C_0$, index `len - 1`):** Closes back inside the band with candle body direction confirmation and RSI hooking directionally.
- **EMA 200 Macro Trend Filter:** Configurable modes (`WITH_TREND_ONLY`, `STRICT_COUNTER_TREND`, `OFF`).
- **Volatility Storm Filter:** Bollinger Band Width Expansion rate (`BBW Expansion %`) rejects entries during trend breakout storms (Anti-Band Walking).
- **15-Candle Divergence Detector:** Identifies Regular and Hidden Bullish/Bearish RSI Divergences for trade confluence.

### 2. Gate 3: AI Confluence Judge (BYOK Architecture)
- Sends structured quantitative technical snapshot to OpenAI-compatible LLM endpoints (OpenAI, Google Gemini, Groq, DeepSeek, or custom).
- Evaluates setup quality, adverse wick ratios, and risk-to-reward ratio.
- Enforces strict JSON response schema:
  ```json
  {
    "decision": "EXECUTE" | "REJECT",
    "confidence_score": 85,
    "recommended_sl_pips": 25,
    "recommended_tp_pips": 50,
    "reasoning": "Strong lower wick absorption with confirmed bullish divergence."
  }
  ```
- **Execution Threshold:** Trades fire only if `decision === "EXECUTE"` and `confidence_score >= threshold` (default `75%`).
- **Zero-Key Heuristic Fallback:** If no LLM key is configured, an institutional quantitative scoring model evaluates signals deterministically.

### 3. 2-Stage Smart Trailing Stop & Auto Partial Close
- **Stage 1 (Breakeven + 50% Profit Banking):**
  - Once price reaches `>= 70%` toward Middle Bollinger Band:
  - If lot size &gt;= `0.02`, automatically closes 50% volume via API to lock in cash profit.
  - Moves Stop Loss to Breakeven + 2 pips buffer.
- **Stage 2 (Dynamic Profit Trailing):**
  - Once price crosses Middle BB or exceeds `trailingStartPips + trailingDistPips`:
  - Trails Stop Loss at `trailingDistPips` behind peak/trough price.
  - Enforces Anti-Spam threshold (`trailingStepPips`) to avoid spamming the Exness API.

### 4. Institutional Safeguards & Circuit Breakers
- **Idempotency Anti-Double-Order Lock:** Deterministic `${symbol}_${timeframe}_${timestamp}_${side}` lock prevents duplicate orders on the same candle.
- **AI Latency Slippage Guard:** Aborts orders if market moves unfavorably by more than `maxSlippagePips` while waiting for AI response.
- **Exness Daily Rollover Blackout Window:** Pauses new entries and freezes trailing stops during low-liquidity rollover (`21:00 - 22:15 UTC` / `04:00 - 05:15 WIB`) to prevent spread-spike stop-outs.
- **Institutional Limits:** Spread filter, max concurrent positions, and daily realized loss limit circuit breaker.

---

## 🚀 Quick Start

### Installation
```bash
npm install
```

### Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to view the Quantitative Trading Command Center.

### Production Build
```bash
npm run build
npm start
```

### 24/7 Heartbeat Daemon (Termux / PM2 / Linux Background)
To keep trailing stops and entries running 24/7 even when browser tabs are closed:
```bash
npm run worker
```
Or with PM2:
```bash
pm2 start "npm run worker" --name "exness-ai-trader"
```

---

## 📁 Project Directory Structure
```
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── ai-judge/route.ts      # BYOK AI Confluence evaluator
│   │   │   ├── engine-tick/route.ts   # Serverless-safe execution tick & multi-pair scanner
│   │   │   └── exness/route.ts        # Direct Exness REST API proxy
│   │   ├── globals.css                # Dark mode styling & custom scrollbars
│   │   ├── layout.tsx                 # Root layout
│   │   └── page.tsx                   # Main Trading Terminal Dashboard
│   ├── components/
│   │   ├── ActivePositionsTable.tsx   # Live positions, PnL, 50% partial & trailing stage badges
│   │   ├── ApiKeyModal.tsx            # BYOK AES-256-GCM Credential Manager
│   │   ├── ControlPanel.tsx           # Pair selector, auto-preset loader, lot size, trailing params
│   │   ├── HeaderBar.tsx              # Demo/Real switcher, latency, rollover badge, balance/equity
│   │   ├── TelemetryLog.tsx           # Live terminal execution log
│   │   └── TradingChart.tsx           # HTML5 Canvas chart with BB(20,2), EMA(200), RSI & position lines
│   ├── core/
│   │   ├── aiJudge.ts                 # AI Confluence Judge & JSON schema parser
│   │   ├── exnessClient.ts            # Dual-environment REST/WSS client & realistic simulator
│   │   ├── indicatorEngine.ts         # RSI(14), BB(20,2), EMA(200), ATR(14), 15-candle divergence
│   │   ├── pairConfig.ts              # Adaptive strategy presets for XAUUSDm, EURUSDm, GBPUSDm, USDJPYm
│   │   ├── riskGuard.ts               # Idempotency lock, slippage guard, rollover blackout, circuit breakers
│   │   ├── signalGate.ts              # 3-Gate Snap-Back Reversion EA engine
│   │   └── trailingManager.ts         # 2-Stage dynamic trailing stop & auto 50% partial close
│   ├── lib/
│   │   └── cryptoVault.ts             # AES-256-GCM encryption for credentials
│   ├── scripts/
│   │   └── daemonRunner.ts            # Standalone 24/7 CLI heartbeat worker
│   └── store/
│       └── useTradingStore.ts         # Zustand global state store
├── package.json
├── tsconfig.json
├── tailwind.config.js
└── README.md
```
