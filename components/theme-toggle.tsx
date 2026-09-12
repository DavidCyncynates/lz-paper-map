'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  COLOR_THEME_STORAGE_KEY,
  isColorTheme,
  LEGACY_COLOR_THEME_STORAGE_KEY,
  oppositeColorTheme,
  resolveColorTheme,
  type ColorTheme,
} from '@/lib/color-theme';

type CompatibleMediaQueryList = {
  readonly matches: boolean;
  addEventListener?: (
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ) => void;
  removeEventListener?: (
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ) => void;
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

function readStoredTheme(): ColorTheme | null {
  try {
    const storedTheme = window.localStorage.getItem(COLOR_THEME_STORAGE_KEY);
    if (isColorTheme(storedTheme)) return storedTheme;

    const legacyTheme = window.localStorage.getItem(
      LEGACY_COLOR_THEME_STORAGE_KEY,
    );
    if (isColorTheme(legacyTheme)) {
      try {
        window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, legacyTheme);
      } catch {
        // Migration is best-effort; the legacy preference still applies.
      }
      return legacyTheme;
    }
  } catch {
    // Browser privacy settings can disable storage entirely.
  }
  return null;
}

function applyTheme(theme: ColorTheme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document
    .querySelector('#theme-color')
    ?.setAttribute('content', theme === 'dark' ? '#191a18' : '#f4f1e9');
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<ColorTheme | null>(null);

  useEffect(() => {
    const colorScheme: CompatibleMediaQueryList | undefined =
      window.matchMedia?.('(prefers-color-scheme: dark)');
    const synchronizeTheme = () => {
      const synchronizedTheme = resolveColorTheme(
        readStoredTheme(),
        colorScheme?.matches ?? false,
      );
      applyTheme(synchronizedTheme);
      setTheme(synchronizedTheme);
    };
    const followSystemTheme = () => {
      const storedTheme = readStoredTheme();
      if (storedTheme !== 'light' && storedTheme !== 'dark') {
        synchronizeTheme();
      }
    };
    const followStoredTheme = (event: StorageEvent) => {
      if (
        event.key === LEGACY_COLOR_THEME_STORAGE_KEY &&
        isColorTheme(event.newValue)
      ) {
        applyTheme(event.newValue);
        setTheme(event.newValue);
        try {
          window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, event.newValue);
        } catch {
          // The received theme can still be applied without storage.
        }
        return;
      }
      if (event.key === null || event.key === COLOR_THEME_STORAGE_KEY) {
        synchronizeTheme();
      }
    };

    synchronizeTheme();
    if (colorScheme?.addEventListener) {
      colorScheme.addEventListener('change', followSystemTheme);
    } else {
      colorScheme?.addListener?.(followSystemTheme);
    }
    window.addEventListener('storage', followStoredTheme);

    return () => {
      if (colorScheme?.removeEventListener) {
        colorScheme.removeEventListener('change', followSystemTheme);
      } else {
        colorScheme?.removeListener?.(followSystemTheme);
      }
      window.removeEventListener('storage', followStoredTheme);
    };
  }, []);

  function toggleTheme() {
    const currentTheme: ColorTheme =
      document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    const nextTheme = oppositeColorTheme(currentTheme);

    applyTheme(nextTheme);
    setTheme(nextTheme);
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, nextTheme);
      window.localStorage.setItem(LEGACY_COLOR_THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The theme still changes for this page when storage is unavailable.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="theme-toggle"
      aria-label="Dark mode"
      aria-pressed={theme === null ? undefined : theme === 'dark'}
      title={
        theme === null
          ? 'Change color theme'
          : `Use ${theme === 'dark' ? 'light' : 'dark'} mode`
      }
      onClick={toggleTheme}
    >
      <Moon className="theme-icon theme-icon--moon" aria-hidden="true" />
      <Sun className="theme-icon theme-icon--sun" aria-hidden="true" />
    </Button>
  );
}
