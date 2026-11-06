<template>
    <section class="status-card runtime-status" :aria-label="t('runtimeTitle')">
        <div class="runtime-heading">
            <h3>{{ t("runtimeTitle") }}</h3>
            <ElButton
                :disabled="busy || unavailable || !data?.application.restartAvailable || data?.application.restarting"
                :loading="busy"
                @click="restart"
            >
                {{ t("runtimeRestart") }}
            </ElButton>
        </div>
        <p class="runtime-note">{{ t("runtimeScope") }}</p>
        <p v-if="unavailable" role="alert">{{ t("runtimeUnavailable") }}</p>
        <template v-else-if="data">
            <dl class="runtime-list">
                <div>
                    <dt>
                        {{ t("runtimeApplication") }} <small>Node · PID {{ data.application.pid }}</small>
                    </dt>
                    <dd>
                        <span :class="['runtime-state', data.application.state]">{{
                            status(data.application.state)
                        }}</span>
                    </dd>
                    <dd>{{ t("runtimeUptime") }} {{ duration(data.application.uptimeSeconds) }}</dd>
                </div>
                <div>
                    <dt>{{ t(data.backend.kind === "local" ? "runtimeEngine" : "runtimeBrowser") }}</dt>
                    <dd>
                        <span :class="['runtime-state', data.backend.state]">{{ status(data.backend.state) }}</span>
                    </dd>
                    <dd>
                        {{ t("runtimeRecovery") }} {{ data.backend.recoveryAttempts ?? "—" }}
                        <template v-if="data.backend.restarts !== null">
                            · {{ t("runtimeEngineRestarts") }} {{ data.backend.restarts }}</template
                        >
                    </dd>
                </div>
                <div>
                    <dt>{{ t("runtimeScheduler") }}</dt>
                    <dd>
                        <span :class="['runtime-state', data.scheduler?.state]">{{
                            data.scheduler ? status(data.scheduler.state) : t("runtimeLegacy")
                        }}</span>
                    </dd>
                    <dd v-if="data.scheduler">
                        {{ t("runtimeActive") }} {{ data.scheduler.active }} · {{ t("runtimeQueued") }}
                        {{ data.scheduler.queued }}
                    </dd>
                    <dd v-else>—</dd>
                </div>
                <div>
                    <dt>{{ t("runtimeContexts") }}</dt>
                    <dd v-if="data.contextPool">
                        {{ t("runtimeReady") }} {{ data.contextPool.ready }} · {{ t("runtimeInitializing") }}
                        {{ data.contextPool.initializing }}
                    </dd>
                    <dd v-else>—</dd>
                    <dd v-if="data.contextPool">{{ t("runtimeStale") }} {{ data.contextPool.staleInitializing }}</dd>
                </div>
                <div>
                    <dt>{{ t("runtimeNodeMemory") }}</dt>
                    <dd>{{ memory(data.application.rssBytes) }}</dd>
                    <dd class="runtime-note">{{ t("runtimeNodeMemoryHint") }}</dd>
                </div>
                <div>
                    <dt>{{ t("runtimeGroupMemory") }}</dt>
                    <dd v-if="data.memory">
                        {{ memory(data.memory.usedBytes) }} /
                        {{
                            !data.memory.limitKnown
                                ? t("runtimeMetricUnavailable")
                                : data.memory.limitBytes === null
                                  ? t("runtimeNoLimit")
                                  : memory(data.memory.limitBytes)
                        }}
                        <progress
                            v-if="data.memory.limitBytes"
                            :value="data.memory.usedBytes"
                            :max="data.memory.limitBytes"
                            :aria-label="t('runtimeGroupMemory')"
                        ></progress>
                    </dd>
                    <dd v-else>{{ t("runtimeMetricUnavailable") }}</dd>
                    <dd class="runtime-note">{{ t("runtimeGroupMemoryHint") }}</dd>
                </div>
            </dl>
            <p v-if="!data.application.restartAvailable" class="runtime-note">{{ t("runtimeNoSupervisor") }}</p>
        </template>
        <p v-else role="status">{{ t("loading") }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
    </section>
</template>

<script setup>
import { onBeforeUnmount, ref } from "vue";
import { ElButton, ElMessageBox } from "element-plus";

const props = defineProps({
    data: { default: null, type: Object },
    t: { required: true, type: Function },
    unavailable: Boolean,
});
const emit = defineEmits(["refresh"]);
const busy = ref(false);
const message = ref("");
const error = ref("");
let disposed = false;
let timer;
let resume;
const controller = new AbortController();
onBeforeUnmount(() => {
    disposed = true;
    controller.abort();
    clearTimeout(timer);
    resume?.();
});
const status = value => props.t(`runtimeState_${value}`);
const memory = value => {
    if (!Number.isFinite(value) || value < 0) return "—";
    return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
};
const duration = value => {
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
};
async function api(method = "GET", body) {
    const response = await fetch(method === "GET" ? "/api/configuration" : "/api/configuration/restart", {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method,
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.redirected || response.status === 401)
        throw Object.assign(new Error(props.t("runtimeLoginRequired")), { status: 401 });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
}
async function restart() {
    if (busy.value) return;
    try {
        await ElMessageBox.confirm(props.t("runtimeRestartConfirm"), props.t("runtimeRestart"), {
            cancelButtonText: props.t("cancel"),
            confirmButtonText: props.t("runtimeRestart"),
            type: "warning",
        });
    } catch {
        return;
    }
    busy.value = true;
    error.value = "";
    message.value = "";
    try {
        const snapshot = await api();
        const previous = await api("POST", { version: snapshot.version });
        message.value = props.t("runtimeRestartWaiting");
        const deadline = Date.now() + 360000;
        while (!disposed && Date.now() < deadline) {
            await new Promise(resolve => {
                resume = resolve;
                timer = setTimeout(resolve, 1500);
            });
            if (disposed) return;
            let latest;
            try {
                latest = await api();
            } catch (cause) {
                if (cause.status === 401) throw cause;
                continue;
            }
            if (latest.instanceId === previous.instanceId) continue;
            if (latest.restartError) throw new Error(latest.restartError);
            if (!latest.ready || !latest.operational) continue;
            if (latest.pending.length || latest.version !== previous.version)
                throw new Error(props.t("runtimeRestartMismatch"));
            message.value = props.t("runtimeRestartSuccess");
            emit("refresh");
            return;
        }
        if (!disposed) throw new Error(props.t("runtimeRestartTimeout"));
    } catch (cause) {
        if (!disposed) {
            message.value = "";
            error.value = cause.message;
        }
    } finally {
        busy.value = false;
    }
}
</script>

<style scoped lang="less">
.runtime-status {
    margin-bottom: 24px;
}

.runtime-heading {
    align-items: center;
    display: flex;
    gap: 16px;
    justify-content: space-between;

    h3 {
        margin: 0;
    }
}

.runtime-note {
    color: var(--text-secondary);
    font-size: 13px;
}

.runtime-list {
    margin: 16px 0 0;

    > div {
        align-items: center;
        border-top: 1px solid var(--border-color);
        display: grid;
        gap: 12px;
        grid-template-columns: minmax(160px, 1fr) minmax(150px, 1fr) minmax(180px, 1.5fr);
        padding: 14px 0;
    }

    dd {
        margin: 0;
        overflow-wrap: anywhere;
    }

    small {
        color: var(--text-secondary);
        display: block;
        margin-top: 4px;
    }

    progress {
        accent-color: var(--color-success);
        display: block;
        height: 8px;
        margin-top: 8px;
        width: 100%;
    }
}

.runtime-state {
    &::before {
        background: currentcolor;
        border-radius: 50%;
        content: "";
        display: inline-block;
        height: 8px;
        margin-right: 8px;
        width: 8px;
    }

    &.running {
        color: var(--color-success);
    }

    &.starting,
    &.restarting,
    &.recovering,
    &.degraded {
        color: var(--color-warning);
    }

    &.stopped {
        color: var(--text-secondary);
    }
}

@media (width <= 680px) {
    .runtime-list > div {
        gap: 8px;
        grid-template-columns: 1fr;
    }
}
</style>
