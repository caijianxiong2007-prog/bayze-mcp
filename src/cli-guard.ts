/** 基线 §8：禁用 TLS 校验的环境必须拒绝启动。纯函数，便于直接单测与 CLI 复用。 */
export function guardRuntimeEnv(): string | null {
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    return 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification; refusing to start (baseline §8)';
  }
  return null;
}
