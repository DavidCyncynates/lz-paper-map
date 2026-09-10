import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import {
  COLOR_THEME_STORAGE_KEY,
  createColorThemeBootstrapScript,
  oppositeColorTheme,
  resolveColorTheme,
} from '../lib/color-theme.ts';

test('stored preferences override the operating-system preference', () => {
  assert.equal(resolveColorTheme('light', true), 'light');
  assert.equal(resolveColorTheme('dark', false), 'dark');
});

test('missing or invalid preferences follow the operating system', () => {
  assert.equal(resolveColorTheme(null, true), 'dark');
  assert.equal(resolveColorTheme(null, false), 'light');
  assert.equal(resolveColorTheme('sepia', true), 'dark');
});

test('the toggle always selects the opposite explicit theme', () => {
  assert.equal(oppositeColorTheme('light'), 'dark');
  assert.equal(oppositeColorTheme('dark'), 'light');
});

test('the pre-paint bootstrap applies a stored theme and uses a scoped key', () => {
  const changes = [];
  const dataset = {};
  const context = {
    document: {
      documentElement: {
        classList: {
          toggle(name, force) {
            changes.push([name, force]);
          },
        },
        dataset,
      },
    },
    window: {
      localStorage: {
        getItem(key) {
          assert.equal(key, COLOR_THEME_STORAGE_KEY);
          return 'dark';
        },
      },
      matchMedia() {
        return { matches: false };
      },
    },
  };

  vm.runInNewContext(createColorThemeBootstrapScript(), context);
  assert.deepEqual(changes, [['dark', true]]);
  assert.equal(dataset.theme, 'dark');
});

test('the pre-paint bootstrap follows the system if storage is unavailable', () => {
  let isDark = false;
  const dataset = {};
  const context = {
    document: {
      documentElement: {
        classList: {
          toggle(_name, force) {
            isDark = force;
          },
        },
        dataset,
      },
    },
    window: {
      localStorage: {
        getItem() {
          throw new Error('storage blocked');
        },
      },
      matchMedia() {
        return { matches: true };
      },
    },
  };

  vm.runInNewContext(createColorThemeBootstrapScript(), context);
  assert.equal(isDark, true);
  assert.equal(dataset.theme, 'dark');
});
