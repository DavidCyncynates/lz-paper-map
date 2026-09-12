export type ColorTheme = 'light' | 'dark';

export const COLOR_THEME_STORAGE_KEY = 'davidcyncynates:color-theme';
export const LEGACY_COLOR_THEME_STORAGE_KEY = 'lz-paper-map:color-theme';

export function isColorTheme(value: string | null): value is ColorTheme {
  return value === 'light' || value === 'dark';
}

export function resolveColorTheme(
  storedTheme: string | null,
  prefersDark: boolean,
): ColorTheme {
  if (isColorTheme(storedTheme)) {
    return storedTheme;
  }
  return prefersDark ? 'dark' : 'light';
}

export function oppositeColorTheme(theme: ColorTheme): ColorTheme {
  return theme === 'dark' ? 'light' : 'dark';
}

export function createColorThemeBootstrapScript(
  storageKey = COLOR_THEME_STORAGE_KEY,
): string {
  return `(() => {
    const root = document.documentElement;
    let storedTheme = null;
    try {
      storedTheme = window.localStorage.getItem(${JSON.stringify(storageKey)});
      if (storedTheme !== 'light' && storedTheme !== 'dark') {
        const legacyTheme = window.localStorage.getItem(${JSON.stringify(LEGACY_COLOR_THEME_STORAGE_KEY)});
        if (legacyTheme === 'light' || legacyTheme === 'dark') {
          storedTheme = legacyTheme;
          window.localStorage.setItem(${JSON.stringify(storageKey)}, legacyTheme);
        }
      }
    } catch {}
    const prefersDark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const theme = storedTheme === 'light' || storedTheme === 'dark'
      ? storedTheme
      : prefersDark ? 'dark' : 'light';
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('#theme-color')?.setAttribute(
      'content',
      theme === 'dark' ? '#191a18' : '#f4f1e9',
    );
  })();`;
}
