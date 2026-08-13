const UNZOOMED_SCALE_TOLERANCE = 0.01;

export function normalizeNativeViewportHeight(value) {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? height : null;
}

export function resolveRemoteViewportHeight({
  layoutHeight,
  visualViewportHeight,
  visualViewportOffsetTop = 0,
  visualViewportScale = 1,
  nativeViewportHeight,
}) {
  const candidates = [];
  const layout = normalizeNativeViewportHeight(layoutHeight);
  const native = normalizeNativeViewportHeight(nativeViewportHeight);
  if (layout !== null) candidates.push(layout);
  if (native !== null) candidates.push(native);

  const visualHeight = normalizeNativeViewportHeight(visualViewportHeight);
  const offsetTop = Math.max(0, Number(visualViewportOffsetTop) || 0);
  const scale = Number(visualViewportScale);
  const isUnzoomed = !Number.isFinite(scale) || Math.abs(scale - 1) <= UNZOOMED_SCALE_TOLERANCE;
  if (visualHeight !== null && isUnzoomed) candidates.push(offsetTop + visualHeight);

  return Math.max(1, Math.min(...(candidates.length > 0 ? candidates : [1])));
}
