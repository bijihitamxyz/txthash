'use client';

import { useState, useEffect, useCallback } from 'react';
import type { VerifyLicenseResponse, LicenseRecord, LicenseUser } from '../components/LicenseLoginModal';

const DEFAULT_STORAGE_KEY = 'exness_quant_license';

export interface UseLicenseAuthReturn {
  isAuthenticated: boolean;
  isLoading: boolean;
  license: LicenseRecord | null;
  user: LicenseUser | null;
  login: (data: VerifyLicenseResponse) => void;
  logout: () => void;
  isExpired: boolean;
  remainingDays: number | null;
}

/**
 * Hook to manage the quantitative dashboard license state from localStorage.
 */
export function useLicenseAuth(storageKey: string = DEFAULT_STORAGE_KEY): UseLicenseAuthReturn {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [license, setLicense] = useState<LicenseRecord | null>(null);
  const [user, setUser] = useState<LicenseUser | null>(null);

  // Initialize and check current stored session
  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsLoading(false);
      return;
    }

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed: VerifyLicenseResponse = JSON.parse(raw);
        if (parsed.valid && parsed.license?.expiresAt) {
          const expiresMs = new Date(parsed.license.expiresAt).getTime();
          if (expiresMs > Date.now()) {
            setIsAuthenticated(true);
            setLicense(parsed.license);
            setUser(parsed.user || null);
          } else {
            // Expired key in storage
            localStorage.removeItem(storageKey);
            setIsAuthenticated(false);
          }
        }
      }
    } catch (e) {
      console.error('[AUTH ERROR] Could not read stored license:', e);
      localStorage.removeItem(storageKey);
    } finally {
      setIsLoading(false);
    }
  }, [storageKey]);

  const login = useCallback(
    (data: VerifyLicenseResponse) => {
      if (data.valid && data.license) {
        try {
          localStorage.setItem(storageKey, JSON.stringify(data));
        } catch (e) {
          console.error('[AUTH ERROR] Failed storing license in localStorage:', e);
        }
        setIsAuthenticated(true);
        setLicense(data.license);
        setUser(data.user || null);
      }
    },
    [storageKey]
  );

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    setIsAuthenticated(false);
    setLicense(null);
    setUser(null);
  }, [storageKey]);

  // Compute remaining days
  let remainingDays: number | null = null;
  let isExpired = false;

  if (license?.expiresAt) {
    const diffMs = new Date(license.expiresAt).getTime() - Date.now();
    remainingDays = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
    isExpired = diffMs <= 0;
  }

  return {
    isAuthenticated,
    isLoading,
    license,
    user,
    login,
    logout,
    isExpired,
    remainingDays
  };
}
