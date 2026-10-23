<template>
    <section class="logs-page">
        <PageHeader :title="`${t('realtimeLogs')} (${count})`" :description="t('adminLogsDescription')">
            <template #actions
                ><el-button :disabled="!logs" @click="$emit('download')">{{ t("downloadLogs") }}</el-button></template
            >
        </PageHeader>
        <p class="retention-note">{{ t("runtimeLogsRetentionNotice") }}</p>
        <div class="logs-panel">
            <div class="log-toolbar">
                <el-checkbox :model-value="follow" @update:model-value="$emit('update:follow', $event)">{{
                    t("adminFollowLogs")
                }}</el-checkbox>
                <el-button :disabled="!logs" @click="$emit('copy', logs)">{{ t("adminCopyLogs") }}</el-button>
            </div>
            <pre
                id="log-container"
                ref="container"
                tabindex="0"
                :aria-label="t('realtimeLogs')"
                @scroll="onScroll"
            ><template v-for="(line, index) in lines" :key="index"><span :class="tone(line)">{{ line }}</span>{{ '\n' }}</template></pre>
            <p v-if="!logs" role="status" class="empty-logs">{{ t("adminNoLogs") }}</p>
        </div>
    </section>
</template>
<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import PageHeader from "../components/common/PageHeader.vue";
const props = defineProps({
    count: { default: 0, type: Number },
    follow: Boolean,
    logs: { default: "", type: String },
    scrollTop: { default: 0, type: Number },
    t: { required: true, type: Function },
});
const emit = defineEmits(["update:follow", "scroll", "copy", "download"]);
const container = ref(null);
const lines = computed(() => (props.logs ? props.logs.split("\n") : []));
const tone = line => (/^\[ERROR\]/.test(line) ? "log-error" : /^\[WARN\]/.test(line) ? "log-warning" : "");
const followEnd = () =>
    nextTick(() => {
        if (container.value && props.follow) container.value.scrollTop = container.value.scrollHeight;
    });
watch(() => props.logs, followEnd);
watch(() => props.follow, followEnd);
onMounted(() => {
    container.value.scrollTop = props.follow ? container.value.scrollHeight : props.scrollTop;
});
const onScroll = event => {
    const el = event.target;
    emit("scroll", el.scrollTop);
    emit("update:follow", el.scrollHeight - el.scrollTop - el.clientHeight < 24);
};
</script>
<style scoped>
.logs-page {
    height: calc(100dvh - 48px);
    display: flex;
    flex-direction: column;
    min-height: 360px;
}
.retention-note {
    color: var(--text-secondary);
    margin: 0 0 16px;
}
.logs-panel {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-card);
    overflow: hidden;
}
.log-toolbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
}
pre {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 16px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: "SF Mono", Consolas, Menlo, monospace;
    font-size: 14px;
    line-height: 1.5;
}
.log-error {
    color: var(--color-error);
    font-weight: 600;
}
.log-warning {
    color: var(--color-warning);
    font-weight: 600;
}
.empty-logs {
    padding: 16px;
    color: var(--text-secondary);
}
@media (max-width: 767px) {
    .logs-page {
        height: calc(100dvh - 100px);
    }
}
</style>
