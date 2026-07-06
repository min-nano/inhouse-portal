import { ALL_CATEGORY, filterApps, type AppEntry } from "./filter";

type AppsResponse = {
  apps: AppEntry[];
  categories: string[];
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

      const category = document.createElement("span");
      category.className = "app-category";
      category.textContent = app.category;

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

      card.append(category, name, description, tags);
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
    const res = await fetch("/api/apps");
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
