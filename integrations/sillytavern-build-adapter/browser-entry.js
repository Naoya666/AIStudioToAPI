/* eslint-env browser */
// Build Standalone 0.6.0 snapshot (MIT); formatting adapted for this repository.
// Runs in the page's MAIN world. No extension credentials or Chrome APIs here.
import { installSillyTavern } from "./runtime.js";

export async function connectSillyTavernPage({
    root = globalThis,
    doc = document,
    loadOpenAI = () => import(new URL("/scripts/openai.js", location.origin).href),
} = {}) {
    if (
        !root.SillyTavern?.getContext ||
        !doc.querySelector("#send_textarea") ||
        !doc.querySelector("#chat") ||
        doc.querySelector("#preloader, #loader")
    )
        return "waiting";
    const existing = root[Symbol.for("build-standalone.sillytavern.v1")];
    if (existing) return existing.owner === "browser" ? "connected" : "legacy";
    // Old 0.3 adapters have private listeners that cannot be safely removed.
    // Wait until ST finishes loading extensions, then leave them as sole owner.
    const oldPanel = doc.getElementById("build-standalone-adapter-settings");
    const oldScript = Array.from(doc.scripts || []).some(s => {
        try {
            return new URL(s.src, location.href).pathname.endsWith("/build-standalone-adapter/index.js");
        } catch {
            return false;
        }
    });
    if (oldPanel || oldScript) {
        if (oldPanel && !oldPanel.querySelector("[data-build-migration]")) {
            const note = doc.createElement("p");
            note.dataset.buildMigration = "true";
            note.textContent =
                "浏览器连接器已内置酒馆分流。当前仍由旧酒馆扩展处理；请在管理扩展中禁用旧 Build 适配扩展并刷新，由连接器自动接管。";
            oldPanel.append(note);
        }
        return "legacy";
    }
    const openAI = await loadOpenAI();
    installSillyTavern({ getContext: root.SillyTavern.getContext, openAI, owner: "browser" });
    return "connected";
}

export function watchSillyTavernPage() {
    if (window.top !== window) return;
    const marker = Symbol.for("build-standalone.sillytavern.loader");
    if (globalThis[marker]) return;
    globalThis[marker] = true;
    let busy = false,
        done = false;
    const poll = async () => {
        if (busy || done) return;
        busy = true;
        try {
            const state = await connectSillyTavernPage();
            if (state !== "waiting") {
                done = true;
                clearInterval(timer);
                document.documentElement.dataset.buildSillyTavern = state;
            }
        } catch {
            done = true;
            clearInterval(timer);
            document.documentElement.dataset.buildSillyTavern = "error";
            console.warn("[Build connector] 酒馆分流加载失败，请刷新页面并确认酒馆版本支持 Prompt Manager。");
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(poll, 500);
    void poll();
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
}
