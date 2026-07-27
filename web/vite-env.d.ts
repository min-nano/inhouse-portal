/// <reference types="vite/client" />

/**
 * ビルド時に vite の `define` で注入される Clerk の Publishable key(`pk_…`、公開値)。
 * サーバーと同じ環境変数 `CLERK_PUBLISHABLE_KEY` を元に焼き込む(vite.config.ts 参照)。
 * 未設定ならビルド時に空文字になる。
 */
declare const __CLERK_PUBLISHABLE_KEY__: string;
