import { ALL_CATEGORY, filterApps, type AppEntry } from "./filter";

type AppsResponse = {
  apps: AppEntry[];
  categories: string[];
  source?: {
    manual: number;
    auto: number;
    registryConfigured?: boolean;
    stale?: boolean;
    error?: string;
  };
};

const state = {
  apps: [] as AppEntry[],
  categories: [] as string[],
  query: "",
  category: ALL_CATEGORY,
};

const $search = document.getElementById("search") as HTMLInputElement;
const $categories = document.getElementById("categories")!;
const $apps = document.getElementById("apps")!;
const $status = document.getElementById("status")!;
const $user = document.getElementById("user")!;
const $userEmail = document.getElementById("user-email")!;

function showStatus(message: string) {
  $status.textContent = message;
  $status.hidden = false;
}

function hideStatus() {
  $status.hidden = true;
}

function renderCategories() {
  $categories.replaceChildren(
    ...[ALL_CATEGORY, ...state.categories].map((category) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = category;
      button.className = "category-chip";
      button.setAttribute(
        "aria-pressed",
        String(category === state.category),
      );
      button.addEventListener("click", () => {
        state.category = category;
        renderCategories();
        renderApps();
      });
      return button;
    }),
  );
}

function renderApps() {
  const visible = filterApps(state.apps, state.query, state.category);
  if (visible.length === 0) {
    $apps.replaceChildren();
    showStatus("条件に一致するツールがありません。");
    return;
  }
  hideStatus();
  $apps.replaceChildren(
    ...visible.map((app) => {
      const card = document.createElement("a");
      card.className = "app-card";
      card.href = app.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      const meta = document.createElement("div");
      meta.className = "app-meta";
      const category = document.createElement("span");
      category.className = "app-category";
      category.textContent = app.category;
      meta.append(category);
      if (app.auto) {
        const badge = document.createElement("span");
        badge.className = "app-badge";
        badge.textContent = "自動";
        badge.title = "GASレジストリから自動取得したツールです";
        meta.append(badge);
      }

      const name = document.createElement("h2");
      name.textContent = app.name;

      const description = document.createElement("p");
      description.textContent = app.description;

      const tags = document.createElement("div");
      tags.className = "app-tags";
      for (const tag of app.tags) {
        const pill = document.createElement("span");
        pill.className = "tag";
        pill.textContent = tag;
        tags.append(pill);
      }

      card.append(meta, name, description, tags);
      return card;
    }),
  );
}

async function loadUser() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return;
    const me = (await res.json()) as { authenticated: boolean; email?: string };
    if (me.authenticated && me.email) {
      $userEmail.textContent = me.email;
      $user.hidden = false;
    }
  } catch {
    // ヘッダのユーザー表示は必須ではないので、失敗しても無視
  }
}

async function init() {
  showStatus("読み込み中…");
  loadUser();
  try {
    // 手動台帳(apps.json)と GASレジストリの自動取得分をマージした一覧。
    // レジストリ未設定や取得失敗時も手動分は必ず返る。
    const res = await fetch("/api/registry");
    if (res.status === 401) {
      // セッション切れ: ログインへ誘導
      location.href = "/api/auth/login";
      return;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as AppsResponse;
    state.apps = data.apps;
    state.categories = data.categories;
    renderCategories();
    renderApps();
  } catch (err) {
    showStatus(
      `ツール一覧の取得に失敗しました (${err instanceof Error ? err.message : String(err)})。再読み込みしてください。`,
    );
  }
}

$search.addEventListener("input", () => {
  state.query = $search.value;
  renderApps();
});

init();
