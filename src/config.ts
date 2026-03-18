export const DEFAULT_CONFIG = {
  agentGateUrl: 'http://127.0.0.1:3000',
  apiKey: process.env.AGENTGATE_REST_KEY ?? '',
  sizeChangeThreshold: 0.5, // 50% size change triggers failure
  debounceMs: 100, // ignore duplicate changes to same file within this window
  verifyCmd: '', // user-supplied shell command for verification (empty = use size threshold)
  verifyCmdTimeoutMs: 30_000, // 30 seconds default timeout for verify command
};
