import { execFileSync } from 'node:child_process';
import { err, ok } from '../domain/errors.js';
import type { Result } from '../domain/errors.js';

const ENV_REF = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
/** 仅允许安全字符（无 shell 元字符）的 keychain 名称 */
const KEYCHAIN_REF = /^keychain:([A-Za-z0-9_.-]+)$/;

export type CredentialError =
  | { code: 'invalid_ref'; message: string }
  | { code: 'missing_env'; envName: string; message: string }
  | { code: 'keychain_unsupported'; message: string }
  | { code: 'keychain_error'; message: string };

/**
 * 凭证读取（ADR-0001 D4 + ADR-0003 D2）：
 * - `env:VAR_NAME`：从环境变量读取（全平台）
 * - `keychain:NAME`：从 macOS 钥匙串读取（execFileSync 参数数组，无 shell 注入）
 * 值只进内存；绝不出现在日志、错误文本或 journal 中（基线 §8）。
 */
export class CredentialStore {
  resolve(ref: string): Result<string, CredentialError> {
    const kcName = ref.match(KEYCHAIN_REF)?.[1];
    if (kcName) {
      if (process.platform !== 'darwin') {
        return err({
          code: 'keychain_unsupported',
          message: `keychain: is only supported on macOS; use env: instead on ${process.platform}`,
        });
      }
      try {
        const value = execFileSync(
          'security',
          ['find-generic-password', '-s', 'bayze', '-a', kcName, '-w'],
          { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim();
        if (value.length === 0) {
          return err({ code: 'keychain_error', message: `keychain entry "${kcName}" is empty` });
        }
        return ok(value);
      } catch (e) {
        return err({
          code: 'keychain_error',
          message: `keychain lookup failed for "${kcName}": ${(e as Error).message?.slice(0, 100) ?? 'not found'}`,
        });
      }
    }

    const envName = ref.match(ENV_REF)?.[1];
    if (!envName) {
      return err({
        code: 'invalid_ref',
        message: 'api_key_ref must look like env:VAR_NAME or keychain:NAME (the key itself must never appear in config)',
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
