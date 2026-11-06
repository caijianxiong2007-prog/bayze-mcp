/**
 * 答案一致性（ADR-0006 D2）：parallel 多模型输出的确定性相似度信号。
 * v1 启发式——拉丁词 + CJK 二元组的集合，取所有两两 Jaccard 的平均。
 * 零额外调用、完全确定；它是信号不是事实保证。
 */

/** 归一化 token 集：拉丁/数字按词，CJK 按相邻二元组 */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const w of words) out.add(w);
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) {
    out.add(cjk[i]! + cjk[i + 1]!);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 平均两两相似度（0-1）；少于 2 份文本时返回 undefined（不报告） */
export function answerAgreement(texts: string[]): number | undefined {
  if (texts.length < 2) return undefined;
  const sets = texts.map(tokenSet);
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      total += jaccard(sets[i]!, sets[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? undefined : Number((total / pairs).toFixed(3));
}
