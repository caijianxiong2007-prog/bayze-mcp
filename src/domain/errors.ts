/** 跨模块边界的统一结果类型：adapter / credentials / config 不跨界抛异常 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
