import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

export type CredentialError =
  /** 注意：不携带原始 ref —— 用户可能误将密钥粘进 api_key_ref，错误对象会进入日志/响应（基线 §8） */
  | { code: 'invalid_ref'; message: string }
  | { code: 'missing_env'; envName: string; message: string };

/**
 * P0：凭证仅从环境变量解析（ADR-0001 D4）。
 * 值只进内存；绝不出现在日志、错误文本或 journal 中（基线 §8）。
 */
export class CredentialStore {
  resolve(ref: string): Result<string, CredentialError> {
    const m = ref.match(ENV_REF);
    const envName = m?.[1];
    if (!envName) {
      return err({
        code: 'invalid_ref',
        message: 'api_key_ref must look like env:VAR_NAME (the key itself must never appear in config)',
      });
    }
    const value = process.env[envName];
    if (value === undefined || value.length === 0) {
      return err({
        code: 'missing_env',
        envName,
        message: `environment variable ${envName} is not set`,
      });
    }
    return ok(value);
  }
}
