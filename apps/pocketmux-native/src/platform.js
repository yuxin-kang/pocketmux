export function detectPlatform(navigatorLike = {}) {
  const userAgent = String(navigatorLike.userAgent || '');
  const isAndroid = /\bAndroid\b/i.test(userAgent);
  const isIPad = /\biPad\b/i.test(userAgent)
    || (/\bMacintosh\b/i.test(userAgent) && Number(navigatorLike.maxTouchPoints || 0) > 1);
  const isIOS = isIPad || /\b(?:iPhone|iPod)\b/i.test(userAgent);

  return {
    isAndroid,
    isIOS,
    isIPad,
    isMobile: isAndroid || isIOS,
  };
}

export function getPlatformPolicy(navigatorLike = {}) {
  const platform = detectPlatform(navigatorLike);
  return {
    ...platform,
    allowPrivateHttp: !platform.isMobile,
  };
}
