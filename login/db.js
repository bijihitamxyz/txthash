const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateLicenseKey } = require('./utils/licenseGenerator');

// Path to JSON database file (configurable via environment variable)
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'licenses_db.json');
const TMP_FILE = `${DB_FILE}.tmp`;

// Initial structure for a blank database
const DEFAULT_DATA = {
  users: [],
  licenses: [],
  invoices: []
};

// Operation queue for concurrency safety across asynchronous operations
let queue = Promise.resolve();

/**
 * Executes a function within a sequential lock queue to prevent race conditions during file updates.
 * @param {Function} taskFn - Asynchronous callback to execute
 * @returns {Promise<any>}
 */
function withLock(taskFn) {
  const result = queue.then(() => taskFn());
  // Continue chain even if current task throws
  queue = result.catch(() => {});
  return result;
}

/**
 * Initializes the database file if it does not exist or is empty.
 */
function initDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf-8');
      console.log(`[DB] Created new database file at: ${DB_FILE}`);
    } else {
      const content = fs.readFileSync(DB_FILE, 'utf-8').trim();
      if (!content) {
        fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf-8');
      } else {
        // Validate JSON integrity & ensure default keys
        const parsed = JSON.parse(content);
        let modified = false;
        if (!Array.isArray(parsed.users)) { parsed.users = []; modified = true; }
        if (!Array.isArray(parsed.licenses)) { parsed.licenses = []; modified = true; }
        if (!Array.isArray(parsed.invoices)) { parsed.invoices = []; modified = true; }
        if (modified) {
          fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2), 'utf-8');
        }
      }
    }
  } catch (err) {
    console.error(`[DB ERROR] Failed initializing database at ${DB_FILE}:`, err.message);
    throw err;
  }
}

/**
 * Reads the current data from licenses_db.json.
 * @returns {Promise<{users: Array, licenses: Array, invoices: Array}>}
 */
async function readData() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      initDb();
    }
    const raw = await fs.promises.readFile(DB_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.licenses)) data.licenses = [];
    if (!Array.isArray(data.invoices)) data.invoices = [];
    return data;
  } catch (err) {
    console.error(`[DB ERROR] Failed reading database:`, err.message);
    return { users: [], licenses: [], invoices: [] };
  }
}

/**
 * Atomically writes data to licenses_db.json using a temp file + rename.
 * @param {Object} data - The database state object
 */
async function writeData(data) {
  const payload = JSON.stringify(data, null, 2);
  await fs.promises.writeFile(TMP_FILE, payload, 'utf-8');
  await fs.promises.rename(TMP_FILE, DB_FILE);
}

/**
 * Finds a user by their unique userId.
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function findUserById(userId) {
  const data = await readData();
  return data.users.find((u) => u.userId === userId) || null;
}

/**
 * Finds a user matching an email or username (case-insensitive).
 * @param {string} email
 * @param {string} username
 * @returns {Promise<{user: Object|null, conflictField: string|null}>}
 */
async function findUserByEmailOrUsername(email, username) {
  const data = await readData();
  const normalizedEmail = (email || '').trim().toLowerCase();
  const normalizedUsername = (username || '').trim().toLowerCase();

  for (const user of data.users) {
    if (user.email && user.email.toLowerCase() === normalizedEmail) {
      return { user, conflictField: 'email' };
    }
    if (user.username && user.username.toLowerCase() === normalizedUsername) {
      return { user, conflictField: 'username' };
    }
  }

  return { user: null, conflictField: null };
}

/**
 * Registers a new user in the database.
 * @param {Object} param0
 * @param {string} param0.email
 * @param {string} param0.username
 * @param {string} param0.telegram
 * @returns {Promise<Object>} The created user record
 */
async function createUser({ email, username, telegram }) {
  return withLock(async () => {
    const data = await readData();

    // Uniqueness check under lock to prevent race condition
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username.trim().toLowerCase();

    const existingUser = data.users.find(
      (u) =>
        (u.email && u.email.toLowerCase() === normalizedEmail) ||
        (u.username && u.username.toLowerCase() === normalizedUsername)
    );

    if (existingUser) {
      const field = existingUser.email.toLowerCase() === normalizedEmail ? 'email' : 'username';
      const err = new Error(`User with this ${field} already exists.`);
      err.code = 'USER_EXISTS';
      err.field = field;
      throw err;
    }

    const newUser = {
      userId: `usr_${crypto.randomBytes(6).toString('hex')}`,
      email: email.trim(),
      username: username.trim(),
      telegram: telegram ? telegram.trim() : `@${username.trim()}`,
      createdAt: new Date().toISOString()
    };

    data.users.push(newUser);
    await writeData(data);
    return newUser;
  });
}

/**
 * Calculates milliseconds for duration string ('7d' or '30d').
 * @param {string} duration
 * @returns {number} Duration in milliseconds
 */
function getDurationMs(duration) {
  switch (duration) {
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Invalid duration '${duration}'. Supported durations are '7d' or '30d'.`);
  }
}

/**
 * Generates and stores a new license key for a user.
 * Supports custom prefix (e.g. 'EQ-7D', 'EQ-30D', or 'EQ') and initial status ('ACTIVE' or 'PENDING').
 *
 * @param {Object} param0
 * @param {string} param0.userId
 * @param {'7d'|'30d'} param0.duration
 * @param {string} [param0.prefix='EQ']
 * @param {'ACTIVE'|'PENDING'|'REVOKED'} [param0.status='ACTIVE']
 * @param {string} [param0.createdAt]
 * @param {string} [param0.expiresAt]
 * @returns {Promise<Object>} The generated license record
 */
async function createLicense({
  userId,
  duration = '7d',
  prefix = 'EQ',
  status = 'ACTIVE',
  createdAt = null,
  expiresAt = null
}) {
  return withLock(async () => {
    const data = await readData();

    // Verify user exists
    const user = data.users.find((u) => u.userId === userId);
    if (!user) {
      const err = new Error(`User with ID '${userId}' not found.`);
      err.code = 'USER_NOT_FOUND';
      throw err;
    }

    const durationMs = getDurationMs(duration);
    const now = new Date();
    const createdTimestamp = createdAt || now.toISOString();
    const expiresTimestamp = expiresAt || new Date(now.getTime() + durationMs).toISOString();

    // Generate unique license key
    let licenseKey;
    let attempts = 0;
    do {
      licenseKey = generateLicenseKey(prefix);
      attempts++;
      if (attempts > 50) {
        throw new Error('Failed to generate a unique license key. Please try again.');
      }
    } while (data.licenses.some((l) => l.licenseKey === licenseKey));

    const newLicense = {
      licenseKey,
      userId,
      duration,
      status,
      createdAt: createdTimestamp,
      expiresAt: expiresTimestamp
    };

    data.licenses.push(newLicense);
    await writeData(data);
    return newLicense;
  });
}

/**
 * Creates and saves an invoice for a pending checkout order.
 *
 * @param {Object} invoiceData
 * @returns {Promise<Object>}
 */
async function createInvoice(invoiceData) {
  return withLock(async () => {
    const data = await readData();
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomSuffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    const invoiceId = invoiceData.invoiceId || `INV-${dateStr}-${randomSuffix}`;
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString(); // 15 mins countdown

    const newInvoice = {
      invoiceId,
      userId: invoiceData.userId,
      username: invoiceData.username,
      email: invoiceData.email,
      telegram: invoiceData.telegram,
      duration: invoiceData.duration,
      paymentMethod: invoiceData.paymentMethod || 'QRIS',
      baseAmount: invoiceData.baseAmount || (invoiceData.duration === '30d' ? 500000 : 150000),
      uniqueCode: invoiceData.uniqueCode || 0,
      totalAmount: invoiceData.totalAmount || (invoiceData.duration === '30d' ? 500000 : 150000),
      amountUsdt: invoiceData.amountUsdt || (invoiceData.duration === '30d' ? 35 : 10),
      licenseKey: invoiceData.licenseKey,
      qrisPayload: invoiceData.qrisPayload || '',
      usdtAddress: invoiceData.usdtAddress || 'TExnessQuantTRC20OfficialWallet789',
      status: 'PENDING',
      userConfirmed: false,
      createdAt: now.toISOString(),
      expiresAt
    };

    data.invoices.push(newInvoice);
    await writeData(data);
    return newInvoice;
  });
}

/**
 * Finds an invoice by invoiceId or licenseKey.
 * @param {string} invoiceIdOrKey
 * @returns {Promise<Object|null>}
 */
async function findInvoiceById(invoiceIdOrKey) {
  const data = await readData();
  const cleanId = (invoiceIdOrKey || '').trim().toUpperCase();
  return (
    data.invoices.find(
      (i) => i.invoiceId.toUpperCase() === cleanId || i.licenseKey.toUpperCase() === cleanId
    ) || null
  );
}

/**
 * Marks user payment confirmation on an invoice.
 * @param {string} invoiceIdOrKey
 * @returns {Promise<Object>}
 */
async function confirmInvoicePayment(invoiceIdOrKey) {
  return withLock(async () => {
    const data = await readData();
    const cleanId = (invoiceIdOrKey || '').trim().toUpperCase();
    const inv = data.invoices.find(
      (i) => i.invoiceId.toUpperCase() === cleanId || i.licenseKey.toUpperCase() === cleanId
    );

    if (!inv) {
      const err = new Error('Invoice not found.');
      err.code = 'INVOICE_NOT_FOUND';
      throw err;
    }

    inv.userConfirmed = true;
    inv.confirmedAt = new Date().toISOString();
    await writeData(data);
    return inv;
  });
}

/**
 * Finds a license by its key (case-insensitive).
 * @param {string} licenseKey
 * @returns {Promise<Object|null>}
 */
async function findLicenseByKey(licenseKey) {
  const data = await readData();
  const cleanKey = (licenseKey || '').trim().toUpperCase();
  return data.licenses.find((l) => l.licenseKey.toUpperCase() === cleanKey) || null;
}

/**
 * Verifies a license key, automatically marking expired licenses in the DB if necessary.
 * Returns the license, associated user, and detailed validity metadata.
 *
 * @param {string} licenseKey
 * @returns {Promise<{found: boolean, valid: boolean, license?: Object, user?: Object, reason?: string}>}
 */
async function verifyLicenseKey(licenseKey) {
  const normalizedKey = (licenseKey || '').trim().toUpperCase();

  return withLock(async () => {
    const data = await readData();
    const license = data.licenses.find((l) => l.licenseKey.toUpperCase() === normalizedKey);

    if (!license) {
      return {
        found: false,
        valid: false,
        reason: 'License key not found.'
      };
    }

    // Lookup user details
    const user = data.users.find((u) => u.userId === license.userId) || null;

    // Check if status is PENDING
    if (license.status === 'PENDING') {
      return {
        found: true,
        valid: false,
        license: { ...license },
        user: user ? { ...user } : null,
        reason: 'License key is pending payment approval from Admin.'
      };
    }

    // Check if status is REVOKED
    if (license.status === 'REVOKED') {
      return {
        found: true,
        valid: false,
        license: { ...license },
        user: user ? { ...user } : null,
        reason: 'License key has been revoked by Admin.'
      };
    }

    // Check expiration timestamp for ACTIVE keys
    const now = Date.now();
    const expiresAtTime = new Date(license.expiresAt).getTime();
    const isPastExpiration = now > expiresAtTime;

    let dbUpdated = false;

    // If expiration date has passed but status was still ACTIVE, update it
    if (isPastExpiration && license.status === 'ACTIVE') {
      license.status = 'EXPIRED';
      dbUpdated = true;
    }

    if (dbUpdated) {
      await writeData(data);
    }

    // License is valid ONLY if status is ACTIVE and current time is before expiresAt
    const isValid = license.status === 'ACTIVE' && !isPastExpiration;

    let reason;
    if (isValid) {
      reason = 'License is active and valid.';
    } else if (license.status === 'EXPIRED' || isPastExpiration) {
      reason = 'License key has expired.';
    } else {
      reason = `License status is ${license.status}.`;
    }

    return {
      found: true,
      valid: isValid,
      license: { ...license },
      user: user ? { ...user } : null,
      reason
    };
  });
}

/**
 * Approves a pending license or invoice, activating the license from the current time.
 * @param {string} identifier - licenseKey or invoiceId
 * @returns {Promise<{license: Object, invoice: Object|null}>}
 */
async function approvePendingLicense(identifier) {
  return withLock(async () => {
    const data = await readData();
    const cleanId = (identifier || '').trim().toUpperCase();

    // Look for license
    let license = data.licenses.find((l) => l.licenseKey.toUpperCase() === cleanId);

    // Look for invoice
    let invoice = data.invoices.find(
      (i) => i.invoiceId.toUpperCase() === cleanId || i.licenseKey.toUpperCase() === cleanId
    );

    if (!license && invoice) {
      license = data.licenses.find((l) => l.licenseKey.toUpperCase() === invoice.licenseKey.toUpperCase());
    }

    if (!license) {
      const err = new Error('License key or invoice not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const now = new Date();
    const duration = license.duration || (invoice ? invoice.duration : '7d');
    const durationMs = getDurationMs(duration);

    // Activate license
    license.status = 'ACTIVE';
    license.createdAt = now.toISOString();
    license.expiresAt = new Date(now.getTime() + durationMs).toISOString();

    if (invoice) {
      invoice.status = 'APPROVED';
      invoice.approvedAt = now.toISOString();
    }

    await writeData(data);
    return { license, invoice: invoice || null };
  });
}

/**
 * Extends a license duration by specified days.
 * @param {string} licenseKey
 * @param {number} [days=7]
 * @returns {Promise<Object>}
 */
async function extendLicense(licenseKey, days = 7) {
  return withLock(async () => {
    const data = await readData();
    const cleanKey = (licenseKey || '').trim().toUpperCase();
    const license = data.licenses.find((l) => l.licenseKey.toUpperCase() === cleanKey);

    if (!license) {
      const err = new Error('License key not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const daysToAdd = typeof days === 'number' && days > 0 ? days : 7;
    const now = Date.now();
    const curExp = new Date(license.expiresAt).getTime();
    const base = curExp > now ? curExp : now;

    license.expiresAt = new Date(base + daysToAdd * 24 * 60 * 60 * 1000).toISOString();
    license.status = 'ACTIVE';

    await writeData(data);
    return license;
  });
}

/**
 * Toggles license revocation status.
 * @param {string} licenseKey
 * @returns {Promise<Object>}
 */
async function revokeLicense(licenseKey) {
  return withLock(async () => {
    const data = await readData();
    const cleanKey = (licenseKey || '').trim().toUpperCase();
    const license = data.licenses.find((l) => l.licenseKey.toUpperCase() === cleanKey);

    if (!license) {
      const err = new Error('License key not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    license.status = license.status === 'REVOKED' ? 'ACTIVE' : 'REVOKED';
    await writeData(data);
    return license;
  });
}

/**
 * Permanently deletes a license and associated invoice records.
 * @param {string} licenseKey
 * @returns {Promise<boolean>}
 */
async function deleteLicense(licenseKey) {
  return withLock(async () => {
    const data = await readData();
    const cleanKey = (licenseKey || '').trim().toUpperCase();
    const initialLicCount = data.licenses.length;

    data.licenses = data.licenses.filter((l) => l.licenseKey.toUpperCase() !== cleanKey);
    data.invoices = data.invoices.filter((i) => i.licenseKey.toUpperCase() !== cleanKey);

    if (data.licenses.length === initialLicCount) {
      const err = new Error('License key not found.');
      err.code = 'NOT_FOUND';
      throw err;
    }

    await writeData(data);
    return true;
  });
}

/**
 * Returns database statistics (counts of users, active, pending, expired, revoked licenses).
 * @returns {Promise<{usersCount: number, licensesCount: number, activeLicenses: number, pendingLicenses: number, expiredLicenses: number, revokedLicenses: number, pendingInvoices: number}>}
 */
async function getStats() {
  const data = await readData();
  const now = Date.now();
  let active = 0;
  let expired = 0;
  let pending = 0;
  let revoked = 0;

  for (const l of data.licenses) {
    if (l.status === 'PENDING') {
      pending++;
    } else if (l.status === 'REVOKED') {
      revoked++;
    } else if (l.status === 'ACTIVE' && new Date(l.expiresAt).getTime() > now) {
      active++;
    } else {
      expired++;
    }
  }

  const pendingInvoices = data.invoices.filter((i) => i.status === 'PENDING').length;

  return {
    usersCount: data.users.length,
    licensesCount: data.licenses.length,
    activeLicenses: active,
    pendingLicenses: pending,
    expiredLicenses: expired,
    revokedLicenses: revoked,
    pendingInvoices
  };
}

module.exports = {
  DB_FILE,
  initDb,
  readData,
  writeData,
  findUserById,
  findUserByEmailOrUsername,
  createUser,
  createLicense,
  createInvoice,
  findInvoiceById,
  confirmInvoicePayment,
  findLicenseByKey,
  verifyLicenseKey,
  approvePendingLicense,
  extendLicense,
  revokeLicense,
  deleteLicense,
  getStats,
  getDurationMs
};
