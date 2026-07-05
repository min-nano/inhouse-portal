import rawApps from "../../data/apps.json";
import { createApp } from "./app";
import { loadRegistry } from "./registry";

// デプロイ時にビルドへ焼き込まれる台帳。不正データはデプロイ時に検出される。
const registry = loadRegistry(rawApps);

export default createApp(registry);
