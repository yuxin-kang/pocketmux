export const DEFAULT_HANDLE_POSITION = 0.42;
export const HANDLE_DRAG_THRESHOLD_PX = 6;

export function normalizeHandlePosition(value, fallback = DEFAULT_HANDLE_POSITION) {
  const position = Number(value);
  if (!Number.isFinite(position)) return fallback;
  return Math.min(1, Math.max(0, position));
}

export function clampHandleCenter(centerY, containerHeight, handleHeight, margin) {
  const height = Math.max(0, Number(containerHeight) || 0);
  const halfHandle = Math.max(0, Number(handleHeight) || 0) / 2;
  const safeMargin = Math.max(0, Number(margin) || 0);
  const minimum = Math.min(height / 2, safeMargin + halfHandle);
  const maximum = Math.max(minimum, height - safeMargin - halfHandle);
  const requested = Number.isFinite(Number(centerY)) ? Number(centerY) : minimum;
  return Math.min(maximum, Math.max(minimum, requested));
}

export function handlePositionRatio(centerY, containerHeight) {
  const height = Number(containerHeight);
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_HANDLE_POSITION;
  return normalizeHandlePosition(Number(centerY) / height);
}

export function hasHandleMoved(startX, startY, currentX, currentY, threshold = HANDLE_DRAG_THRESHOLD_PX) {
  return Math.hypot(Number(currentX) - Number(startX), Number(currentY) - Number(startY)) >= threshold;
}
