'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ============================================================================
// TypeScript Interfaces & Types
// ============================================================================

export interface LicenseUser {
  userId: string;
  email: string;
  username: string;
  telegram?: string;
  createdAt?: string;
}

export interface LicenseRecord {
  licenseKey: string;
  userId: string;
  duration: '7d' | '30d' | string;
  status: 'ACTIVE' | 'EXPIRED' | string;
  createdAt: string;
  expiresAt: string;
}

export interface VerifyLicenseResponse {
  success: boolean;
  valid: boolean;
  status: 'ACTIVE' | 'EXPIRED' | string;
  message: string;
  license?: LicenseRecord;
  user?: LicenseUser;
  error?: string;
  code?: string;
}

export interface LicenseLoginModalProps {
  /** Controls modal visibility. If omitted or true in full-page mode, stays visible. */
  isOpen?: boolean;
  /** Callback fired when user closes modal (only active if isModal is true). */
  onClose?: () => void;
  /** Callback fired immediately when valid license is verified and persisted. */
  onLoginSuccess?: (data: VerifyLicenseResponse) => void;
  /** API endpoint to verify license. Defaults to '/api/verify-license'. */
  apiEndpoint?: string;
  /** localStorage key name. Defaults to 'exness_quant_license'. */
  storageKey?: string;
  /** When true, renders as an overlay dialog with backdrop blur. When false, renders as a standalone page. */
  isModal?: boolean;
  /** Optional custom title override */
  terminalName?: string;
}

type VerificationStatus = 'idle' | 'verifying' | 'success' | 'error';

// ============================================================================
// Component
// ============================================================================

export const LicenseLoginModal: React.FC<LicenseLoginModalProps> = ({
  isOpen = true,
  onClose,
  onLoginSuccess,
  apiEndpoint = '/api/verify-license',
  storageKey = 'exness_quant_license',
  isModal = true,
  terminalName = 'EXNESS QUANT'
}) => {
  const [licenseKey, setLicenseKey] = useState<string>('');
  const [status, setStatus] = useState<VerificationStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [verifiedUser, setVerifiedUser] = useState<LicenseUser | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus input automatically on open
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Check if a valid session already exists in localStorage on initial mount
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const rawStored = localStorage.getItem(storageKey);
      if (rawStored) {
        const parsed = JSON.parse(rawStored) as VerifyLicenseResponse;
        if (parsed && parsed.valid && parsed.license?.expiresAt) {
          const isStillValid = new Date(parsed.license.expiresAt).getTime() > Date.now();
          if (isStillValid) {
            // Already has valid non-expired license in storage
            onLoginSuccess?.(parsed);
          } else {
            // Clear expired cached license
            localStorage.removeItem(storageKey);
          }
        }
      }
    } catch {
      // Ignore parse errors on legacy storage
    }
  }, [storageKey, onLoginSuccess]);

  // Handle escape key to close modal if allowed
  useEffect(() => {
    if (!isModal || !isOpen || !onClose) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && status !== 'verifying') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModal, isOpen, onClose, status]);

  /**
   * Auto-formats input:
   * - Converts characters to uppercase
   * - Strips invalid characters (only allows A-Z, 0-9, and dashes)
   * - Cleans existing errors on user input
   */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value.toUpperCase();
    // Allow uppercase alphanumeric and hyphens only
    value = value.replace(/[^A-Z0-9-]/g, '');

    // Auto-hyphenate if user types raw format (e.g., EQ87ABK92X -> EQ-87AB-K92X)
    const rawAlphaNum = value.replace(/-/g, '');
    if (rawAlphaNum.startsWith('EQ') && rawAlphaNum.length > 2 && !value.includes('-')) {
      const parts = [rawAlphaNum.slice(0, 2)];
      if (rawAlphaNum.length > 2) parts.push(rawAlphaNum.slice(2, 6));
      if (rawAlphaNum.length > 6) parts.push(rawAlphaNum.slice(6, 10));
      value = parts.join('-');
    }

    setLicenseKey(value);
    if (errorMessage) {
      setErrorMessage(null);
      setStatus('idle');
    }
  };

  /**
   * Quick clipboard paste helper
   */
  const handlePasteClipboard = async () => {
    try {
      if (navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        const cleaned = text.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
        if (cleaned) {
          setLicenseKey(cleaned);
          setErrorMessage(null);
          setStatus('idle');
          inputRef.current?.focus();
        }
      }
    } catch {
      // Clipboard read permission might be blocked; fallback is standard Ctrl+V
    }
  };

  /**
   * Clears the input field
   */
  const handleClear = () => {
    setLicenseKey('');
    setErrorMessage(null);
    setStatus('idle');
    inputRef.current?.focus();
  };

  /**
   * Form submission and license verification
   */
  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();

      const trimmedKey = licenseKey.trim().toUpperCase();

      if (!trimmedKey) {
        setErrorMessage('Please enter your license key.');
        setStatus('error');
        inputRef.current?.focus();
        return;
      }

      // Basic structure validation
      if (trimmedKey.length < 5) {
        setErrorMessage('Invalid license key format. Example: EQ-XXXX-XXXX');
        setStatus('error');
        inputRef.current?.focus();
        return;
      }

      setStatus('verifying');
      setErrorMessage(null);

      try {
        const response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({ licenseKey: trimmedKey })
        });

        const data: VerifyLicenseResponse = await response.json();

        if (response.ok && data.valid && data.status === 'ACTIVE') {
          // Success: Save to localStorage
          try {
            localStorage.setItem(storageKey, JSON.stringify(data));
          } catch (storageErr) {
            console.warn('[STORAGE WARN] Could not persist license to localStorage:', storageErr);
          }

          setStatus('success');
          setVerifiedUser(data.user || null);

          // Brief delay to allow the user to see the success checkmark animation
          setTimeout(() => {
            onLoginSuccess?.(data);
          }, 700);
        } else {
          // Failure handling
          setStatus('error');
          if (data.status === 'EXPIRED') {
            setErrorMessage('This license key has expired. Please renew your subscription.');
          } else if (response.status === 404 || data.code === 'LICENSE_NOT_FOUND') {
            setErrorMessage('License key not found. Please double check and try again.');
          } else {
            setErrorMessage(data.message || data.error || 'Verification failed. License is not active.');
          }
          inputRef.current?.select();
        }
      } catch (err: any) {
        console.error('[LICENSE VERIFICATION ERROR]', err);
        setStatus('error');
        setErrorMessage(
          err.message?.includes('Failed to fetch')
            ? 'Unable to connect to license authentication server. Check your connection.'
            : 'An unexpected connection error occurred. Please try again.'
        );
        inputRef.current?.focus();
      }
    },
    [licenseKey, apiEndpoint, storageKey, onLoginSuccess]
  );

  if (!isOpen) return null;

  // Inner card content
  const cardContent = (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="license-modal-title"
      className="relative w-full max-w-md overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/95 p-6 shadow-2xl shadow-indigo-950/40 backdrop-blur-xl transition-all sm:p-8"
    >
      {/* Decorative top ambient indigo glow */}
      <div
        className="pointer-events-none absolute -top-24 left-1/2 h-48 w-72 -translate-x-1/2 rounded-full bg-indigo-600/15 blur-3xl"
        aria-hidden="true"
      />

      {/* Close button (only shown if isModal is true and onClose handler provided) */}
      {isModal && onClose && (
        <button
          type="button"
          onClick={onClose}
          disabled={status === 'verifying'}
          aria-label="Close license login"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Header: Terminal Brand & Status Indicator */}
      <div className="mb-6 flex flex-col items-center text-center">
        {/* Terminal Logo Icon */}
        <div className="relative mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-indigo-500/30 bg-slate-950/80 shadow-inner shadow-indigo-500/20">
          <svg
            className="h-7 w-7 text-indigo-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
              d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"
            />
          </svg>
          <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-slate-900" />
          </span>
        </div>

        {/* System & Brand Title */}
        <div className="flex items-center gap-2">
          <h2
            id="license-modal-title"
            className="font-mono text-xs font-semibold tracking-widest text-indigo-400 uppercase"
          >
            {terminalName}
          </h2>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
            v2.4
          </span>
        </div>

        <h1 className="mt-1 text-xl font-bold tracking-tight text-slate-100 sm:text-2xl">
          Terminal Authentication
        </h1>
        <p className="mt-1.5 text-xs text-slate-400">
          Enter your authorized license key to unlock algorithmic trading streams.
        </p>
      </div>

      {/* Error Message Banner */}
      {status === 'error' && errorMessage && (
        <div
          role="alert"
          aria-live="assertive"
          className="mb-5 flex items-start gap-3 rounded-xl border border-rose-900/60 bg-rose-950/40 p-3.5 text-xs text-rose-300 backdrop-blur-sm"
        >
          <svg
            className="mt-0.5 h-4 w-4 shrink-0 text-rose-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <div className="flex-1 leading-relaxed">
            <span className="font-semibold text-rose-200">Authentication Failed:</span>{' '}
            {errorMessage}
          </div>
        </div>
      )}

      {/* Success State Banner */}
      {status === 'success' && (
        <div
          role="status"
          aria-live="polite"
          className="mb-5 flex items-center gap-3 rounded-xl border border-emerald-900/60 bg-emerald-950/40 p-3.5 text-xs text-emerald-300 backdrop-blur-sm"
        >
          <svg
            className="h-5 w-5 shrink-0 text-emerald-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <div>
            <p className="font-semibold text-emerald-200">License Authenticated</p>
            <p className="text-emerald-400/90">
              Welcome back{verifiedUser ? `, @${verifiedUser.username}` : ''}. Initializing dashboard...
            </p>
          </div>
        </div>
      )}

      {/* Main Authentication Form */}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label
              htmlFor="license-key-input"
              className="font-mono text-xs font-medium tracking-wide text-slate-300 uppercase"
            >
              License Key
            </label>
            <span className="font-mono text-[11px] text-slate-500">FORMAT: EQ-XXXX-XXXX</span>
          </div>

          <div className="relative">
            <input
              id="license-key-input"
              ref={inputRef}
              type="text"
              name="licenseKey"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              spellCheck="false"
              value={licenseKey}
              onChange={handleInputChange}
              disabled={status === 'verifying' || status === 'success'}
              placeholder="EQ-XXXX-XXXX"
              className={`w-full rounded-xl border bg-slate-950/90 px-4 py-3.5 pr-20 font-mono text-base tracking-wider text-slate-100 placeholder-slate-600 transition-all focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                status === 'error'
                  ? 'border-rose-500/80 focus:border-rose-500 focus:ring-rose-500/20'
                  : status === 'success'
                  ? 'border-emerald-500/80 focus:border-emerald-500 focus:ring-emerald-500/20'
                  : 'border-slate-800 focus:border-indigo-500 focus:ring-indigo-500/25'
              }`}
            />

            {/* In-field Action Buttons: Paste / Clear */}
            <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {licenseKey ? (
                <button
                  type="button"
                  onClick={handleClear}
                  disabled={status === 'verifying' || status === 'success'}
                  title="Clear input"
                  className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-40"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePasteClipboard}
                  disabled={status === 'verifying' || status === 'success'}
                  title="Paste from clipboard"
                  className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-40"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                    />
                  </svg>
                  <span>Paste</span>
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Submit Action Button */}
        <button
          type="submit"
          disabled={status === 'verifying' || status === 'success' || !licenseKey.trim()}
          className="group relative flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition-all hover:bg-indigo-500 active:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 disabled:shadow-none"
        >
          {status === 'verifying' ? (
            <>
              {/* Spinner */}
              <svg
                className="h-4 w-4 animate-spin text-white"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              <span>Verifying License...</span>
            </>
          ) : status === 'success' ? (
            <>
              <svg className="h-4 w-4 text-emerald-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
              <span>Unlocked</span>
            </>
          ) : (
            <>
              <span>Authenticate & Enter Terminal</span>
              <svg
                className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M14 5l7 7m0 0l-7 7m7-7H3"
                />
              </svg>
            </>
          )}
        </button>
      </form>

      {/* Bottom Footer Info & Security Badges */}
      <div className="mt-6 border-t border-slate-800/80 pt-4">
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <div className="flex items-center gap-1.5">
            <svg
              className="h-3.5 w-3.5 text-indigo-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
            <span>256-Bit Hardware Encrypted</span>
          </div>

          <a
            href="https://t.me"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 transition-colors hover:text-indigo-300 hover:underline"
          >
            Need a key?
          </a>
        </div>
      </div>
    </div>
  );

  // Render as modal overlay or full page
  if (isModal) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop with blur and deep slate tint */}
        <div
          className="fixed inset-0 bg-slate-950/80 backdrop-blur-md transition-opacity"
          aria-hidden="true"
          onClick={onClose}
        />
        {/* Card */}
        {cardContent}
      </div>
    );
  }

  // Standalone Page Mode
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-slate-950 p-4">
      {/* Background ambient lighting */}
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(99,102,241,0.15),rgba(255,255,255,0))]"
        aria-hidden="true"
      />
      {cardContent}
    </div>
  );
};

export default LicenseLoginModal;
