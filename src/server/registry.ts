import { z } from "zod";

export const AppEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "idは英小文字・数字・ハイフンのみ"),
  name: z.string().min(1),
  description: z.string().default(""),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), "urlはhttpsのみ許可"),
});

/**
 * 自動取得(GASレジストリ)エントリの表示上書き設定。
 * scriptId をキーに、名前やカテゴリを手動で調整できる。
 */
export const GasOverrideSchema = z
  .object({
    /** true にすると、その scriptId を一覧に出さない(除外の別表現) */
    hidden: z.boolean().optional(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    category: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Phase 2 の GASレジストリ(自動列挙)に関する設定。apps.json に任意で置く。
 * 未指定なら自動取得は無効/既定値で動作する。
 */
export const GasRegistryConfigSchema = z
  .object({
    /** 自動取得分の既定カテゴリ(override で個別に上書き可能) */
    defaultCategory: z.string().min(1).default("自動取得"),
    /** 一覧から除外する scriptId */
    exclude: z.array(z.string().min(1)).default([]),
    /** scriptId ごとの表示上書き */
    overrides: z.record(GasOverrideSchema).default({}),
  })
  .strict();

export const RegistrySchema = z
  .object({
    apps: z.array(AppEntrySchema),
    /** Phase 2: 自動取得(GASレジストリ)の除外・表示上書き設定(任意) */
    gasRegistry: GasRegistryConfigSchema.optional(),
  })
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    for (const app of registry.apps) {
      if (seen.has(app.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `idが重複しています: ${app.id}`,
          path: ["apps"],
        });
      }
      seen.add(app.id);
    }
  });

export type AppEntry = z.infer<typeof AppEntrySchema>;
export type GasOverride = z.infer<typeof GasOverrideSchema>;
export type GasRegistryConfig = z.infer<typeof GasRegistryConfigSchema>;
export type Registry = z.infer<typeof RegistrySchema>;

/** apps.json の gasRegistry 設定を、未指定でも既定値付きで取り出す。 */
export function resolveGasRegistryConfig(registry: Registry): GasRegistryConfig {
  return registry.gasRegistry ?? GasRegistryConfigSchema.parse({});
}

/** apps.json の内容を検証して返す。不正なら ZodError を投げる。 */
export function loadRegistry(data: unknown): Registry {
  return RegistrySchema.parse(data);
}

/** カテゴリ一覧 (登場順を保ったまま重複除去) */
export function listCategories(registry: Registry): string[] {
  const categories: string[] = [];
  for (const app of registry.apps) {
    if (!categories.includes(app.category)) {
      categories.push(app.category);
    }
  }
  return categories;
}
