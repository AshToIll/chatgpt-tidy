// One mapping for visible copy and diagnostics; never guess from raw server text.
export function searchFailure(error, fallback) {
  // 桥接异常与目录保存的错误共用规范 DTO；不能丢掉“重读也无法恢复”的标记。
  const diagnostic = globalThis.TidyLibraryHydration.normalizeError(error, { fallbackCode: "SEARCH_UNAVAILABLE" });
  const { status, code } = diagnostic;
  if (status === 429 || /RATE_LIMIT/.test(code)) return { messageKey: "titlesRateLimited", retryable: diagnostic.retryable !== false };
  if (status === 401 || /^(?:AUTH_REQUIRED|AUTH_EXPIRED|UNAUTHORIZED)$/.test(code)) {
    return { messageKey: "titlesAuthExpired", retryable: diagnostic.retryable !== false };
  }
  return globalThis.TidyLibraryHydration.errorPresentation(diagnostic, fallback);
}
