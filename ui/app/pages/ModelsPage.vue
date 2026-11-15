<template>
    <section class="models-page">
        <PageHeader
            title="模型管理"
            description="管理模型目录、功能边界、账号权限与预估额度。新增模型默认开放通用功能，保存后对新请求生效。"
        />
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <p v-if="message" role="status">{{ message }}</p>
        <template v-if="loaded">
            <div class="toolbar">
                <ElButton type="primary" :disabled="busy || !dirty" @click="save">保存全部修改</ElButton>
                <ElButton :disabled="busy || !dirty" @click="discard">放弃草稿</ElButton>
                <ElButton :disabled="busy || dirty" @click="load">刷新</ElButton>
                <ElButton :disabled="busy" @click="addModel">添加模型</ElButton>
                <span
                    >{{ rows.length }} 个模型 · {{ changedCount }} 个模型已修改{{
                        globalChanged ? " · 全局策略已修改" : ""
                    }}</span
                >
            </div>
            <details v-if="dirty" class="changes">
                <summary>查看待保存变更</summary>
                <ul>
                    <li v-for="change in changeLabels" :key="change">{{ change }}</li>
                </ul>
                <p v-if="globalChanged">全局抗截断策略已修改</p>
            </details>
            <div class="global-policy">
                <label><input v-model="antiEnabled" type="checkbox" :disabled="busy" /> 启用抗截断</label>
                <label
                    >默认策略
                    <ElSelect v-model="antiDefault" :disabled="busy" aria-label="抗截断默认策略">
                        <ElOption value="off" label="按请求开启" /><ElOption value="prefer" label="默认优先开启" />
                    </ElSelect>
                </label>
                <span>抗截断走现有 OpenAI Chat 处理链路；模型准入和组合准入由下方配置决定。</span>
            </div>
            <div class="toolbar">
                <ElInput v-model="search" placeholder="搜索模型 ID、名称或描述" aria-label="搜索模型" clearable />
                <ElSelect v-model="filter" aria-label="模型状态筛选">
                    <ElOption value="all" label="全部状态" /><ElOption value="enabled" label="已启用" />
                    <ElOption value="disabled" label="已禁用" /><ElOption value="pending" label="待授权" />
                </ElSelect>
                <ElSelect v-model="quotaTier" aria-label="预估额度展示层级">
                    <ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="`额度：${tier.label}`" />
                </ElSelect>
                <ElSelect v-model="copyFrom" aria-label="复制来源层级"
                    ><ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="tier.label"
                /></ElSelect>
                <ElSelect v-model="copyTo" aria-label="复制目标层级"
                    ><ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="tier.label"
                /></ElSelect>
                <ElButton
                    :disabled="busy || copyFrom === copyTo"
                    @click="permissions.tiers[copyTo] = [...permissions.tiers[copyFrom]]"
                    >复制层级权限</ElButton
                >
            </div>
            <p>批量操作只作用于当前搜索和筛选结果。权限、额度和功能开关分别配置；未知账号按 Free 权限处理。</p>
            <div class="toolbar">
                <ElButton :disabled="busy || !filtered.length" @click="setEnabled(true)">批量启用</ElButton>
                <ElButton :disabled="busy || !filtered.length" @click="setEnabled(false)">批量禁用</ElButton>
                <ElSelect v-model="batchTier" aria-label="批量权限层级"
                    ><ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="tier.label"
                /></ElSelect>
                <ElButton :disabled="busy || !filtered.length" @click="setTier(true)">批量授权</ElButton>
                <ElButton :disabled="busy || !filtered.length" @click="setTier(false)">批量取消授权</ElButton>
            </div>
            <div class="table-scroll">
                <table>
                    <thead>
                        <tr>
                            <th>模型 / 通道</th>
                            <th>启用</th>
                            <th v-for="tier in tiers" :key="tier.id">{{ tier.label }}</th>
                            <th>预估额度</th>
                            <th>功能</th>
                            <th>抗截断准入</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="row in paged" :key="row.name">
                            <th scope="row">
                                <button class="model-link" @click="edit(row)">{{ id(row) }}</button
                                ><small
                                    >{{ row.displayName || "未设置显示名称" }} ·
                                    {{ id(row).startsWith("build/") ? "Build" : "Playground" }}</small
                                ><small v-if="!tiers.some(t => allowed(row, t.id))">待授权</small>
                            </th>
                            <td>
                                <input
                                    v-model="row.enabled"
                                    type="checkbox"
                                    :aria-label="`${id(row)} 启用`"
                                    :disabled="busy"
                                />
                            </td>
                            <td v-for="tier in tiers" :key="tier.id">
                                <input
                                    type="checkbox"
                                    :checked="allowed(row, tier.id)"
                                    :aria-label="`${id(row)} ${tier.label} 权限`"
                                    :disabled="busy"
                                    @change="togglePermission(row, tier.id, $event.target.checked)"
                                />
                            </td>
                            <td>
                                {{ quota(row, quotaTier).requests ?? "未知" }} 次<small
                                    >{{ quota(row, quotaTier).tokens?.toLocaleString() ?? "未知" }} Token</small
                                >
                            </td>
                            <td>{{ Object.values(row.features || {}).some(v => !v) ? "自定义" : "全部开放" }}</td>
                            <td>
                                <input
                                    type="checkbox"
                                    :checked="row.features?.antiTruncation !== false"
                                    :aria-label="`${id(row)} 抗截断准入`"
                                    :disabled="busy"
                                    @change="setFeature(row, 'antiTruncation', $event.target.checked)"
                                />
                            </td>
                            <td>
                                <ElButton size="small" :disabled="busy" @click="edit(row)">详情 / 编辑</ElButton
                                ><ElButton size="small" :disabled="busy" @click="remove(row)">移除</ElButton>
                            </td>
                        </tr>
                        <tr v-if="!paged.length">
                            <td colspan="10">没有匹配的模型</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <ElPagination
                v-model:current-page="page"
                :page-size="pageSize"
                :total="filtered.length"
                layout="total, prev, pager, next"
            />
        </template>
        <ElButton v-else :loading="busy" @click="load">重新加载模型目录</ElButton>
        <ElDrawer v-model="drawer" :title="selected ? id(selected) : '模型详情'" size="min(760px, 96vw)">
            <template v-if="selected">
                <ElTabs v-model="tab">
                    <ElTabPane label="模型数据" name="metadata">
                        <div class="form-grid">
                            <label>模型 ID<ElInput :model-value="id(selected)" disabled /></label>
                            <label>显示名称<ElInput v-model="selected.displayName" :disabled="busy" /></label>
                            <label
                                >描述<ElInput v-model="selected.description" type="textarea" :disabled="busy"
                            /></label>
                            <label
                                >输入 Token 上限（空值为未知）<input
                                    type="number"
                                    min="1"
                                    :value="selected.inputTokenLimit"
                                    :disabled="busy"
                                    @input="setLimit('inputTokenLimit', $event.target.value)"
                            /></label>
                            <label
                                >输出 Token 上限（空值为未知）<input
                                    type="number"
                                    min="1"
                                    :value="selected.outputTokenLimit"
                                    :disabled="busy"
                                    @input="setLimit('outputTokenLimit', $event.target.value)"
                            /></label>
                            <label
                                >生成方法（逗号分隔）<ElInput
                                    :model-value="selected.supportedGenerationMethods?.join(', ') || ''"
                                    :disabled="busy"
                                    @update:model-value="
                                        selected.supportedGenerationMethods = $event
                                            .split(',')
                                            .map(s => s.trim())
                                            .filter(Boolean)
                                    "
                            /></label>
                        </div>
                        <p>
                            目录数据由管理员维护；configs/models.json 为首次载入来源。无需修改代码或重启即可登记新模型。
                        </p>
                    </ElTabPane>
                    <ElTabPane label="功能边界" name="features">
                        <p>缺少覆盖值时默认开放。关闭功能会在请求进入处理链路前拒绝相应调用。</p>
                        <div class="feature-grid">
                            <label v-for="(label, key) in featureLabels" :key="key"
                                ><input
                                    type="checkbox"
                                    :checked="selected.features?.[key] !== false"
                                    :disabled="busy"
                                    @change="setFeature(selected, key, $event.target.checked)"
                                />
                                {{ label }}</label
                            >
                        </div>
                        <ElButton :disabled="busy" @click="selected.features = {}">恢复全部通用功能</ElButton>
                        <p>这里控制项目现有功能的准入。实际输出仍由上游返回；上游失败不会自动修改功能策略。</p>
                        <p v-if="id(selected).startsWith('build/')">
                            Build 当前处理链路仅实现 OpenAI Chat；其他协议需要对应适配器。
                        </p>
                    </ElTabPane>
                    <ElTabPane label="权限与额度" name="quotas">
                        <p>预估仅用于展示，实际限流继续依据上游响应。空值表示未知，0 表示已知额度为零。</p>
                        <div v-for="tier in tiers" :key="tier.id" class="quota-row">
                            <h3>
                                {{ tier.label }}
                                <label
                                    ><input
                                        type="checkbox"
                                        :checked="allowed(selected, tier.id)"
                                        :disabled="busy"
                                        @change="togglePermission(selected, tier.id, $event.target.checked)"
                                    />
                                    允许调用</label
                                >
                            </h3>
                            <p>
                                当前预估：{{ quota(selected, tier.id).requests ?? "未知" }} 次 /
                                {{ quota(selected, tier.id).tokens ?? "未知" }} Token
                            </p>
                            <div class="form-grid">
                                <label
                                    >每日次数<input
                                        type="number"
                                        min="0"
                                        :value="quota(selected, tier.id).requests"
                                        :disabled="busy"
                                        @input="setQuota(tier.id, 'requests', $event.target.value)"
                                /></label>
                                <label
                                    >每日 Token<input
                                        type="number"
                                        min="0"
                                        :value="quota(selected, tier.id).tokens"
                                        :disabled="busy"
                                        @input="setQuota(tier.id, 'tokens', $event.target.value)"
                                /></label>
                                <label
                                    >来源<ElInput
                                        :model-value="quota(selected, tier.id).source || ''"
                                        :disabled="busy"
                                        @update:model-value="setQuota(tier.id, 'source', $event)"
                                /></label>
                                <label
                                    >重置规则备注<ElInput
                                        :model-value="quota(selected, tier.id).resetNote || ''"
                                        placeholder="备注不改变现有太平洋时间计数窗口"
                                        :disabled="busy"
                                        @update:model-value="setQuota(tier.id, 'resetNote', $event)"
                                /></label>
                            </div>
                            <small>覆盖更新时间：{{ selected.quotas?.[tier.id]?.updatedAt || "未覆盖" }}</small>
                            <ElButton
                                size="small"
                                :disabled="busy || !selected.quotas?.[tier.id]"
                                @click="delete selected.quotas[tier.id]"
                                >恢复初始预估</ElButton
                            >
                        </div>
                    </ElTabPane>
                    <ElTabPane label="抗截断" name="anti">
                        <div class="form-grid">
                            <label
                                ><input
                                    type="checkbox"
                                    :checked="selected.features?.antiTruncation !== false"
                                    :disabled="busy"
                                    @change="setFeature(selected, 'antiTruncation', $event.target.checked)"
                                />
                                允许抗截断</label
                            >
                            <label
                                ><input
                                    type="checkbox"
                                    :checked="selected.features?.antiCombinations !== false"
                                    :disabled="busy"
                                    @change="setFeature(selected, 'antiCombinations', $event.target.checked)"
                                />
                                放行工具与输出格式组合</label
                            >
                        </div>
                        <p>
                            新模型默认放行，无需登记代码白名单。关闭组合放行后，使用现有保守组合规则；关闭模型准入后，显式
                            anti 请求报错，默认 prefer 请求使用普通响应。
                        </p>
                        <p>
                            全局开关：{{ antiEnabled ? "已开启" : "已关闭" }}；默认策略：{{
                                antiDefault === "prefer" ? "优先开启" : "按请求开启"
                            }}。抗截断当前由 OpenAI Chat 处理链路实现。
                        </p>
                    </ElTabPane>
                </ElTabs>
                <p>抽屉内修改保留为草稿；请在页面点击“保存全部修改”。</p>
            </template>
        </ElDrawer>
    </section>
</template>
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import {
    ElButton,
    ElDrawer,
    ElInput,
    ElMessageBox,
    ElOption,
    ElPagination,
    ElSelect,
    ElTabPane,
    ElTabs,
} from "element-plus";
import PageHeader from "../components/common/PageHeader.vue";
import { useDraftGuard } from "../composables/useDraftGuard";
const rows = ref([]),
    permissions = ref({ tiers: { free: [], pro: [], ultra: [], ultra20: [] }, version: 1 });
const antiEnabled = ref(true),
    antiDefault = ref("off"),
    version = ref(null),
    estimates = ref({});
const busy = ref(false),
    loaded = ref(false),
    error = ref(""),
    message = ref(""),
    original = ref(null);
const search = ref(""),
    filter = ref("all"),
    page = ref(1),
    pageSize = 15;
const drawer = ref(false),
    selected = ref(null),
    tab = ref("metadata");
const quotaTier = ref("free");
const copyFrom = ref("pro"),
    copyTo = ref("ultra"),
    batchTier = ref("free");
const tiers = [
    { id: "free", label: "Free" },
    { id: "pro", label: "Pro" },
    { id: "ultra", label: "Ultra 5x" },
    { id: "ultra20", label: "Ultra 20x" },
];
const featureLabels = {
    antiCombinations: "抗截断工具与格式组合",
    antiTruncation: "抗截断准入",
    claude: "Claude Messages",
    gemini: "Gemini 原生协议",
    hostedTools: "内置工具组合",
    multimodal: "多模态输入与输出",
    openai: "OpenAI Chat / Embeddings",
    responses: "OpenAI Responses",
    streaming: "流式响应",
    structuredOutput: "结构化输出格式",
    thinking: "思考参数",
    tools: "函数工具调用",
};
const clone = value => JSON.parse(JSON.stringify(value));
const id = row => row.name.replace(/^models\//, "");
const payload = () => ({
    antiDefault: antiDefault.value,
    antiEnabled: antiEnabled.value,
    permissions: permissions.value,
    rows: rows.value,
});
const dirty = computed(() => original.value && JSON.stringify(payload()) !== JSON.stringify(original.value));
const globalChanged = computed(
    () =>
        original.value &&
        (antiEnabled.value !== original.value.antiEnabled || antiDefault.value !== original.value.antiDefault)
);
const allowed = (row, tier) => permissions.value.tiers[tier].includes(id(row));
const changeLabels = computed(() => {
    if (!original.value) return [];
    const before = new Map(original.value.rows.map(row => [row.name, row]));
    const labels = [];
    for (const row of rows.value) {
        const previous = before.get(row.name);
        const permissionChanged = tiers.some(
            t => allowed(row, t.id) !== original.value.permissions.tiers[t.id].includes(id(row))
        );
        if (!previous) labels.push(`新增 ${id(row)}`);
        else if (JSON.stringify(previous) !== JSON.stringify(row) || permissionChanged) labels.push(`修改 ${id(row)}`);
        before.delete(row.name);
    }
    for (const row of before.values()) labels.push(`移除 ${id(row)}`);
    return labels;
});
const changedCount = computed(() => changeLabels.value.length);
const filtered = computed(() =>
    rows.value.filter(row => {
        const match = `${id(row)} ${row.displayName || ""} ${row.description || ""}`
            .toLowerCase()
            .includes(search.value.toLowerCase());
        return (
            match &&
            (filter.value === "all" ||
                (filter.value === "enabled" && row.enabled !== false) ||
                (filter.value === "disabled" && row.enabled === false) ||
                (filter.value === "pending" && !tiers.some(t => allowed(row, t.id))))
        );
    })
);
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
watch([search, filter], () => {
    page.value = 1;
});
watch(
    () => filtered.value.length,
    length => {
        page.value = Math.min(page.value, Math.max(1, Math.ceil(length / pageSize)));
    }
);
useDraftGuard(() => !!dirty.value);
async function api(method = "GET", body) {
    const response = await fetch("/api/model-catalog", {
        headers: { "Content-Type": "application/json" },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.redirected) throw new Error("登录已失效，请重新登录；草稿已保留");
    const result = await response.json();
    if (!response.ok)
        throw new Error(
            response.status === 409
                ? "配置已被其他页面修改。草稿已保留，请复制所需修改后放弃草稿并刷新。"
                : result.error || "请求失败"
        );
    return result;
}
async function load() {
    busy.value = true;
    error.value = "";
    try {
        const result = await api();
        rows.value = result.rows;
        permissions.value = result.permissions;
        antiEnabled.value = result.antiEnabled;
        antiDefault.value = result.antiDefault;
        version.value = result.version;
        estimates.value = result.estimates;
        original.value = clone(payload());
        loaded.value = true;
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
async function save() {
    busy.value = true;
    error.value = "";
    message.value = "";
    try {
        const result = await api("PATCH", { ...payload(), version: version.value });
        version.value = result.version;
        original.value = clone(payload());
        message.value = "模型目录与策略已保存，对新请求生效。";
    } catch (cause) {
        error.value = cause.message;
    } finally {
        busy.value = false;
    }
}
function discard() {
    const value = clone(original.value);
    rows.value = value.rows;
    permissions.value = value.permissions;
    antiEnabled.value = value.antiEnabled;
    antiDefault.value = value.antiDefault;
    drawer.value = false;
    selected.value = null;
    error.value = "";
}
function togglePermission(row, tier, value) {
    permissions.value.tiers[tier] = [
        ...new Set([...permissions.value.tiers[tier].filter(name => name !== id(row)), ...(value ? [id(row)] : [])]),
    ].sort();
}
function setEnabled(value) {
    for (const row of filtered.value) row.enabled = value;
}
function setTier(value) {
    for (const row of filtered.value) togglePermission(row, batchTier.value, value);
}
function setFeature(row, key, value) {
    row.features = { ...row.features, [key]: value };
}
function edit(row) {
    selected.value = row;
    drawer.value = true;
    tab.value = "metadata";
}
function setLimit(key, value) {
    selected.value[key] = value === "" ? null : Number(value);
}
function quota(row, tier) {
    return { ...(estimates.value[row.name]?.[tier] || { requests: null, tokens: null }), ...row.quotas?.[tier] };
}
function setQuota(tier, key, value) {
    const row = selected.value;
    row.quotas ||= {};
    row.quotas[tier] = {
        source: row.quotas[tier]?.source || "administrator",
        ...row.quotas[tier],
        [key]: ["requests", "tokens"].includes(key) ? (value === "" ? null : Number(value)) : value,
        updatedAt: new Date().toISOString(),
    };
}
async function addModel() {
    try {
        const { value } = await ElMessageBox.prompt(
            "输入真实上游模型 ID；Build 通道使用 build/ 前缀。新增模型默认开放通用功能，账号层级权限可在表格中勾选。",
            "添加模型",
            {
                inputErrorMessage: "请输入模型 ID，不含 models/、anti- 或功能后缀",
                inputPattern: /^(?:build\/)?[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,
            }
        );
        const name = `models/${value}`;
        if (rows.value.some(row => row.name === name)) throw new Error("该模型已经存在");
        const row = {
            displayName: value,
            enabled: true,
            features: {},
            name,
            supportedGenerationMethods: ["generateContent"],
        };
        rows.value.push(row);
        search.value = "";
        filter.value = "all";
        edit(row);
    } catch (cause) {
        if (cause instanceof Error) error.value = cause.message;
    }
}
async function remove(row) {
    try {
        await ElMessageBox.confirm(`保存后将从目录移除 ${id(row)}，并清除其账号层级授权。`, "移除模型", {
            type: "warning",
        });
        rows.value = rows.value.filter(item => item !== row);
        for (const tier of tiers) togglePermission(row, tier.id, false);
        if (selected.value === row) {
            drawer.value = false;
            selected.value = null;
        }
    } catch {
        /* User retained the draft. */
    }
}
onMounted(load);
</script>
<style scoped>
.models-page {
    display: grid;
    gap: 18px;
}
.toolbar,
.global-policy {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
}
.toolbar :deep(.el-input) {
    max-width: 320px;
}
.toolbar :deep(.el-select),
.global-policy :deep(.el-select) {
    width: 170px;
}
.global-policy,
.changes {
    padding: 16px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
}
.global-policy label {
    display: flex;
    align-items: center;
    gap: 8px;
}
.table-scroll {
    overflow-x: auto;
}
table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
}
th,
td {
    padding: 14px 10px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
}
small {
    display: block;
    font-weight: 400;
    color: var(--text-secondary);
    margin-top: 6px;
}
.model-link {
    border: 0;
    padding: 0;
    color: var(--color-primary);
    background: transparent;
    font: inherit;
    cursor: pointer;
}
.form-grid {
    display: grid;
    gap: 16px;
    margin: 16px 0;
}
.form-grid label {
    display: grid;
    gap: 6px;
}
.form-grid input[type="number"] {
    padding: 8px;
    color: var(--text-primary);
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 4px;
}
.feature-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    margin: 20px 0;
}
.quota-row {
    border-bottom: 1px solid var(--border-color);
    padding-bottom: 20px;
}
.quota-row h3 label {
    font-size: 14px;
    font-weight: 400;
}
.error {
    color: var(--el-color-danger);
}
</style>
