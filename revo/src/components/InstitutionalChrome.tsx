'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Sun,
  Moon,
} from 'lucide-react';

export type ThemeMode = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'nmssx-theme';

interface ThemeContextValue {
  theme: ThemeMode;
  isDark: boolean;
  setTheme: (next: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  isDark: true,
  setTheme: () => {},
  toggleTheme: () => {},
});

function readInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  if (typeof document !== 'undefined') {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }
  return 'dark';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>('dark');

  const applyThemeToDom = useCallback((mode: ThemeMode) => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', mode === 'dark');
    }
  }, []);

  useEffect(() => {
    const initial = readInitialTheme();
    setThemeState(initial);
    applyThemeToDom(initial);

    const handleStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY && (e.newValue === 'dark' || e.newValue === 'light')) {
        setThemeState(e.newValue);
        applyThemeToDom(e.newValue);
      }
    };

    const handleCustom = (e: Event) => {
      const detail = (e as CustomEvent<ThemeMode>).detail;
      if (detail === 'dark' || detail === 'light') {
        setThemeState(detail);
        applyThemeToDom(detail);
      }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('nmssx-theme-change', handleCustom as EventListener);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('nmssx-theme-change', handleCustom as EventListener);
    };
  }, [applyThemeToDom]);

  const setTheme = useCallback(
    (next: ThemeMode) => {
      setThemeState(next);
      applyThemeToDom(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
        window.dispatchEvent(new CustomEvent<ThemeMode>('nmssx-theme-change', { detail: next }));
      } catch {}
    },
    [applyThemeToDom]
  );

  const toggleTheme = useCallback(() => {
    const current =
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light';
    setTheme(current === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        isDark: theme === 'dark',
        setTheme,
        toggleTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export const ThemeToggle: React.FC<{
  showLabel?: boolean;
  className?: string;
}> = ({ showLabel = false, className = '' }) => {
  const { isDark, toggleTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const activeDark = mounted ? isDark : true;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={activeDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      aria-label={activeDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono font-semibold transition-all cursor-pointer select-none bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-700 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:border-zinc-700/80 dark:text-slate-200 ${className}`}
    >
      {activeDark ? (
        <Sun className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      ) : (
        <Moon className="w-3.5 h-3.5 text-slate-700 shrink-0" />
      )}
      {showLabel && <span>{activeDark ? 'LIGHT' : 'DARK'}</span>}
    </button>
  );
};

export const InstitutionalNavbar: React.FC = () => {
  return (
    <header className="bg-white/90 dark:bg-slate-950/90 backdrop-blur-md border-b border-slate-200/80 dark:border-zinc-800/90 sticky top-0 z-50 transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5 group shrink-0">
          <div className="w-9 h-9 rounded-xl bg-[#0F172A] dark:bg-emerald-500/15 dark:border dark:border-emerald-500/30 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-sm tracking-tight shadow-xs transition-colors">
            NX
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="font-sans font-bold text-[#0F172A] dark:text-slate-100 tracking-tight text-base leading-none">
                NMSSx
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 dark:bg-zinc-900 text-slate-700 dark:text-slate-300 border border-slate-200/90 dark:border-zinc-700 font-semibold">
                CLIENT TERMINAL
              </span>
            </div>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <ThemeToggle showLabel />
        </div>
      </div>
    </header>
  );
};

export const InstitutionalFooter: React.FC = () => {
  return (
    <footer className="bg-white dark:bg-slate-950 border-t border-slate-200/90 dark:border-zinc-800/90 mt-auto transition-colors">
      <div className="max-w-[1920px] mx-auto px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="w-6 h-6 rounded-lg bg-[#0F172A] dark:bg-zinc-900 dark:border dark:border-zinc-700 text-white dark:text-emerald-400 flex items-center justify-center font-sans font-bold text-[10px] tracking-tight">
            NX
          </span>
          <span className="font-sans font-bold text-[#0F172A] dark:text-slate-100 text-sm tracking-tight">
            NEMESIS x Trade
          </span>
        </div>

        <div className="flex items-center gap-1.5 font-mono text-xs text-slate-600 dark:text-slate-400">
          <a
            href="https://nmssx.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-[#0F172A] dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 underline underline-offset-4 transition-colors"
          >
            nmssx.xyz
          </a>
          <span>2026</span>
        </div>
      </div>
    </footer>
  );
};
