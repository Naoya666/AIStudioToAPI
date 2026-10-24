<template>
    <section class="configuration-panel">
        <div class="configuration-actions">
            <ElButton type="primary" :disabled="busy || conflict || !dirtyNames.length" @click="save">保存</ElButton>
            <ElButton :disabled="busy || !snapshot" @click="restart">重启</ElButton>
            <ElButton :disabled="busy || !dirtyNames.length" @click="discard">放弃草稿</ElButton>
            <ElButton :disabled="busy || !snapshot?.pending.length" @click="undo">撤销待重启变更</ElButton>
            <ElButton :disabled="busy" @click="refreshWithDraft">刷新配置</ElButton>
        </div>
        <p role="status">
            {{ dirtyNames.length }} 项修改尚未保存；{{ snapshot?.pending.length || 0 }} 项已保存配置待重启生效。
        </p>
        <p v-if="snapshot">当前运行：{{ modeLabel(snapshot.running.ACCOUNT_ROTATION_STRATEGY) }}</p>
        <p v-if="snapshot?.environmentError" role="alert">
            环境配置存在无效值：{{ snapshot.environmentError }}。恢复环境值时需要先修正文件配置。
        </p>
        <p v-if="conflict" role="alert">配置已被其他页面修改。草稿已保留，请刷新并处理差异后再保存。</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <p v-if="snapshot?.restartError" role="alert">
            上次重启失败：{{ snapshot.restartError }}。已使用上一份可用配置恢复；请检查待生效项并修改或撤销。
        </p>
        <details v-if="snapshot?.pending.length">
            <summary>查看待重启变更</summary>
            <p v-for="item in snapshot.pending" :key="item.name">
                {{ label(item.name) }}：{{ display(item.name, snapshot.running[item.name]) }} →
                {{ display(item.name, snapshot.saved[item.name]) }}（{{ item.reason }}）
            </p>
        </details>
        <div v-if="snapshot" class="configuration-layout">
            <nav class="configuration-directory" :aria-label="t('adminConfigGroups')">
                <p class="directory-title">{{ t("adminConfigGroups") }}</p>
                <a
                    v-for="(group, groupIndex) in groups"
                    :key="group.name"
                    :href="`#configuration-group-${groupIndex}`"
                    :class="{ 'is-active': activeGroup === group.name }"
                    :aria-current="activeGroup === group.name ? 'location' : undefined"
                    @click="activeGroup = group.name"
                    ><span class="directory-index">{{ String(groupIndex + 1).padStart(2, "0") }}</span
                    ><span>{{ group.name }}</span></a
                >
            </nav>
            <div ref="groupsContainer" class="configuration-groups">
                <fieldset
                    v-for="(group, groupIndex) in groups"
                    :id="`configuration-group-${groupIndex}`"
                    :key="group.name"
                    :data-group="group.name"
                    :class="{ 'allowlist-group': group.fields.some(d => d.type === 'modelAllowlist') }"
                >
                    <legend>{{ group.name }}</legend>
                    <div v-for="d in group.fields" :key="d.name" class="configuration-field">
                        <div class="configuration-label">
                            <label :for="`config-${d.name}`" :title="`${d.name}：${d.description}`">{{
                                d.label
                            }}</label>
                            <ElPopover trigger="click" :width="320" :content="`${d.name}：${d.description}`">
                                <template #reference
                                    ><button type="button" :aria-label="`${d.label}说明`">ⓘ</button></template
                                >
                            </ElPopover>
                            <span>{{
                                pending(d.name) ? "重启后生效" : d.application === "hot" ? "保存后生效" : "重启后生效"
                            }}</span>
                        </div>
                        <details v-if="d.type === 'modelAllowlist'" class="model-settings-collapse">
                            <summary>模型权限及启用设置（{{ models.length }} 个模型，点击展开）</summary>
                            <ModelAllowlistEditor
                                v-model="draft[d.name]"
                                v-model:hidden-models="snapshot.hiddenModels"
                                :models="models"
                                :visibility-available="snapshot.modelVisibilityAvailable"
                                :disabled="busy"
                                @visibility-busy="busy = $event"
                                @visibility-dirty="visibilityDirty = $event"
                            />
                        </details>
                        <ElSwitch
                            v-else-if="d.type === 'boolean'"
                            :id="`config-${d.name}`"
                            v-model="draft[d.name]"
                            :disabled="busy"
                        />
                        <ElSelect
                            v-else-if="d.type === 'enum'"
                            :id="`config-${d.name}`"
                            v-model="draft[d.name]"
                            :disabled="busy"
                        >
                            <ElOption
                                v-for="value in d.choices"
                                :key="value"
                                :value="value"
                                :label="choiceLabel(value)"
                            />
                        </ElSelect>
                        <template v-else-if="d.type === 'integer'">
                            <ElInputNumber
                                :id="`config-${d.name}`"
                                v-model="draft[d.name]"
                                :min="d.minimum"
                                :max="d.maximum"
                                :step="1"
                                :precision="0"
                                :disabled="busy"
                            />
                            <span>{{ d.unit }}</span>
                        </template>
                        <ElInput
                            v-else-if="d.type === 'time'"
                            :id="`config-${d.name}`"
                            v-model="draft[d.name]"
                            placeholder="HH:mm（洛杉矶时区）"
                            :disabled="busy"
                        />
                        <template v-else-if="d.type === 'keys'">
                            <ElInput
                                v-if="secretsVisible"
                                :id="`config-${d.name}`"
                                v-model="draft[d.name]"
                                type="textarea"
                                placeholder="每行一个 API Key"
                                :disabled="busy"
                            />
                            <span v-else>••••••••</span>
                            <ElButton :disabled="busy" @click="revealSecrets">{{
                                secretsVisible ? "隐藏密钥" : "查看及修改密钥"
                            }}</ElButton>
                            <p>没有独立控制台密码时，新密钥同时用于控制台登录。现有已登录会话继续有效。</p>
                        </template>
                        <ElInput
                            v-else-if="d.type === 'secret'"
                            :id="`config-${d.name}`"
                            v-model="draft[d.name]"
                            type="password"
                            autocomplete="new-password"
                            placeholder="未修改时保留原凭证；输入新值以替换"
                            :disabled="busy"
                        />
                        <div v-else-if="d.type === 'agents'">
                            <div v-for="(row, index) in draft[d.name]" :key="index" class="agent-row">
                                <ElInput v-model="row.name" placeholder="节点名称（仅管理端）" :disabled="busy" />
                                <ElInput v-model="row.nodeId" placeholder="节点 ID" :disabled="busy" />
                                <ElInput v-model="row.url" placeholder="https://agent.example.org" :disabled="busy" />
                                <ElInput
                                    v-model="row.token"
                                    type="password"
                                    autocomplete="new-password"
                                    placeholder="Token；原节点留空保留"
                                    :disabled="busy"
                                />
                                <ElButton :disabled="busy" @click="draft[d.name].splice(index, 1)">删除节点</ElButton>
                            </div>
                            <ElButton
                                :disabled="busy"
                                @click="draft[d.name].push({ name: '', nodeId: '', url: '', token: '' })"
                                >增加节点</ElButton
                            >
                            <p>{{ d.description }}</p>
                        </div>
                        <ElInput
                            v-else-if="d.type === 'codes'"
                            :id="`config-${d.name}`"
                            v-model="draft[d.name]"
                            placeholder="如 429,503；空值关闭"
                            :disabled="busy"
                        />
                        <div v-else-if="d.type === 'transport'">
                            <div class="model-columns"><span>真实上游模型 ID</span><span>调用通道</span></div>
                            <div v-for="(row, index) in draft[d.name]" :key="index" class="model-row transport-row">
                                <input
                                    v-model="row.model"
                                    :list="`models-${d.name}`"
                                    aria-label="真实上游模型 ID"
                                    :disabled="busy"
                                    placeholder="可手动输入上游模型 ID"
                                />
                                <ElSelect v-model="row.transport" aria-label="调用通道" :disabled="busy">
                                    <ElOption value="legacy" label="旧通道（legacy）" />
                                    <ElOption value="makersuite" label="桥接通道（makersuite）" />
                                </ElSelect>
                                <ElButton :disabled="busy" @click="draft[d.name].splice(index, 1)">删除</ElButton>
                            </div>
                            <datalist :id="`models-${d.name}`">
                                <option v-for="model in models" :key="model" :value="model" />
                            </datalist>
                            <ElButton :disabled="busy" @click="draft[d.name].push({ model: '', transport: 'legacy' })"
                                >增加模型</ElButton
                            >
                            <p>
                                默认 Gemini 4 Argon
                                使用桥接通道，其他模型使用旧通道。删除配置后恢复默认规则；桥接通道缓冲输出，不提供上游实时增量。保存后需重启生效。
                            </p>
                        </div>
                        <div v-else-if="d.type === 'models'">
                            <div class="model-columns">
                                <span>真实上游模型 ID</span
                                ><span>{{
                                    d.name === "MODEL_WORKER_ALLOCATION" ? "最低保障 / 优先分配数量" : "并发上限"
                                }}</span>
                            </div>
                            <div v-for="(row, index) in draft[d.name]" :key="index" class="model-row">
                                <input
                                    v-model="row.model"
                                    :list="`models-${d.name}`"
                                    aria-label="真实上游模型 ID"
                                    :disabled="busy"
                                    placeholder="可手动输入上游模型 ID"
                                />
                                <ElInputNumber
                                    v-if="d.name === 'MODEL_WORKER_ALLOCATION'"
                                    v-model="row.min_workers"
                                    :min="0"
                                    :precision="0"
                                    aria-label="最低保障数量"
                                    :disabled="busy"
                                />
                                <ElInputNumber
                                    v-model="row.value"
                                    :min="d.name === 'ACCOUNT_MODEL_MAX_CONCURRENCY' ? 0 : 1"
                                    :precision="0"
                                    :aria-label="d.name === 'MODEL_WORKER_ALLOCATION' ? '优先分配数量' : '并发上限'"
                                    :disabled="busy"
                                />
                                <ElButton :disabled="busy" @click="draft[d.name].splice(index, 1)">删除</ElButton>
                            </div>
                            <datalist :id="`models-${d.name}`">
                                <option v-for="model in models" :key="model" :value="model" />
                            </datalist>
                            <ElButton
                                :disabled="busy"
                                @click="draft[d.name].push({ model: '', value: 1, min_workers: 0 })"
                                >增加模型</ElButton
                            >
                            <p>删除单独配置后继承既有默认规则；不会禁用模型。资源分配数量并非独立浏览器进程数量。</p>
                        </div>
                        <p v-if="pending(d.name)">
                            当前生效：{{ display(d.name, snapshot.running[d.name]) }}；已保存：{{
                                display(d.name, snapshot.saved[d.name])
                            }}
                        </p>
                        <p v-if="dirtyNames.includes(d.name) && !pending(d.name)">
                            当前生效：{{ display(d.name, snapshot.running[d.name]) }}
                        </p>
                        <p v-if="dirtyNames.includes(d.name)">
                            草稿尚未保存{{ resets.includes(d.name) ? "，保存时恢复环境值或默认值" : "" }}。
                        </p>
                        <p v-if="d.name === 'USAGE_LOG_RETENTION_DAYS'">
                            按连续 24 小时计算，0 永久保留；已删除数据无法恢复。{{
                                snapshot.usageEnabled ? "" : "统计未启用，暂不产生清理效果。"
                            }}
                        </p>
                        <p v-if="d.name === 'SCHEDULER_DAILY_RESET_TIME'">每日重置不会恢复上游真实配额。</p>
                        <ElButton
                            v-if="d.resettable !== false && snapshot.overridden.includes(d.name)"
                            size="small"
                            :disabled="busy"
                            @click="resetField(d)"
                            >恢复环境值 / 默认值（保存后提交）</ElButton
                        >
                    </div>
                </fieldset>
            </div>
        </div>
    </section>
</template>

<script setup>
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();
const activeGroup = ref("");
const groupsContainer = ref(null);
let groupObserver;

import { useDraftGuard } from "../composables/useDraftGuard";
import ModelAllowlistEditor from "./ModelAllowlistEditor.vue";
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from "vue";
import { ElButton, ElSwitch, ElSelect, ElOption, ElInputNumber, ElInput, ElPopover, ElMessageBox } from "element-plus";
const secretDefaultDraft = ref(null);
const snapshot = ref(null),
    draft = reactive({}),
    base = reactive({}),
    resets = ref([]),
    models = ref([]);
const visibilityDirty = ref(false);
const busy = ref(false),
    conflict = ref(false),
    error = ref(""),
    message = ref(""),
    secretsVisible = ref(false);
let timer,
    disposed = false;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dirtyNames = computed(
    () =>
        snapshot.value?.definitions
            .filter(d => !equal(draft[d.name], base[d.name]) || resets.value.includes(d.name))
            .map(d => d.name) || []
);
const groups = computed(() => {
    const result = new Map();
    for (const d of snapshot.value?.definitions || []) {
        const mode = draft.ACCOUNT_ROTATION_STRATEGY === "legacy" ? "legacy" : "model";
        if (d.mode !== "all" && d.mode !== mode) continue;
        if (d.name === "STREAM_KEEPALIVE_INTERVAL_MS" && !draft.STREAM_EARLY_HEADERS) continue;
        if (d.name === "SCHEDULER_DAILY_RESET_TIME" && !draft.SCHEDULER_DAILY_RESET_ENABLED) continue;
        if (!result.has(d.group)) result.set(d.group, []);
        result.get(d.group).push(d);
    }
    return [...result].map(([name, fields]) => ({ fields, name }));
});
watch(
    groups,
    () => {
        groupObserver?.disconnect();
        if (!groups.value.some(group => group.name === activeGroup.value))
            activeGroup.value = groups.value[0]?.name || "";
        if (!groupsContainer.value) return;
        groupObserver = new IntersectionObserver(
            entries => {
                const visible = entries
                    .filter(entry => entry.isIntersecting)
                    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
                if (visible.length) activeGroup.value = visible[0].target.dataset.group;
            },
            { rootMargin: "-96px 0px -60% 0px" }
        );
        groupsContainer.value.querySelectorAll("fieldset").forEach(el => groupObserver.observe(el));
    },
    { flush: "post" }
);
watch(
    draft,
    () => {
        resets.value = resets.value.filter(name => {
            const d = snapshot.value.definitions.find(item => item.name === name);
            return equal(
                draft[name],
                name === "API_KEYS" ? secretDefaultDraft.value : toDraft(d, snapshot.value.defaults[name])
            );
        });
    },
    { deep: true }
);
const choiceLabels = {
    agent: "Agent 端",
    BLOCK_LOW_AND_ABOVE: "拦截低及以上风险",
    BLOCK_MEDIUM_AND_ABOVE: "拦截中及高风险",
    BLOCK_NONE: "不拦截",
    BLOCK_ONLY_HIGH: "仅拦截高风险",
    different_proxy_first: "不同代理优先",
    early: "提前发送空首块",
    fake: "缓冲后模拟流式",
    HARM_BLOCK_THRESHOLD_UNSPECIFIED: "上游默认阈值",
    least_recently_used: "较久未使用优先",
    least_used: "较少使用优先",
    legacy: "旧版切换",
    master: "主控端",
    OFF: "关闭安全拦截",
    real: "真实流式",
    standalone: "独立公示",
};
const choiceLabel = value => choiceLabels[value] || value;
const modeLabel = choiceLabel;
const label = name => snapshot.value?.definitions.find(d => d.name === name)?.label || name;
const pending = name => snapshot.value?.pending.some(item => item.name === name);
function display(name, value) {
    return name === "API_KEYS" || snapshot.value?.definitions.find(d => d.name === name)?.secret
        ? "••••••••"
        : typeof value === "boolean"
          ? value
              ? "开启"
              : "关闭"
          : typeof value === "object"
            ? JSON.stringify(value)
            : choiceLabel(value);
}
async function api(url = "/api/configuration", method = "GET", body) {
    const response = await fetch(url, {
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) {
        if (response.status === 409) conflict.value = true;
        throw new Error(result.error || "配置读取失败");
    }
    return result;
}
function toDraft(d, value) {
    if (d.type === "modelAllowlist") return JSON.parse(JSON.stringify(value));
    if (d.type === "agents") return JSON.parse(JSON.stringify(value || []));
    if (d.type === "transport") return Object.entries(value || {}).map(([model, transport]) => ({ model, transport }));
    if (d.type === "models")
        return Object.entries(value || {}).map(([model, limit]) => ({
            min_workers: limit?.min_workers ?? 0,
            model,
            value: d.name === "MODEL_WORKER_ALLOCATION" ? limit.preferred_workers : limit,
        }));
    if (d.type === "keys") return value?.join("\n") ?? null;
    if (d.type === "codes") return value.join(",");
    return value;
}
function accept(value) {
    secretDefaultDraft.value = null;
    snapshot.value = value;
    models.value = value.models || [];
    for (const d of value.definitions) {
        draft[d.name] = toDraft(d, value.saved[d.name]);
        base[d.name] = JSON.parse(JSON.stringify(draft[d.name]));
    }
    resets.value = [];
    conflict.value = false;
    secretsVisible.value = false;
}
async function readLatest() {
    const value = await api();
    if (!Array.isArray(value.definitions) || !Array.isArray(value.pending) || !value.saved || !value.running)
        throw new Error("服务未返回有效的统一配置，请确认后端已更新。");
    if (disposed) return;
    if (!snapshot.value || !dirtyNames.value.length) accept(value);
    else {
        snapshot.value.hiddenModels = value.hiddenModels || [];
        snapshot.value.modelVisibilityAvailable = value.modelVisibilityAvailable;
        if (value.version !== snapshot.value.version) conflict.value = true;
    }
}
function discard() {
    if (snapshot.value) accept(snapshot.value);
}
async function refreshWithDraft() {
    try {
        const latest = await api();
        if (dirtyNames.value.length) {
            const differences = latest.definitions
                .filter(d => !equal(snapshot.value.saved[d.name], latest.saved[d.name]))
                .map(
                    d =>
                        `${d.label}：${display(d.name, snapshot.value.saved[d.name])} → ${display(d.name, latest.saved[d.name])}`
                )
                .join("；");
            await ElMessageBox.confirm(
                `其他页面已保存变更：${differences || "配置版本有更新"}。保留草稿时仅提交自己编辑过的字段；若同一字段被修改，将以草稿覆盖。`,
                "配置差异",
                { cancelButtonText: "取消", confirmButtonText: "保留草稿并更新版本" }
            );
            const edited = Object.fromEntries(
                dirtyNames.value.map(name => [name, JSON.parse(JSON.stringify(draft[name]))])
            );
            const previousResets = [...resets.value];
            accept(latest);
            Object.assign(draft, edited);
            resets.value = previousResets;
        } else accept(latest);
    } catch (cause) {
        if (cause instanceof Error) error.value = cause.message;
    }
}
function resetField(d) {
    draft[d.name] = d.name === "API_KEYS" ? secretDefaultDraft.value : toDraft(d, snapshot.value.defaults[d.name]);
    if (!resets.value.includes(d.name)) resets.value.push(d.name);
}
function encode(d) {
    const value = draft[d.name];
    if (d.type === "agents") return value.map(row => ({ ...row, token: row.token || null }));
    if (d.type === "keys")
        return String(value || "")
            .split("\n")
            .map(key => key.trim())
            .filter(Boolean);
    if (d.type === "codes") return value.trim() ? value.split(",").map(code => Number(code.trim())) : [];
    if (!["models", "transport"].includes(d.type)) return value;
    const entries = [],
        seen = new Set();
    for (const row of value) {
        const model = row.model.trim();
        if (!model || seen.has(model)) throw new Error(`${d.label}：模型名不能为空或重复`);
        seen.add(model);
        entries.push([
            model,
            d.type === "transport"
                ? row.transport
                : d.name === "MODEL_WORKER_ALLOCATION"
                  ? { min_workers: row.min_workers, preferred_workers: row.value }
                  : row.value,
        ]);
    }
    return Object.fromEntries(entries);
}
async function save() {
    busy.value = true;
    error.value = "";
    try {
        const changes = Object.fromEntries(
            snapshot.value.definitions
                .filter(d => dirtyNames.value.includes(d.name) && !resets.value.includes(d.name))
                .map(d => [d.name, encode(d)])
        );
        const result = await api(undefined, "PATCH", { changes, reset: resets.value, version: snapshot.value.version });
        accept(result);
        message.value = `已保存。立即生效：${result.applied.map(label).join("、") || "无"}；等待重启：${result.deferred.map(label).join("、") || "无"}。请求参数用于后续请求；已有排队期限、冷却和登录任务期限不重新计算。`;
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
async function undo() {
    busy.value = true;
    try {
        const edits = Object.fromEntries(dirtyNames.value.map(name => [name, JSON.parse(JSON.stringify(draft[name]))]));
        const previousResets = [...resets.value];
        accept(await api("/api/configuration/undo-pending", "POST", { version: snapshot.value.version }));
        Object.assign(draft, edits);
        resets.value = previousResets;
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
async function revealSecrets() {
    if (secretsVisible.value) {
        secretsVisible.value = false;
        return;
    }
    try {
        const result = await api("/api/configuration/secrets", "POST", {});
        secretDefaultDraft.value = result.defaultApiKeys.join("\n");
        if (draft.API_KEYS === null) {
            base.API_KEYS = result.savedApiKeys.join("\n");
            draft.API_KEYS = resets.value.includes("API_KEYS") ? secretDefaultDraft.value : base.API_KEYS;
        }
        secretsVisible.value = true;
    } catch (cause) {
        error.value = cause.message;
    }
}
async function restart() {
    try {
        await ElMessageBox.confirm(
            `重启只加载已保存配置。${dirtyNames.value.length ? `当前 ${dirtyNames.value.length} 项未保存草稿不会应用。` : ""}运行请求有有限收尾时间。`,
            "重启服务",
            { cancelButtonText: "取消", confirmButtonText: "重启" }
        );
    } catch {
        return;
    }
    busy.value = true;
    error.value = "";
    try {
        const previous = await api("/api/configuration/restart", "POST", { version: snapshot.value.version });
        message.value = "重启已接受，正在等待新实例启动并核对实际运行配置…";
        const deadline = Date.now() + 360000;
        while (!disposed && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                const latest = await api();
                if (latest.instanceId === previous.instanceId || !latest.ready || !latest.operational) continue;
                // Preserve unsaved fields; saved/running values always come from the new instance.
                const edits = Object.fromEntries(
                    dirtyNames.value.map(name => [name, JSON.parse(JSON.stringify(draft[name]))])
                );
                const previousResets = [...resets.value];
                accept(latest);
                Object.assign(draft, edits);
                resets.value = previousResets;
                if (latest.restartError || latest.pending.length || latest.version !== previous.version)
                    throw new Error(latest.restartError || "新实例已启动，但已保存配置尚未全部生效，请核对变更。");
                message.value = "新实例启动成功，已确认保存配置实际生效。";
                return;
            } catch (cause) {
                if (snapshot.value.instanceId !== previous.instanceId) throw cause;
            }
        }
        throw new Error("未能确认重启成功，请刷新查看实际状态及 data/restart-status.json。");
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
onMounted(async () => {
    try {
        await readLatest();
    } catch (cause) {
        error.value = cause.message;
    }
    timer = setInterval(() => {
        if (!busy.value)
            readLatest().catch(cause => {
                error.value = cause.message;
            });
    }, 5000);
});
onBeforeUnmount(() => {
    groupObserver?.disconnect();
    disposed = true;
    clearInterval(timer);
});

useDraftGuard(() => dirtyNames.value.length > 0 || visibilityDirty.value);
</script>

<style scoped>
.configuration-layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    align-items: start;
    gap: 24px;
    margin-top: 24px;
}
.configuration-directory {
    position: sticky;
    top: 88px;
    display: grid;
    gap: 4px;
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-card);
    max-height: calc(100dvh - 112px);
    overflow: auto;
}
.directory-title {
    padding: 4px 8px 12px;
    margin: 0;
    font-weight: 600;
    color: var(--text-primary);
}
.configuration-directory a {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 8px;
    border-radius: 6px;
    text-decoration: none;
    color: var(--text-secondary);
    font-size: 13px;
    overflow-wrap: anywhere;
}
.directory-index {
    flex-shrink: 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
}
.configuration-directory a:hover {
    background: var(--bg-list-item-hover);
}
.configuration-directory a.is-active {
    background: var(--color-primary-soft);
    color: var(--color-primary);
    font-weight: 600;
}
.configuration-groups fieldset {
    scroll-margin-top: 88px;
    background: var(--bg-card);
    margin: 0;
}
@media (max-width: 1199px) {
    .configuration-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
    }
    .configuration-directory {
        position: static;
        display: flex;
        flex-wrap: wrap;
        max-height: none;
        gap: 8px;
    }
    .directory-title {
        width: 100%;
        padding-bottom: 4px;
    }
    .configuration-directory a {
        border: 1px solid var(--border-color);
    }
}
.configuration-actions {
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-card);
}
.configuration-actions,
.configuration-label,
.model-row,
.model-columns {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}
.configuration-groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr));
    align-items: start;
    gap: 16px;
}
.configuration-groups fieldset {
    min-width: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 8px;
    padding: 16px;
}
.allowlist-group {
    grid-column: 1 / -1;
}
.configuration-field {
    padding: 12px 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
}
.configuration-label {
    margin-bottom: 8px;
}
.configuration-label label {
    font-weight: 600;
}
.configuration-label span,
.configuration-field p {
    font-size: 13px;
    color: var(--el-text-color-secondary);
}
.model-row {
    margin: 8px 0;
}
.agent-row {
    display: grid;
    gap: 8px;
    margin: 12px 0;
}
.transport-row .el-select {
    width: 200px;
}
.model-row input {
    min-width: 180px;
    padding: 8px;
}
.configuration-panel p[role="alert"] {
    color: var(--el-color-danger);
}
</style>
