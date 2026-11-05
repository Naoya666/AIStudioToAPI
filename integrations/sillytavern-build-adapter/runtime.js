/* eslint-env browser */
// Build Standalone 0.6.0 snapshot (MIT); formatting adapted for this repository.
import {
    isBuildConnection,
    createTagger,
    hookPromptManager,
    readPresetSegments,
    prepareOutgoing,
    applyOutgoing,
    errorEnvelope,
} from "./transport.js";

export function installSillyTavern({ getContext, openAI, owner = "legacy" }) {
    const key = "build_standalone_adapter";
    const singleton = Symbol.for("build-standalone.sillytavern.v1");
    if (globalThis[singleton]) return globalThis[singleton];
    const { oai_settings, setOpenAIMessages } = openAI;
    const tagger = createTagger(
        Array.from(crypto.getRandomValues(new Uint8Array(12)), x => x.toString(16).padStart(2, "0")).join("")
    );
    let hooked = null,
        statusElement,
        generationType = "normal";
    const context = () => getContext();
    function settings() {
        const ctx = context();
        const saved = (ctx.extensionSettings[key] ??= {});
        // One-time browser migration: old adapter settings must not leave the new
        // built-in splitter off. Later explicit user choices remain respected.
        let changed = false;
        if (owner === "browser" && saved.browserDefaultEnabled !== 1) {
            saved.enabled = true;
            saved.browserDefaultEnabled = 1;
            changed = true;
        } else if (typeof saved.enabled !== "boolean") {
            saved.enabled = true;
            changed = true;
        }
        if (changed) ctx.saveSettingsDebounced?.();
        return saved;
    }
    const active = () =>
        settings().enabled &&
        isBuildConnection({
            chat_completion_source: oai_settings.chat_completion_source,
            model:
                oai_settings.chat_completion_source === "openai"
                    ? oai_settings.openai_model
                    : oai_settings.custom_model,
            reverse_proxy: oai_settings.reverse_proxy,
        });
    const messages = {
        adapter_disabled: "请启用浏览器连接器中的酒馆预设分流。",
        broken_boundary: "内容边界被修改，已阻止请求。",
        custom_body_conflict: "请清空此连接的“自定义请求正文”和“排除正文参数”；扩展需要按请求设置它们。",
        inline_budget_exceeded: "输入框内容估算超过 45000 token。预设没有被截断或移入文件，请缩短预设。",
        preset_not_ready: "尚未读取到本次酒馆预设。请刷新酒馆后发送聊天；“测试连接”请使用普通 gemini 模型。",
        preset_read_failed: "读取本次预设失败，请查看扩展控制台中的错误代码。",
        prompt_api_missing: "当前酒馆缺少所需 Prompt Manager 接口。",
        text_only: "目前支持文本、图片、文件和函数工具；请关闭图片生成、JSON schema 与多候选回复。",
        token_count_unavailable: "酒馆无法完成 token 估算，已阻止请求。",
        unknown_boundary: "内容来源标记已失效，请重新生成。",
    };
    function status(text, bad = false) {
        if (statusElement) {
            statusElement.textContent = text;
            statusElement.dataset.error = String(bad);
        }
    }
    function ensureHook() {
        const promptManager = openAI.promptManager;
        if (promptManager && hooked !== promptManager) {
            hookPromptManager(promptManager, tagger, active);
            hooked = promptManager;
        }
    }
    function start(type, _options, dryRun) {
        ensureHook();
        if (!dryRun)
            generationType = ["normal", "regenerate", "swipe", "continue", "quiet", "impersonate"].includes(type)
                ? type
                : "normal";
    }
    async function send(data) {
        if (!isBuildConnection(data)) {
            // A user can switch connections during prompt preparation. Remove our own
            // transient boundaries if that happens, without changing ordinary requests.
            for (const message of data.messages || [])
                if (typeof message.content === "string" && message.content.includes(tagger.prefix))
                    message.content = tagger.strip(message.content);
            return;
        }
        let envelope;
        try {
            if (!settings().enabled) throw { code: "adapter_disabled" };
            const latest = setOpenAIMessages(context().chat || []).find(m => m.role === "user")?.content;
            const prepared = {
                generationType,
                segments: readPresetSegments(data.messages, tagger, { latestUserText: latest }),
            };
            const inline =
                prepared.segments
                    ?.filter(s => s.placement === "inline")
                    .map(s => s.text)
                    .join("\n") || "";
            // ST's tokenizer is an estimate, not Google's authoritative token counter.
            const tokens = await context().getTokenCountAsync(inline);
            envelope = prepareOutgoing(data, prepared, { inlineTokens: tokens, tokenBudget: 45000 });
            const files = prepared.segments.filter(s => s.placement === "file"),
                presets = prepared.segments.filter(s => s.placement === "inline");
            status(
                `已直接读取启用预设：输入框 ${presets.length} 段 / ${inline.length} 字符（估算 ${tokens} token）；历史和背景文件 ${files.length} 段 / ${files.reduce((n, s) => n + s.text.length, 0)} 字符。`
            );
        } catch (e) {
            const code = messages[e.code] ? e.code : "preset_read_failed";
            envelope = errorEnvelope(code);
            console.info("[Build preset diagnostic]", JSON.stringify({ code: e.code || "preset_read_failed" }));
            const message = messages[code];
            status(message, true);
            globalThis.toastr?.error(message, "Build 酒馆适配");
        }
        // ST's event emitter catches thrown errors, so a rejection envelope is sent
        // instead of relying on throw to stop generation. The gateway rejects it
        // before selecting an account. Old gateways reject the build-st/ namespace.
        applyOutgoing(data, envelope);
    }
    function mount() {
        ensureHook();
        const host = document.querySelector("#extensions_settings2") || document.querySelector("#extensions_settings");
        if (!host || document.getElementById("build-standalone-adapter-settings")) return;
        const panel = document.createElement("div");
        panel.dataset.buildAdapterOwner = owner;
        panel.id = "build-standalone-adapter-settings";
        panel.className = "inline-drawer";
        panel.innerHTML =
            '<div class="inline-drawer-toggle inline-drawer-header"><b>Build 独立版 · 酒馆分流</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" data-enable>启用酒馆预设分流（默认开启）</label><p>版本 0.6.0（' +
            (owner === "browser" ? "浏览器连接器内置" : "兼容酒馆扩展") +
            '）。支持自定义 OpenAI 或 OpenAI＋反向代理连接中的 <code>build-st/</code> 或 <code>anti-build-st/</code> 模型。预设进输入框；历史、世界书和角色资料进项目文件。普通连接不变。</p><p>允许合并系统消息和后期提示词修改；使用自定义连接时需清空自定义正文与排除正文参数。输入框估算上限 45000 token；Build 不支持的温度、Top-P、stop 等采样参数不会转发。思考强度仍由模型后缀决定。</p><p data-status role="status">等待酒馆专用模型请求；此扩展不会自行调用模型。</p></div>';
        host.append(panel);
        statusElement = panel.querySelector("[data-status]");
        const enabled = panel.querySelector("[data-enable]");
        enabled.checked = settings().enabled;
        enabled.addEventListener("change", () => {
            settings().enabled = enabled.checked;
            context().saveSettingsDebounced();
            status("设置已保存。");
        });
    }
    const ctx = context();
    settings();
    const instance = { owner, version: "0.6.0" };
    globalThis[singleton] = instance;
    ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, start);
    ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, send);
    ctx.eventSource.on(ctx.eventTypes.APP_READY, mount);
    mount();

    return instance;
}
