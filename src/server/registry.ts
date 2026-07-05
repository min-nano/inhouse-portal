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

export const RegistrySchema = z
  .object({
    apps: z.array(AppEntrySchema),
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
export type Registry = z.infer<typeof RegistrySchema>;

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
