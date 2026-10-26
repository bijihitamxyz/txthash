const express = require('express');
const router = express.Router();
const db = require('../db');

// Basic email regex pattern for format validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Admin secret key
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin123';

/**
 * Authentication middleware for Admin routes.
 * Checks x-admin-key header, query parameter ?key=..., or body.adminKey.
 */
function verifyAdminKey(req, res, next) {
  const providedKey =
    req.headers['x-admin-key'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.key ||
    req.body?.adminKey;

  if (providedKey !== ADMIN_SECRET) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid Admin Master Key.',
      code: 'UNAUTHORIZED_ADMIN'
    });
  }
  next();
}

/**
 * Helper to generate mock valid QRIS raw string for IDR payments.
 * Format based on EMVCo QR Code specification for QRIS.
 */
function generateQrisPayload(amount, invoiceId) {
  const amtStr = String(amount);
  return (
    `00020101021226590014ID.LINKAJA.WWW0118936009143820491823021593600914382049180303UMI` +
    `51440014ID.CO.QRIS.WWW0215ID10200210000010303UMI52045499530336054${amtStr.padStart(2, '0')}` +
    `${amtStr}5802ID5919EXNESS QUANT BOT6007JAKARTA61051234062${String(invoiceId.length + 4).padStart(2, '0')}` +
    `07${String(invoiceId.length).padStart(2, '0')}${invoiceId}6304`
  );
}

// ============================================================================
// Public Endpoints
// ============================================================================

/**
 * POST /api/register
 * Legacy endpoint: Accepts email, username, telegram.
 */
router.post('/register', async (req, res, next) => {
  try {
    const { email, username, telegram } = req.body;

    if (!email || typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({
        success: false,
        error: "Field 'email' is required and must be a valid non-empty string.",
        code: 'MISSING_EMAIL'
      });
    }

    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({
        success: false,
        error: "Field 'username' is required and must be a valid non-empty string.",
        code: 'MISSING_USERNAME'
      });
    }

    if (!telegram || typeof telegram !== 'string' || !telegram.trim()) {
      return res.status(400).json({
        success: false,
        error: "Field 'telegram' is required and must be a valid non-empty string.",
        code: 'MISSING_TELEGRAM'
      });
    }

    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();
    const trimmedTelegram = telegram.trim();

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email address format.',
        code: 'INVALID_EMAIL'
      });
    }

    const { user: conflictUser, conflictField } = await db.findUserByEmailOrUsername(
      trimmedEmail,
      trimmedUsername
    );

    if (conflictUser) {
      return res.status(409).json({
        success: false,
        error: `A user with this ${conflictField} already exists.`,
        code: 'USER_ALREADY_EXISTS',
        conflictField
      });
    }

    const newUser = await db.createUser({
      email: trimmedEmail,
      username: trimmedUsername,
      telegram: trimmedTelegram
    });

    return res.status(201).json({
      success: true,
      message: 'User registered successfully.',
      user: newUser
    });
  } catch (err) {
    if (err.code === 'USER_EXISTS') {
      return res.status(409).json({
        success: false,
        error: err.message,
        code: 'USER_ALREADY_EXISTS',
        conflictField: err.field
      });
    }
    return next(err);
  }
});

/**
 * POST /api/generate-license
 * Legacy endpoint: Generates EQ-XXXX-XXXX for backward compatibility with test.js
 */
router.post('/generate-license', async (req, res, next) => {
  try {
    const { userId, duration } = req.body;

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({
        success: false,
        error: "Field 'userId' is required.",
        code: 'MISSING_USER_ID'
      });
    }

    if (!duration || (duration !== '7d' && duration !== '30d')) {
      return res.status(400).json({
        success: false,
        error: "Field 'duration' is required and must be either '7d' or '30d'.",
        code: 'INVALID_DURATION'
      });
    }

    const trimmedUserId = userId.trim();
    const user = await db.findUserById(trimmedUserId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: `User with userId '${trimmedUserId}' was not found.`,
        code: 'USER_NOT_FOUND'
      });
    }

    // Default prefix 'EQ' generates EQ-XXXX-XXXX
    const license = await db.createLicense({
      userId: trimmedUserId,
      duration,
      prefix: 'EQ'
    });

    return res.status(201).json({
      success: true,
      message: 'License generated successfully.',
      license
    });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: err.message,
        code: 'USER_NOT_FOUND'
      });
    }
    return next(err);
  }
});

/**
 * POST /api/verify-license
 * Legacy endpoint returning user details and status.
 */
router.post('/verify-license', async (req, res, next) => {
  try {
    const { licenseKey } = req.body;

    if (!licenseKey || typeof licenseKey !== 'string' || !licenseKey.trim()) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: "Field 'licenseKey' is required.",
        code: 'MISSING_LICENSE_KEY'
      });
    }

    const result = await db.verifyLicenseKey(licenseKey);

    if (!result.found) {
      return res.status(404).json({
        success: false,
        valid: false,
        error: 'License key not found.',
        code: 'LICENSE_NOT_FOUND'
      });
    }

    return res.status(200).json({
      success: true,
      valid: result.valid,
      status: result.license ? result.license.status : 'UNKNOWN',
      message: result.reason,
      license: result.license,
      user: result.user
    });
  } catch (err) {
    return next(err);
  }
});

// ============================================================================
// New License Portal Endpoints
// ============================================================================

/**
 * POST /api/license/verify
 * Validates key, checks expiration, and returns comprehensive user session data.
 */
router.post('/license/verify', async (req, res, next) => {
  try {
    const { licenseKey } = req.body;

    if (!licenseKey || typeof licenseKey !== 'string' || !licenseKey.trim()) {
      return res.status(400).json({
        success: false,
        valid: false,
        status: 'BAD_REQUEST',
        message: 'License key is required.'
      });
    }

    const cleanKey = licenseKey.trim().toUpperCase();
    const result = await db.verifyLicenseKey(cleanKey);

    if (!result.found || !result.license) {
      return res.status(200).json({
        success: false,
        valid: false,
        status: 'NOT_FOUND',
        message: 'License key not found. Please verify your key and try again.'
      });
    }

    const now = Date.now();
    const expiresAtMs = new Date(result.license.expiresAt).getTime();
    const remainingMs = Math.max(0, expiresAtMs - now);
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
    const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));

    if (!result.valid) {
      return res.status(200).json({
        success: false,
        valid: false,
        status: result.license.status,
        message: result.reason,
        licenseKey: result.license.licenseKey,
        expiresAt: result.license.expiresAt,
        user: result.user
      });
    }

    return res.status(200).json({
      success: true,
      valid: true,
      status: result.license.status,
      message: 'License is active and authenticated.',
      licenseKey: result.license.licenseKey,
      username: result.user ? result.user.username : 'TraderQuant',
      telegram: result.user ? result.user.telegram : '',
      email: result.user ? result.user.email : '',
      duration: result.license.duration,
      createdAt: result.license.createdAt,
      expiresAt: result.license.expiresAt,
      remainingMs,
      remainingDays,
      remainingHours,
      license: result.license,
      user: result.user
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/license/checkout
 * Creates a user registration + pending invoice (QRIS / USDT) with reserved license key.
 */
router.post('/license/checkout', async (req, res, next) => {
  try {
    const { email, username, telegram, duration, paymentMethod } = req.body;

    if (!email || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({
        success: false,
        error: 'A valid email address is required.',
        code: 'INVALID_EMAIL'
      });
    }

    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Username is required (minimum 2 characters).',
        code: 'INVALID_USERNAME'
      });
    }

    const cleanEmail = email.trim();
    const cleanUsername = username.trim();
    const cleanTelegram = (telegram || `@${cleanUsername}`).trim();
    const validDuration = duration === '30d' ? '30d' : '7d';
    const validPaymentMethod = paymentMethod === 'USDT' ? 'USDT' : 'QRIS';

    // Check or create user
    let userRecord = null;
    const { user: existingUser } = await db.findUserByEmailOrUsername(cleanEmail, cleanUsername);

    if (existingUser) {
      userRecord = existingUser;
    } else {
      userRecord = await db.createUser({
        email: cleanEmail,
        username: cleanUsername,
        telegram: cleanTelegram
      });
    }

    // Pricing & unique code computation
    const is30d = validDuration === '30d';
    const baseAmount = is30d ? 500000 : 150000;
    const amountUsdt = is30d ? 35 : 10;
    // 3-digit random unique code between 101 and 989
    const uniqueCode = Math.floor(100 + Math.random() * 890);
    const totalAmount = baseAmount + uniqueCode;

    // Generate duration-specific prefix (EQ-7D or EQ-30D)
    const keyPrefix = is30d ? 'EQ-30D' : 'EQ-7D';

    // Create license in PENDING status
    const pendingLicense = await db.createLicense({
      userId: userRecord.userId,
      duration: validDuration,
      prefix: keyPrefix,
      status: 'PENDING'
    });

    // Create invoice record
    const invoice = await db.createInvoice({
      userId: userRecord.userId,
      username: userRecord.username,
      email: userRecord.email,
      telegram: userRecord.telegram,
      duration: validDuration,
      paymentMethod: validPaymentMethod,
      baseAmount,
      uniqueCode,
      totalAmount,
      amountUsdt,
      licenseKey: pendingLicense.licenseKey,
      qrisPayload: generateQrisPayload(totalAmount, pendingLicense.licenseKey),
      usdtAddress: 'TExnessQuantTRC20OfficialWallet789'
    });

    return res.status(201).json({
      success: true,
      message: 'Checkout invoice created successfully.',
      invoice,
      license: pendingLicense,
      user: userRecord
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/license/confirm-payment
 * Marks that client has clicked "Saya Sudah Bayar (Konfirmasi)"
 */
router.post('/license/confirm-payment', async (req, res, next) => {
  try {
    const { invoiceId, licenseKey } = req.body;
    const identifier = invoiceId || licenseKey;

    if (!identifier) {
      return res.status(400).json({
        success: false,
        error: 'invoiceId or licenseKey is required.'
      });
    }

    const updatedInvoice = await db.confirmInvoicePayment(identifier);

    return res.status(200).json({
      success: true,
      message: 'Pembayaran telah dikonfirmasi oleh pengguna. Menunggu verifikasi admin.',
      invoice: updatedInvoice
    });
  } catch (err) {
    if (err.code === 'INVOICE_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'Invoice not found.' });
    }
    return next(err);
  }
});

/**
 * GET /api/license/invoice/:invoiceId
 * Returns current status of an invoice (e.g. for polling checkout page).
 */
router.get('/license/invoice/:invoiceId', async (req, res, next) => {
  try {
    const invoice = await db.findInvoiceById(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({ success: false, error: 'Invoice not found.' });
    }

    // Check associated license status
    const license = await db.findLicenseByKey(invoice.licenseKey);

    return res.status(200).json({
      success: true,
      invoice,
      license
    });
  } catch (err) {
    return next(err);
  }
});

// ============================================================================
// Protected Admin Management Endpoints
// ============================================================================

/**
 * GET /api/license/admin
 * Returns all licenses, pending invoices, users, and summary statistics.
 */
router.get('/license/admin', verifyAdminKey, async (req, res, next) => {
  try {
    const data = await db.readData();
    const stats = await db.getStats();
    const now = Date.now();

    // Map licenses with associated user information and remaining time
    const enrichedLicenses = data.licenses.map((lic) => {
      const user = data.users.find((u) => u.userId === lic.userId);
      const expiresAtMs = new Date(lic.expiresAt).getTime();
      const remainingMs = Math.max(0, expiresAtMs - now);
      const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
      const isExpired = lic.status === 'EXPIRED' || (lic.status === 'ACTIVE' && now > expiresAtMs);

      return {
        id: lic.licenseKey,
        licenseKey: lic.licenseKey,
        userId: lic.userId,
        username: user ? user.username : 'Unknown',
        telegram: user ? user.telegram : '-',
        email: user ? user.email : '-',
        duration: lic.duration,
        status: isExpired && lic.status === 'ACTIVE' ? 'EXPIRED' : lic.status,
        createdAt: lic.createdAt,
        expiresAt: lic.expiresAt,
        remainingDays: lic.status === 'ACTIVE' && !isExpired ? remainingDays : 0,
        isExpired
      };
    });

    // Enriched pending invoices
    const pendingInvoices = data.invoices.filter((i) => i.status === 'PENDING');

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers: stats.usersCount,
        totalLicenses: stats.licensesCount,
        activeLicenses: stats.activeLicenses,
        pendingLicenses: stats.pendingLicenses,
        expiredLicenses: stats.expiredLicenses,
        revokedLicenses: stats.revokedLicenses,
        pendingInvoices: stats.pendingInvoices
      },
      licenses: enrichedLicenses,
      pendingInvoices,
      users: data.users
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /api/license/admin
 * Admin actions: CREATE, APPROVE, EXTEND, REVOKE, DELETE
 */
router.post('/license/admin', verifyAdminKey, async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!action) {
      return res.status(400).json({ success: false, error: 'Field "action" is required.' });
    }

    const upperAction = String(action).toUpperCase();
    const data = await db.readData();

    // -------------------------------------------------------------
    // Action 1: CREATE (1-Click Manual License Generator)
    // -------------------------------------------------------------
    if (upperAction === 'CREATE') {
      const { username, telegram, email, duration } = req.body;

      if (!username || typeof username !== 'string' || !username.trim()) {
        return res.status(400).json({ success: false, error: 'Username is required.' });
      }

      const cleanUsername = username.trim();
      const cleanTelegram = (telegram || `@${cleanUsername}`).trim();
      const cleanEmail = (email || `${cleanUsername.toLowerCase()}@example.com`).trim();
      const validDuration = duration === '30d' ? '30d' : '7d';

      // Check or create user
      let user = data.users.find(
        (u) =>
          u.username.toLowerCase() === cleanUsername.toLowerCase() ||
          u.email.toLowerCase() === cleanEmail.toLowerCase()
      );

      if (!user) {
        user = await db.createUser({
          username: cleanUsername,
          telegram: cleanTelegram,
          email: cleanEmail
        });
      }

      // Format prefix: EQ-7D or EQ-30D
      const prefix = validDuration === '30d' ? 'EQ-30D' : 'EQ-7D';
      const license = await db.createLicense({
        userId: user.userId,
        duration: validDuration,
        prefix,
        status: 'ACTIVE'
      });

      return res.status(201).json({
        success: true,
        message: `License key ${license.licenseKey} created successfully.`,
        license: {
          id: license.licenseKey,
          licenseKey: license.licenseKey,
          userId: user.userId,
          username: user.username,
          telegram: user.telegram,
          email: user.email,
          duration: license.duration,
          status: license.status,
          createdAt: license.createdAt,
          expiresAt: license.expiresAt
        }
      });
    }

    // -------------------------------------------------------------
    // Action 2: APPROVE (Approve Pending Payment)
    // -------------------------------------------------------------
    if (upperAction === 'APPROVE') {
      const { licenseKey, invoiceId, id } = req.body;
      const target = licenseKey || invoiceId || id;

      if (!target) {
        return res.status(400).json({
          success: false,
          error: 'licenseKey or invoiceId is required for approval.'
        });
      }

      const approvedResult = await db.approvePendingLicense(target);
      return res.status(200).json({
        success: true,
        message: `License ${approvedResult.license.licenseKey} has been activated successfully!`,
        license: approvedResult.license,
        invoice: approvedResult.invoice
      });
    }

    // -------------------------------------------------------------
    // Action 3: EXTEND (Add +7D or +30D)
    // -------------------------------------------------------------
    if (upperAction === 'EXTEND') {
      const { licenseKey, id, days, duration } = req.body;
      const key = (licenseKey || id || '').trim();

      if (!key) {
        return res.status(400).json({ success: false, error: 'licenseKey is required.' });
      }

      let daysToAdd = 7;
      if (typeof days === 'number' && days > 0) {
        daysToAdd = days;
      } else if (duration === '30d') {
        daysToAdd = 30;
      }

      const updatedLic = await db.extendLicense(key, daysToAdd);
      return res.status(200).json({
        success: true,
        message: `License ${key} extended by +${daysToAdd} days.`,
        license: updatedLic
      });
    }

    // -------------------------------------------------------------
    // Action 4: REVOKE (Toggle Active / Revoked)
    // -------------------------------------------------------------
    if (upperAction === 'REVOKE') {
      const { licenseKey, id } = req.body;
      const key = (licenseKey || id || '').trim();

      if (!key) {
        return res.status(400).json({ success: false, error: 'licenseKey is required.' });
      }

      const updatedLic = await db.revokeLicense(key);
      return res.status(200).json({
        success: true,
        message: `License ${key} status changed to ${updatedLic.status}.`,
        license: updatedLic
      });
    }

    // -------------------------------------------------------------
    // Action 5: DELETE (Permanently Delete License)
    // -------------------------------------------------------------
    if (upperAction === 'DELETE') {
      const { licenseKey, id } = req.body;
      const key = (licenseKey || id || '').trim();

      if (!key) {
        return res.status(400).json({ success: false, error: 'licenseKey is required.' });
      }

      await db.deleteLicense(key);
      return res.status(200).json({
        success: true,
        message: `License ${key} deleted successfully.`
      });
    }

    return res.status(400).json({
      success: false,
      error: `Unsupported action '${action}'. Supported actions: CREATE, APPROVE, EXTEND, REVOKE, DELETE.`
    });
  } catch (err) {
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ success: false, error: err.message });
    }
    return next(err);
  }
});

/**
 * GET /api/health
 * Returns service status and DB statistics.
 */
router.get('/health', async (req, res, next) => {
  try {
    const stats = await db.getStats();
    return res.status(200).json({
      success: true,
      status: 'UP',
      timestamp: new Date().toISOString(),
      database: stats
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/users/:userId
 * Utility route to inspect a user and their licenses.
 */
router.get('/users/:userId', async (req, res, next) => {
  try {
    const user = await db.findUserById(req.params.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: `User '${req.params.userId}' not found.`
      });
    }

    const data = await db.readData();
    const userLicenses = data.licenses.filter((l) => l.userId === user.userId);
    const userInvoices = data.invoices.filter((i) => i.userId === user.userId);

    return res.status(200).json({
      success: true,
      user,
      licenses: userLicenses,
      invoices: userInvoices
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
