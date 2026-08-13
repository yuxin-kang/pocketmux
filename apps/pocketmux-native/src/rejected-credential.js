export async function rejectCredential({
  expectedToken,
  currentToken,
  rejectStoredToken,
  forgetMemory,
  rememberMemory,
}) {
  if (currentToken !== expectedToken) return true;

  forgetMemory();
  try {
    const storedToken = await rejectStoredToken(expectedToken);
    if (typeof storedToken === 'string' && storedToken.trim()) {
      rememberMemory(storedToken.trim());
    }
    return true;
  } catch {
    return false;
  }
}
