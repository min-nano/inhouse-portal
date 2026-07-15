/**
 * クライアント側の認証(ClerkJS)。
 *
 * 画面(静的シェル)は公開配信され、ここで ClerkJS を初期化して UI をゲートする。
 * 未サインインなら Clerk のサインイン画面(Account Portal)へリダイレクトする。
 * ClerkJS が dev ブラウザ機構を含む Clerk のフローを処理するため、production でも
 * preview(`*.pages.dev` / development インスタンス)でもサインイン後の戻りが成立する。
 *
 * 実データ・操作の保護は引き続き **サーバー側の /api/* ゲート**(functions/_middleware.ts)
 * が担う。ここはあくまで UX(ログイン導線とセッション管理)で、セキュリティ境界ではない。
 */
import { Clerk } from "@clerk/clerk-js";

// Publishable key はビルド時に注入する公開値(pk_…)。クライアントに埋め込んで問題ない。
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

let clerkInstance: Clerk | null = null;

/** 初期化済みの Clerk インスタンス(requireSignIn 解決後に利用可能)。 */
export function getClerk(): Clerk | null {
  return clerkInstance;
}

/**
 * ClerkJS を初期化し、サインイン済みになるまで先へ進めない。
 * - 未サインイン: Clerk のサインイン画面へリダイレクトし、以降の処理は行わない。
 * - サインイン済み: 解決して呼び出し側(画面描画)に制御を戻す。
 */
export async function requireSignIn(): Promise<Clerk> {
  if (!publishableKey) {
    // キー未注入(VITE_CLERK_PUBLISHABLE_KEY のビルド設定漏れ)。API 側のゲートで
    // データは守られるが、ログイン導線を出せないので明示的に失敗させる。
    throw new Error(
      "VITE_CLERK_PUBLISHABLE_KEY が未設定です(ビルド環境変数を確認してください)。",
    );
  }

  const clerk = new Clerk(publishableKey);
  await clerk.load();
  clerkInstance = clerk;

  if (!clerk.user) {
    // サインイン画面へ。サインイン後は元のページに戻す。
    await clerk.redirectToSignIn({
      signInFallbackRedirectUrl: window.location.href,
    });
    // リダイレクトが走るので後続は実行されない。念のため解決させない。
    await new Promise<never>(() => {});
  }

  return clerk;
}

/** サインアウトする(Clerk のセッションを破棄し、設定された遷移先へ)。 */
export async function signOut(): Promise<void> {
  await clerkInstance?.signOut();
}
