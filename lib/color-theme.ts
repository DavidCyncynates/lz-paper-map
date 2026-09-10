export type ColorTheme = 'light' | 'dark';

export const COLOR_THEME_STORAGE_KEY = 'lz-paper-map:color-theme';

export function resolveColorTheme(
  storedTheme: string | null,
  prefersDark: boolean,
): ColorTheme {
  if (storedTheme === 'light' || storedTheme === 'dark') {
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
    } catch {}
    const prefersDark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const theme = storedTheme === 'light' || storedTheme === 'dark'
      ? storedTheme
      : prefersDark ? 'dark' : 'light';
    root.classList.toggle('dark', theme === 'dark');
    root.dataset.theme = theme;
  })();`;
}
