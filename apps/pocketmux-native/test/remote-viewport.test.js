import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeNativeViewportHeight,
  resolveRemoteViewportHeight,
} from '../src/remote-viewport.js';

test('normalizes native viewport heights without accepting invalid geometry', () => {
  assert.equal(normalizeNativeViewportHeight(500), 500);
  assert.equal(normalizeNativeViewportHeight('500.5'), 500.5);
  assert.equal(normalizeNativeViewportHeight(0), null);
  assert.equal(normalizeNativeViewportHeight(-1), null);
  assert.equal(normalizeNativeViewportHeight('invalid'), null);
});

test('uses the Android visible height when a nested iframe cannot observe the IME', () => {
  assert.equal(resolveRemoteViewportHeight({
    layoutHeight: 800,
    visualViewportHeight: 800,
    visualViewportOffsetTop: 0,
    visualViewportScale: 1,
    nativeViewportHeight: 500,
  }), 500);
});

test('uses the top-level visual viewport as a modern WebView fallback', () => {
  assert.equal(resolveRemoteViewportHeight({
    layoutHeight: 800,
    visualViewportHeight: 500,
    visualViewportOffsetTop: 0,
    visualViewportScale: 1,
    nativeViewportHeight: null,
  }), 500);
});

test('does not subtract the IME twice when Android already resized the layout viewport', () => {
  assert.equal(resolveRemoteViewportHeight({
    layoutHeight: 500,
    visualViewportHeight: 500,
    visualViewportOffsetTop: 0,
    visualViewportScale: 1,
    nativeViewportHeight: 500,
  }), 500);
});

test('restores the complete remote viewport after the IME closes', () => {
  assert.equal(resolveRemoteViewportHeight({
    layoutHeight: 800,
    visualViewportHeight: 800,
    visualViewportOffsetTop: 0,
    visualViewportScale: 1,
    nativeViewportHeight: 800,
  }), 800);
});

test('does not mistake pinch zoom for an IME resize', () => {
  assert.equal(resolveRemoteViewportHeight({
    layoutHeight: 800,
    visualViewportHeight: 400,
    visualViewportOffsetTop: 100,
    visualViewportScale: 2,
    nativeViewportHeight: null,
  }), 800);
});
