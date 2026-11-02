<template>
    <section class="build-presets" aria-label="Build 自用预设">
        <h3>Build 自用预设</h3>
        <p v-if="error" role="alert">{{ error }}</p>
        <p>可选上传仅供自用 build/ 预设匹配；需要启用配置，build-st/ 始终使用插件分段。文件最多 1 MiB。</p>
        <input type="file" accept=".json,application/json" aria-label="上传酒馆预设 JSON" @change="upload" />
        <p v-for="p in presets" :key="p.id">
            {{ p.name }}：{{ p.enabled ? "启用" : "停用" }}，命中请求 {{ p.requests }}
            <ElButton @click="toggle(p)">{{ p.enabled ? "停用" : "启用" }}</ElButton>
            <ElButton @click="remove(p)">删除</ElButton>
        </p>
    </section>
</template>
<script setup>
import { onMounted, ref } from "vue";
import { ElButton } from "element-plus";
const presets = ref([]),
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
        presets.value = await api("/api/build/presets");
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
onMounted(refresh);
</script>
