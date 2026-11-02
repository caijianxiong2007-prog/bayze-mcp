import { z } from 'zod';

export const CONFIG_VERSION = 1;

export type StepInput = 'original' | 'original_and_previous' | 'review_template' | 'revision_template';
export type RunIf = 'always' | 'on_check_failure' | 'review_verdict_is_revise';
export type CheckSpec = 'non_empty' | { max_chars: number };

const idPattern = /^[a-z][a-z0-9_-]*$/;
const envRefPattern = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

const apiId = z.string().regex(idPattern, 'id must be lowercase letters/digits/hyphens/underscores, starting with a letter');
const envRef = z.string().regex(envRefPattern, 'must look like env:VAR_NAME (never put the key itself here)');
const modelId = z.string().min(1, 'model id is required');

const currency = z.string().length(3, 'currency must be a 3-letter ISO-4217-style code');

const pricing = z
  .object({
    currency,
    input_per_1m_tokens: z.number().min(0),
    output_per_1m_tokens: z.number().min(0),
  })
  .strict();

const modelSchema = z
  .object({
    id: modelId,
    /** 仅提示，不作为路由真值/安全决策依据（基线 §6） */
    capabilities_hint: z.array(z.enum(['chat', 'json', 'tools', 'vision', 'streaming'])).optional(),
    pricing: pricing.optional(),
  })
  .strict();

const providerModels = z.array(modelSchema).min(1, 'provider needs at least one model');

const mockProvider = z
  .object({ kind: z.literal('mock'), models: providerModels })
  .strict();

const remoteProviderCommon = {
  api_key_ref: envRef,
  /** 明文/本地端点显式 opt-in（基线 §6/§8） */
  allow_insecure_base_url: z.boolean().optional().default(false),
  models: providerModels,
};

const remoteProvider = z
  .object({
    kind: z.literal('openai-compatible'),
    base_url: z.string().url('base_url must be a valid URL'),
    ...remoteProviderCommon,
  })
  .strict();

const anthropicProvider = z
  .object({
    kind: z.literal('anthropic'),
    base_url: z.string().url('base_url must be a valid URL').optional().default('https://api.anthropic.com'),
    ...remoteProviderCommon,
  })
  .strict();

// 注意：URL 安全校验在 configSchema 根级 superRefine 中执行
// （superRefine 会把成员包成 ZodEffects，不能放进 discriminatedUnion）
export const providerSchema = z.discriminatedUnion('kind', [mockProvider, remoteProvider, anthropicProvider]);
export type MockProviderConfig = z.infer<typeof mockProvider>;
export type RemoteProviderConfig = z.infer<typeof remoteProvider>;
export type AnthropicProviderConfig = z.infer<typeof anthropicProvider>;
export type ProviderConfig = z.infer<typeof providerSchema>;

const limitsSchema = z
  .object({
    max_steps: z.number().int().min(1),
    total_timeout_ms: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    max_cost_usd: z.number().min(0).optional(),
    allow_unknown_price: z.boolean().optional().default(false),
    max_retries_per_step: z.number().int().min(0).optional().default(0),
  })
  .strict();
export type WorkflowLimits = z.infer<typeof limitsSchema>;

const checkSpec = z.union([z.literal('non_empty'), z.object({ max_chars: z.number().int().positive() }).strict()]);

const stepSchema = z
  .object({
    name: z.string().min(1),
    provider: z.string().min(1),
    model: modelId,
    input: z.enum(['original', 'original_and_previous', 'review_template', 'revision_template']),
    timeout_ms: z.number().int().positive(),
    /** 覆盖 workflow 的 max_retries_per_step（基线 §6 优先级规则） */
    max_retries: z.number().int().min(0).optional(),
    run_if: z.enum(['always', 'on_check_failure', 'review_verdict_is_revise']).optional(),
    evaluate: z.array(checkSpec).default([]),
    gate: z.literal('structured_review').optional(),
    review_schema: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type StepConfig = z.infer<typeof stepSchema>;

const workflowSchema = z
  .object({
    strategy: z.literal('waterfall'),
    limits: limitsSchema,
    steps: z.array(stepSchema).min(1, 'workflow needs at least one step'),
  })
  .strict();
export type WorkflowConfig = z.infer<typeof workflowSchema>;

const runtimeSchema = z
  .object({
    max_concurrency: z.number().int().min(1).default(2),
    max_queue_size: z.number().int().min(0).default(4),
  })
  .strict()
  .default({});
export type RuntimeConfig = z.infer<typeof runtimeSchema>;

export const configSchema = z
  .object({
    version: z.literal(CONFIG_VERSION, {
      errorMap: (issue) => {
        if (issue.code === 'invalid_type') {
          return { message: `version is required and must be the number ${CONFIG_VERSION}` };
        }
        return { message: `unsupported config version: this build supports version ${CONFIG_VERSION} only (migrations TBD)` };
      },
    }),
    runtime: runtimeSchema,
    providers: z.record(apiId, providerSchema),
    workflows: z.record(apiId, workflowSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // —— 供应商端点安全（基线 §8：默认仅 HTTPS；本地/明文端点需显式 opt-in）——
    for (const [pid, p] of Object.entries(cfg.providers)) {
      if (p.kind === 'mock') continue;
      const u = safeUrl(p.base_url);
      if (!u) continue; // z.string().url() 已标记
      const insecure = u.protocol !== 'https:';
      const local = isLocalOrPrivateHost(u.hostname);
      if ((insecure || local) && !p.allow_insecure_base_url) {
        const why = insecure ? `scheme "${u.protocol.replace(':', '')}" is not https` : `host "${u.hostname}" is local/private`;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['providers', pid, 'base_url'],
          message: `${why}; set allow_insecure_base_url: true on this provider to opt in explicitly (unencrypted/local endpoint)`,
        });
      }
    }

    if (Object.keys(cfg.providers).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers'], message: 'at least one provider is required' });
    }
    if (Object.keys(cfg.workflows).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workflows'], message: 'at least one workflow is required' });
    }

    // —— 工作流交叉校验（基线 §7 语义）——
    for (const [wfId, wf] of Object.entries(cfg.workflows)) {
      const base = ['workflows', wfId];
      if (wf.steps.length > wf.limits.max_steps) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...base, 'steps'],
          message: `workflow declares ${wf.steps.length} steps but limits.max_steps is ${wf.limits.max_steps}`,
        });
      }
      wf.steps.forEach((step, i) => {
        const path = [...base, 'steps', i];
        const provider = cfg.providers[step.provider];
        if (!provider) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'provider'],
            message: `unknown provider "${step.provider}" (configured: ${Object.keys(cfg.providers).join(', ') || 'none'})`,
          });
        } else if (!provider.models.some((m) => m.id === step.model)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'model'],
            message: `provider "${step.provider}" has no model "${step.model}"`,
          });
        }
        if (step.timeout_ms > wf.limits.total_timeout_ms) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'timeout_ms'],
            message: `step timeout ${step.timeout_ms}ms exceeds limits.total_timeout_ms (${wf.limits.total_timeout_ms}ms)`,
          });
        }
        if (i === 0) {
          if (step.run_if !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'run_if'],
              message: 'the first step must not declare run_if (it always runs)',
            });
          }
          if (step.input !== 'original') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'input'],
              message: 'the first step input must be "original"',
            });
          }
        } else if (step.run_if === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'run_if'],
            message: 'run_if is required for every step after the first',
          });
        }
        if (step.gate === 'structured_review') {
          if (step.input !== 'review_template') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'input'],
              message: 'a structured_review gate step must use input "review_template"',
            });
          }
          if (!step.review_schema || !step.review_schema.includes('verdict')) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, 'review_schema'],
              message: 'structured_review requires review_schema containing "verdict"',
            });
          }
        } else if (step.review_schema !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'review_schema'],
            message: 'review_schema is only valid on a step with gate: structured_review',
          });
        }
        if (step.run_if === 'review_verdict_is_revise' && !wf.steps.slice(0, i).some((s) => s.gate === 'structured_review')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'run_if'],
            message: 'review_verdict_is_revise requires an earlier step with gate: structured_review',
          });
        }
      });
    }
  });

export type BayzeConfig = z.infer<typeof configSchema>;

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** 本地/私有/保留主机判定（用于 base_url 的显式 opt-in 门禁） */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1] ?? '-1');
    const b = Number(m[2] ?? '-1');
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return h.endsWith('.local') || h.endsWith('.internal');
}
