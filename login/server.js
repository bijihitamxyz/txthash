require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const licenseRoutes = require('./routes/licenseRoutes');

// Initialize Express application
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// Middleware Configuration
// ==========================================

// Enable Cross-Origin Resource Sharing (CORS)
app.use(
  cors({
    origin: '*', // Allow all origins for standalone testing and API access
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
  })
);

// Parse incoming JSON payloads
app.use(express.json());

// Parse incoming URL-encoded payloads
app.use(express.urlencoded({ extended: true }));

// Serve static assets from public/ directory
app.use(express.static(path.join(__dirname, 'public')));

// Simple request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// ==========================================
// Frontend Web Routes (Zero 404 Guarantee)
// ==========================================

// User License Login & Registration Portal
app.get(['/', '/login', '/portal'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin Management Dashboard
app.get(['/admin', '/admin/dashboard'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Root API Endpoint (/api status & discovery)
app.get('/api', (req, res) => {
  res.status(200).json({
    name: 'Exness Quant License Server & Admin Portal API',
    version: '2.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
    routes: {
      portal: 'GET /',
      admin: 'GET /admin',
      verify: 'POST /api/license/verify',
      checkout: 'POST /api/license/checkout',
      confirmPayment: 'POST /api/license/confirm-payment',
      adminApi: 'GET/POST /api/license/admin (Requires x-admin-key)',
      health: 'GET /api/health'
    }
  });
});

// ==========================================
// REST API Routes Mounting
// ==========================================

// Mount API routes under /api
app.use('/api', licenseRoutes);

// ==========================================
// Error Handling Middleware
// ==========================================

// 404 Not Found handler for unmatched routes
app.use((req, res) => {
  if (req.accepts('html')) {
    const notFoundFile = path.join(__dirname, 'public', '404.html');
    return res.status(404).sendFile(notFoundFile);
  }

  res.status(404).json({
    success: false,
    error: `Cannot ${req.method} ${req.originalUrl}`,
    code: 'ROUTE_NOT_FOUND'
  });
});

// Global error handler (handles JSON parse errors, unhandled exceptions)
app.use((err, req, res, next) => {
  // Handle invalid JSON body syntax
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON payload in request body.',
      code: 'BAD_JSON_PAYLOAD'
    });
  }

  console.error('[UNCAUGHT ERROR]', err);
  return res.status(err.status || 500).json({
    success: false,
    error: err.message || 'An unexpected internal server error occurred.',
    code: err.code || 'INTERNAL_SERVER_ERROR'
  });
});

// ==========================================
// Server Startup & Graceful Shutdown
// ==========================================

// Initialize the JSON database
db.initDb();

let server;

// Only start listening if executed directly (allows importing in tests)
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Exness Quant License Portal & Server is RUNNING!`);
    console.log(`📊 Port: ${PORT}`);
    console.log(`🌐 User License Portal:  http://localhost:${PORT}/`);
    console.log(`🛡️  Admin Dashboard:      http://localhost:${PORT}/admin`);
    console.log(`📡 API Status:           http://localhost:${PORT}/api`);
    console.log(`📁 Database File:        ${db.DB_FILE}`);
    console.log(`=======================================================`);
  });

  // Graceful shutdown handling
  const shutdown = (signal) => {
    console.log(`\n[SHUTDOWN] Received ${signal}. Shutting down gracefully...`);
    if (server) {
      server.close(() => {
        console.log('[SHUTDOWN] HTTP server closed.');
        process.exit(0);
      });
    }

    setTimeout(() => {
      console.error('[SHUTDOWN] Forced shutdown after timeout.');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, server };
