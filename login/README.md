# Standalone Full-Stack License Portal & Admin Dashboard

A production-grade, standalone Node.js & Express license management application and dark-mode web portal for quantitative trading bots and software terminals. Persists all state to an atomic, concurrency-safe JSON database (`licenses_db.json`).

---

## 🌟 Features

- **Zero 404 Standalone Experience**: Serves both modern dark-mode frontend views (`GET /` and `GET /admin`) directly from `server.js` with zero build tools or bundlers required.
- **Institutional Quant Theme (`slate-950`)**: Designed with high-frequency trading terminal aesthetics (deep slate-950 background, glowing status beacons, monospace license typography).
- **Tab 1: License Login & Live Session**:
  - Validates `EQ-7D-XXXX-XXXX` and `EQ-30D-XXXX-XXXX` keys.
  - Live preview screen showing unlocked status (`@username`, telegram, remaining days/hours countdown, feature matrix).
  - Automatically persists active sessions in browser `localStorage`.
- **Tab 2: Multi-Step Registration & Invoicing**:
  - Step 1: Input email, username, Telegram (@handle), and select 7-Day or 30-Day plan.
  - Step 2: Payment screen supporting **🇮🇩 QRIS (IDR + 3-digit unique code)** with dynamic QR Code, and **🌐 USDT TRC-20** with wallet deposit QR.
  - 15-minute live countdown timer, 1-click copy helpers, and *"Saya Sudah Bayar (Konfirmasi)"* button that registers a `PENDING` request for Admin review.
- **Protected Admin Dashboard (`/admin`)**:
  - Master Key security gate (default: `admin123`).
  - **4 Summary KPI Cards**: Total Users, Active Licenses, Pending Payments, Expired/Revoked Keys.
  - **1-Click Manual License Generator**: Generates instant `EQ-7D-...` or `EQ-30D-...` keys with 1-click copy.
  - **Pending Payment Approval Queue**: 1-click approve & activate for incoming QRIS/USDT registrations.
  - **License Management Table**: Live search and filter (`ALL`, `ACTIVE`, `PENDING`, `EXPIRED`, `REVOKED`) with actions (`Copy Key`, `Approve`, `+7D`, `+30D`, `Revoke/Activate`, `Delete`).
- **RESTful API**:
  - `POST /api/license/verify`: Validates key, checks expiration, returns session data.
  - `POST /api/license/checkout`: Generates registration, reserved pending key, and invoice.
  - `POST /api/license/confirm-payment`: Marks payment as confirmed by client.
  - `GET /api/license/invoice/:id`: Polling endpoint for real-time order status.
  - `GET /api/license/admin`: Retrieves enriched licenses, stats, and pending queue (requires `x-admin-key`).
  - `POST /api/license/admin`: Handles `CREATE`, `APPROVE`, `EXTEND`, `REVOKE`, `DELETE` (requires `x-admin-key`).

---

## 📁 Directory Structure

```text
├── server.js                # Express entry point serving HTML routes & API
├── db.js                    # Atomic JSON database manager with mutex lock
├── licenses_db.json         # JSON database storing users, licenses, and invoices
├── routes/
│   └── licenseRoutes.js     # API routes (portal, checkout, admin, legacy)
├── utils/
│   └── licenseGenerator.js  # Cryptographic license key generator
├── public/
│   ├── index.html           # User License Portal (Login & Multi-Step Checkout)
│   ├── admin.html           # Protected Admin Management Dashboard
│   └── 404.html             # Institutional dark-mode 404 fallback
├── components/
│   └── LicenseLoginModal.tsx # React / Next.js modal component for terminal integration
├── test.js                  # Automated 23-point end-to-end test suite
├── package.json             # NPM project manifest
└── README.md                # Documentation
```

---

## 🚀 Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Standalone Server
Run in development mode (with auto-reload):
```bash
npm run dev
```
Or in standard mode:
```bash
npm start
```

### 3. Open in Browser
- **User Portal**: [http://localhost:3000](http://localhost:3000)
- **Admin Dashboard**: [http://localhost:3000/admin](http://localhost:3000/admin) (Password: `admin123`)
- **API Status**: [http://localhost:3000/api](http://localhost:3000/api)

### 4. Run Automated Tests
```bash
npm test
```
All 23 test suites will run against an isolated ephemeral database and report results.

---

## 🔐 Admin Authentication
Admin routes require the master key provided in the `x-admin-key` header (or `?key=...` query parameter):
```bash
curl -H "x-admin-key: admin123" http://localhost:3000/api/license/admin
```
The master key can be configured via environment variable:
```env
ADMIN_SECRET=your_secure_password
PORT=3000
```
