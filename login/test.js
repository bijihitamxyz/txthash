/**
 * Comprehensive Automated Test Suite for Node.js License Server & Portal
 *
 * Runs end-to-end tests against Express API endpoints, HTML routes, and Admin actions.
 * Usage: node test.js
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Use a dedicated test database to keep dev database pristine
const TEST_DB = path.join(__dirname, 'test_licenses_db.json');
process.env.DB_FILE = TEST_DB;
process.env.PORT = '0'; // Ephemeral port
process.env.ADMIN_SECRET = 'admin123';

// Clean test database before run
if (fs.existsSync(TEST_DB)) {
  fs.unlinkSync(TEST_DB);
}
const testTmp = `${TEST_DB}.tmp`;
if (fs.existsSync(testTmp)) {
  fs.unlinkSync(testTmp);
}

const { app } = require('./server');

// Helper to make HTTP requests to the test server
function makeRequest(server, options, payload = null) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const reqOptions = {
      hostname: '127.0.0.1',
      port: address.port,
      path: options.path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);

    if (payload) {
      req.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
    req.end();
  });
}

// Test assertion helper
let passedCount = 0;
let failedCount = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passedCount++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failedCount++;
  }
}

async function runTests() {
  console.log('\n=======================================================');
  console.log('🧪 Starting Exness Quant Full-Stack Automated Tests');
  console.log('=======================================================\n');

  // Start test server
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  try {
    let testUserId = null;
    let activeLicenseKey = null;
    let checkoutInvoiceId = null;
    let checkoutLicenseKey = null;

    // -------------------------------------------------------------
    // Test 1: Health check endpoint
    // -------------------------------------------------------------
    console.log('--- Test Suite 1: Health Check & System Status ---');
    const healthRes = await makeRequest(server, { path: '/api/health', method: 'GET' });
    assert(healthRes.statusCode === 200, 'GET /api/health returns 200 OK');
    assert(healthRes.body.success === true, 'GET /api/health success is true');
    assert(healthRes.body.database.usersCount === 0, 'Initial users count is 0');

    // -------------------------------------------------------------
    // Test 2: User Registration - Happy Path
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 2: User Registration ---');
    const regRes = await makeRequest(server, { path: '/api/register', method: 'POST' }, {
      email: 'alex@example.com',
      username: 'alexdev',
      telegram: '@alexdev'
    });

    assert(regRes.statusCode === 201, 'POST /api/register returns 201 Created');
    assert(regRes.body.success === true, 'Response has success=true');
    assert(!!regRes.body.user.userId, 'User has userId assigned');
    assert(regRes.body.user.email === 'alex@example.com', 'User email matches');
    assert(regRes.body.user.username === 'alexdev', 'User username matches');
    assert(regRes.body.user.telegram === '@alexdev', 'User telegram matches');
    assert(!!regRes.body.user.createdAt, 'User createdAt is populated');
    testUserId = regRes.body.user.userId;

    // -------------------------------------------------------------
    // Test 3: User Registration - Duplicate Validation
    // -------------------------------------------------------------
    const dupRes = await makeRequest(server, { path: '/api/register', method: 'POST' }, {
      email: 'alex@example.com',
      username: 'othername',
      telegram: '@other'
    });
    assert(dupRes.statusCode === 409, 'Duplicate email returns 409 Conflict');
    assert(dupRes.body.code === 'USER_ALREADY_EXISTS', 'Returns USER_ALREADY_EXISTS error code');

    // -------------------------------------------------------------
    // Test 4: User Registration - Field Validation
    // -------------------------------------------------------------
    const badEmailRes = await makeRequest(server, { path: '/api/register', method: 'POST' }, {
      email: 'invalid-email',
      username: 'validuser',
      telegram: '@valid'
    });
    assert(badEmailRes.statusCode === 400, 'Invalid email format returns 400 Bad Request');

    const missingFieldRes = await makeRequest(server, { path: '/api/register', method: 'POST' }, {
      email: 'test@test.com',
      username: 'test'
      // missing telegram
    });
    assert(missingFieldRes.statusCode === 400, 'Missing telegram returns 400 Bad Request');

    // -------------------------------------------------------------
    // Test 5: Generate License - Happy Path (7d)
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 3: Legacy License Generation ---');
    const gen7dRes = await makeRequest(server, { path: '/api/generate-license', method: 'POST' }, {
      userId: testUserId,
      duration: '7d'
    });

    assert(gen7dRes.statusCode === 201, 'POST /api/generate-license (7d) returns 201');
    assert(gen7dRes.body.success === true, 'License generation success=true');
    assert(/^EQ-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gen7dRes.body.license.licenseKey), 'Key format matches EQ-XXXX-XXXX');
    assert(gen7dRes.body.license.userId === testUserId, 'License references valid userId');
    assert(gen7dRes.body.license.duration === '7d', 'Duration is 7d');
    assert(gen7dRes.body.license.status === 'ACTIVE', 'License status is ACTIVE');

    const createdTime = new Date(gen7dRes.body.license.createdAt).getTime();
    const expiresTime = new Date(gen7dRes.body.license.expiresAt).getTime();
    const diffDays = Math.round((expiresTime - createdTime) / (1000 * 60 * 60 * 24));
    assert(diffDays === 7, 'Expiration timestamp is 7 days from creation');
    activeLicenseKey = gen7dRes.body.license.licenseKey;

    // -------------------------------------------------------------
    // Test 6: Generate License - Happy Path (30d)
    // -------------------------------------------------------------
    const gen30dRes = await makeRequest(server, { path: '/api/generate-license', method: 'POST' }, {
      userId: testUserId,
      duration: '30d'
    });
    assert(gen30dRes.statusCode === 201, 'POST /api/generate-license (30d) returns 201');
    const diffDays30 = Math.round(
      (new Date(gen30dRes.body.license.expiresAt).getTime() - new Date(gen30dRes.body.license.createdAt).getTime()) /
      (1000 * 60 * 60 * 24)
    );
    assert(diffDays30 === 30, 'Expiration timestamp is 30 days from creation');

    // -------------------------------------------------------------
    // Test 7: Generate License - Validation (Invalid User, Invalid Duration)
    // -------------------------------------------------------------
    const fakeUserRes = await makeRequest(server, { path: '/api/generate-license', method: 'POST' }, {
      userId: 'usr_nonexistent',
      duration: '7d'
    });
    assert(fakeUserRes.statusCode === 404, 'Non-existent userId returns 404 Not Found');

    const badDurationRes = await makeRequest(server, { path: '/api/generate-license', method: 'POST' }, {
      userId: testUserId,
      duration: '90d'
    });
    assert(badDurationRes.statusCode === 400, 'Invalid duration returns 400 Bad Request');

    // -------------------------------------------------------------
    // Test 8: Verify License - Valid Active Key
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 4: Verify License ---');
    const verifyRes = await makeRequest(server, { path: '/api/verify-license', method: 'POST' }, {
      licenseKey: activeLicenseKey
    });

    assert(verifyRes.statusCode === 200, 'POST /api/verify-license returns 200');
    assert(verifyRes.body.valid === true, 'License valid is true');
    assert(verifyRes.body.status === 'ACTIVE', 'License status is ACTIVE');
    assert(verifyRes.body.user !== null, 'User details are attached');
    assert(verifyRes.body.user.userId === testUserId, 'User details match the owner');
    assert(verifyRes.body.user.email === 'alex@example.com', 'User email attached');

    // -------------------------------------------------------------
    // Test 9: Verify License - Non-Existent Key
    // -------------------------------------------------------------
    const fakeKeyRes = await makeRequest(server, { path: '/api/verify-license', method: 'POST' }, {
      licenseKey: 'EQ-0000-0000'
    });
    assert(fakeKeyRes.statusCode === 404, 'Non-existent license key returns 404 Not Found');
    assert(fakeKeyRes.body.valid === false, 'Non-existent key valid is false');

    // -------------------------------------------------------------
    // Test 10: Verify License - Expired Key Auto-Detection
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 5: Expired Key Auto-Detection ---');
    const db = require('./db');
    const dbData = await db.readData();
    const expiredLicenseKey = 'EQ-PAST-TEST';
    dbData.licenses.push({
      licenseKey: expiredLicenseKey,
      userId: testUserId,
      duration: '7d',
      status: 'ACTIVE',
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    });
    await db.writeData(dbData);

    const expiredVerifyRes = await makeRequest(server, { path: '/api/verify-license', method: 'POST' }, {
      licenseKey: expiredLicenseKey
    });

    assert(expiredVerifyRes.statusCode === 200, 'Expired key check returns 200');
    assert(expiredVerifyRes.body.valid === false, 'Expired license valid is false');
    assert(expiredVerifyRes.body.status === 'EXPIRED', 'Status is updated to EXPIRED');

    // -------------------------------------------------------------
    // Test 11: Web Portal Route (Zero 404)
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 6: Frontend Routes (Zero 404 Guarantee) ---');
    const portalRes = await makeRequest(server, { path: '/', method: 'GET' });
    assert(portalRes.statusCode === 200, 'GET / returns 200 OK');
    assert(typeof portalRes.body === 'string' && portalRes.body.includes('EXNESS QUANT'), 'GET / renders User License Portal HTML');

    // -------------------------------------------------------------
    // Test 12: Admin Dashboard Route (Zero 404)
    // -------------------------------------------------------------
    const adminRes = await makeRequest(server, { path: '/admin', method: 'GET' });
    assert(adminRes.statusCode === 200, 'GET /admin returns 200 OK');
    assert(typeof adminRes.body === 'string' && adminRes.body.includes('Admin Master Authentication'), 'GET /admin renders Admin Dashboard HTML');

    // -------------------------------------------------------------
    // Test 13: API Status & Discovery Endpoint (Zero 404)
    // -------------------------------------------------------------
    const apiRes = await makeRequest(server, { path: '/api', method: 'GET' });
    assert(apiRes.statusCode === 200, 'GET /api returns 200 OK');
    assert(apiRes.body.status === 'online', 'GET /api status is online');

    // -------------------------------------------------------------
    // Test 14: Checkout Route (POST /api/license/checkout)
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 7: Multi-Step Checkout & Invoicing ---');
    const checkoutRes = await makeRequest(server, { path: '/api/license/checkout', method: 'POST' }, {
      email: 'trader@quant.com',
      username: 'traderquant',
      telegram: '@traderquant',
      duration: '7d',
      paymentMethod: 'QRIS'
    });

    assert(checkoutRes.statusCode === 201, 'POST /api/license/checkout returns 201 Created');
    assert(checkoutRes.body.success === true, 'Checkout success is true');
    assert(/^INV-[0-9]{8}-[A-F0-9]{4}$/.test(checkoutRes.body.invoice.invoiceId), 'Invoice ID format matches INV-YYYYMMDD-XXXX');
    assert(/^EQ-7D-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(checkoutRes.body.license.licenseKey), 'License key has EQ-7D- prefix');
    assert(checkoutRes.body.license.status === 'PENDING', 'New license status is PENDING');
    assert(checkoutRes.body.invoice.uniqueCode >= 100, 'Invoice contains 3-digit unique code');
    assert(checkoutRes.body.invoice.totalAmount > 150000, 'Total amount includes base + unique code');
    assert(!!checkoutRes.body.invoice.qrisPayload, 'Invoice contains QRIS payload');

    checkoutInvoiceId = checkoutRes.body.invoice.invoiceId;
    checkoutLicenseKey = checkoutRes.body.license.licenseKey;

    // -------------------------------------------------------------
    // Test 15: Verify Pending License (Should return valid=false, status=PENDING)
    // -------------------------------------------------------------
    const verifyPendingRes = await makeRequest(server, { path: '/api/license/verify', method: 'POST' }, {
      licenseKey: checkoutLicenseKey
    });
    assert(verifyPendingRes.statusCode === 200, 'POST /api/license/verify returns 200 for pending key');
    assert(verifyPendingRes.body.valid === false, 'Pending license valid is false');
    assert(verifyPendingRes.body.status === 'PENDING', 'Pending license status is PENDING');

    // -------------------------------------------------------------
    // Test 16: Admin Security Authentication
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 8: Admin Security & Queue Management ---');
    const unauthAdminRes = await makeRequest(server, { path: '/api/license/admin', method: 'GET' });
    assert(unauthAdminRes.statusCode === 401, 'GET /api/license/admin returns 401 Unauthorized without header');

    const authAdminRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'GET',
      headers: { 'x-admin-key': 'admin123' }
    });
    assert(authAdminRes.statusCode === 200, 'GET /api/license/admin returns 200 with x-admin-key');
    assert(authAdminRes.body.stats.pendingLicenses >= 1, 'Stats reflects pending license in queue');
    assert(authAdminRes.body.licenses.length > 0, 'Admin receives enriched license records');

    // -------------------------------------------------------------
    // Test 17: Confirm Payment Endpoint
    // -------------------------------------------------------------
    const confirmRes = await makeRequest(server, { path: '/api/license/confirm-payment', method: 'POST' }, {
      invoiceId: checkoutInvoiceId
    });
    assert(confirmRes.statusCode === 200, 'POST /api/license/confirm-payment returns 200');
    assert(confirmRes.body.invoice.userConfirmed === true, 'Invoice marked userConfirmed=true');

    // -------------------------------------------------------------
    // Test 18: Admin 1-Click Approve Pending License
    // -------------------------------------------------------------
    const approveRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'POST',
      headers: { 'x-admin-key': 'admin123' }
    }, {
      action: 'APPROVE',
      licenseKey: checkoutLicenseKey
    });
    assert(approveRes.statusCode === 200, 'POST /api/license/admin APPROVE returns 200');
    assert(approveRes.body.license.status === 'ACTIVE', 'Approved license status is now ACTIVE');
    assert(approveRes.body.invoice.status === 'APPROVED', 'Associated invoice status is APPROVED');

    // -------------------------------------------------------------
    // Test 19: Verify License after Approval
    // -------------------------------------------------------------
    const verifyApprovedRes = await makeRequest(server, { path: '/api/license/verify', method: 'POST' }, {
      licenseKey: checkoutLicenseKey
    });
    assert(verifyApprovedRes.statusCode === 200, 'POST /api/license/verify returns 200');
    assert(verifyApprovedRes.body.valid === true, 'License is now valid: true');
    assert(verifyApprovedRes.body.status === 'ACTIVE', 'License status is ACTIVE');
    assert(verifyApprovedRes.body.username === 'traderquant', 'Returns correct username');
    assert(verifyApprovedRes.body.remainingDays === 7, 'Remaining days is 7');

    // -------------------------------------------------------------
    // Test 20: Admin Action - EXTEND (+7D)
    // -------------------------------------------------------------
    console.log('\n--- Test Suite 9: Admin Key Lifecycle (Extend, Revoke, Delete) ---');
    const extendRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'POST',
      headers: { 'x-admin-key': 'admin123' }
    }, {
      action: 'EXTEND',
      licenseKey: checkoutLicenseKey,
      days: 7
    });
    assert(extendRes.statusCode === 200, 'Admin EXTEND returns 200');
    const prevExp = new Date(approveRes.body.license.expiresAt).getTime();
    const newExp = new Date(extendRes.body.license.expiresAt).getTime();
    const diffExtendedDays = Math.round((newExp - prevExp) / (1000 * 60 * 60 * 24));
    assert(diffExtendedDays === 7, 'License extended by exactly +7 days');

    // -------------------------------------------------------------
    // Test 21: Admin Action - CREATE (1-Click Manual License Generator)
    // -------------------------------------------------------------
    const manualGenRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'POST',
      headers: { 'x-admin-key': 'admin123' }
    }, {
      action: 'CREATE',
      username: 'vipquant',
      telegram: '@vipquant',
      duration: '30d'
    });
    assert(manualGenRes.statusCode === 201, 'Admin CREATE (30d) returns 201 Created');
    assert(/^EQ-30D-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(manualGenRes.body.license.licenseKey), '30d Key format has EQ-30D- prefix');
    assert(manualGenRes.body.license.status === 'ACTIVE', 'Manually created key is immediately ACTIVE');

    // -------------------------------------------------------------
    // Test 22: Admin Action - REVOKE (Toggle Active / Revoked)
    // -------------------------------------------------------------
    const revokeRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'POST',
      headers: { 'x-admin-key': 'admin123' }
    }, {
      action: 'REVOKE',
      licenseKey: manualGenRes.body.license.licenseKey
    });
    assert(revokeRes.statusCode === 200, 'Admin REVOKE returns 200');
    assert(revokeRes.body.license.status === 'REVOKED', 'License status toggled to REVOKED');

    // -------------------------------------------------------------
    // Test 23: Admin Action - DELETE
    // -------------------------------------------------------------
    const deleteRes = await makeRequest(server, {
      path: '/api/license/admin',
      method: 'POST',
      headers: { 'x-admin-key': 'admin123' }
    }, {
      action: 'DELETE',
      licenseKey: manualGenRes.body.license.licenseKey
    });
    assert(deleteRes.statusCode === 200, 'Admin DELETE returns 200');

    const verifyDeletedRes = await makeRequest(server, { path: '/api/verify-license', method: 'POST' }, {
      licenseKey: manualGenRes.body.license.licenseKey
    });
    assert(verifyDeletedRes.statusCode === 404, 'Deleted license key returns 404 Not Found');

  } catch (err) {
    console.error('Unhandled test failure:', err);
    failedCount++;
  } finally {
    // Clean up
    server.close();
    if (fs.existsSync(TEST_DB)) {
      fs.unlinkSync(TEST_DB);
    }
    const testTmp = `${TEST_DB}.tmp`;
    if (fs.existsSync(testTmp)) {
      fs.unlinkSync(testTmp);
    }
  }

  console.log('\n=======================================================');
  console.log(`Results: ${passedCount} Passed, ${failedCount} Failed`);
  console.log('=======================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
