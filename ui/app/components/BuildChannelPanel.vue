<template>
    <details class="build-channel-panel">
        <summary>Build 通道诊断与自用预设</summary>
        <p>Build anti 全部待验证；普通 Build 默认关闭。剩余额度与 Google 重置时间：未知。</p>
        <p>任务快照输出不是逐 token 输出；工具响应缓冲校验后发布。</p>
        <ElButton @click="refresh">刷新诊断</ElButton>
        <p v-if="error" role="alert">{{ error }}</p>
        <template v-if="status">
            <p>Build：{{ status.enabled ? "已启用（待上游验收）" : "未启用" }}</p>
            <p v-for="c in status.channels" :key="c.channel">
                {{ c.channel }}：在途 {{ c.inflight }} / 排队 {{ c.queued }}
            </p>
            <p v-for="a in status.accounts" :key="a.index">
                账号 #{{ a.index }}：页面{{ a.pageReady ? "就绪" : "未就绪" }}，请求项目 {{ a.projectsReady }}，清理{{
                    a.cleanupPending ? "待恢复" : "正常"
                }}
            </p>
            <ElButton
                v-for="a in status.accounts.filter(a => a.cleanupPending)"
                :key="`recover-${a.index}`"
                @click="recover(a.index)"
                >恢复账号 #{{ a.index }} 的 Build 清理</ElButton
            >
        </template>
        <p>可选上传仅供自用 build/ 预设匹配；需要启用配置，build-st/ 始终使用插件分段。文件最多 1 MiB。</p>
        <input type="file" accept=".json,application/json" aria-label="上传酒馆预设 JSON" @change="upload" />
        <p v-for="p in presets" :key="p.id">
            {{ p.name }}：{{ p.enabled ? "启用" : "停用" }}，命中请求 {{ p.requests }}
            <ElButton @click="toggle(p)">{{ p.enabled ? "停用" : "启用" }}</ElButton>
            <ElButton @click="remove(p)">删除</ElButton>
        </p>
    </details>
</template>
<script setup>
import { ref } from "vue";
import { ElButton } from "element-plus";
const status = ref(null),
    presets = ref([]),
    error = ref("");
async function api(url, method = "GET", body) {
    const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Build 管理请求失败");
    return data;
}
async function refresh() {
    try {
        error.value = "";
        [status.value, presets.value] = await Promise.all([api("/api/build/status"), api("/api/build/presets")]);
    } catch (e) {
        error.value = e.message;
    }
}
async function upload(event) {
    try {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 1024 * 1024) throw new Error("文件超过 1 MiB");
        await api("/api/build/presets", "POST", { name: file.name, preset: JSON.parse(await file.text()) });
        await refresh();
    } catch (e) {
        error.value = e.message;
    } finally {
        event.target.value = "";
    }
}
async function recover(index) {
    try {
        await api(`/api/build/recover/${index}`, "POST");
        await refresh();
    } catch (e) {
        error.value = e.message;
    }
}
async function toggle(p) {
    try {
        await api(`/api/build/presets/${p.id}`, "PATCH", { enabled: !p.enabled });
        await refresh();
    } catch (e) {
        error.value = e.message;
    }
}
async function remove(p) {
    try {
        await api(`/api/build/presets/${p.id}`, "DELETE");
        await refresh();
    } catch (e) {
        error.value = e.message;
    }
}
</script>
