<template>
    <div class="allowlist-editor">
        <p>未知账号使用 Free 权限。Ultra 两档初始复制 Pro，之后可独立调整。配置允许不代表上游已验证。</p>
        <p>新增模型：先加入 configs/models.json 并重启，再在此选择允许层级并保存。未授权的新模型不会自动开放。</p>
        <div class="allowlist-actions">
            <ElInput v-model="search" placeholder="搜索模型" aria-label="搜索权限模型" :disabled="disabled" />
            <ElSelect v-model="copyFrom" aria-label="复制来源层级" :disabled="disabled">
                <ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="tier.label" />
            </ElSelect>
            <ElSelect v-model="copyTo" aria-label="复制目标层级" :disabled="disabled">
                <ElOption v-for="tier in tiers" :key="tier.id" :value="tier.id" :label="tier.label" />
            </ElSelect>
            <ElButton :disabled="disabled || copyFrom === copyTo" @click="copyTier">复制层级权限</ElButton>
            <ElButton :disabled="disabled || !stale.length" @click="removeStale">清理失效条目</ElButton>
        </div>
        <div class="allowlist-table">
            <table>
                <thead>
                    <tr>
                        <th scope="col">模型 / 状态</th>
                        <th scope="col">
                            是否启用
                            <div>
                                <ElButton
                                    size="small"
                                    :disabled="disabled || !visibilityAvailable"
                                    @click="setEnabledRows(true)"
                                    >全部启用</ElButton
                                >
                                <ElButton
                                    size="small"
                                    :disabled="disabled || !visibilityAvailable"
                                    @click="setEnabledRows(false)"
                                    >全部禁用</ElButton
                                >
                            </div>
                        </th>
                        <th v-for="tier in tiers" :key="tier.id" scope="col">
                            {{ tier.label }}
                            <div>
                                <ElButton size="small" :disabled="disabled" @click="setTier(tier.id, true)"
                                    >全选</ElButton
                                >
                                <ElButton size="small" :disabled="disabled" @click="setTier(tier.id, false)"
                                    >清空</ElButton
                                >
                            </div>
                        </th>
                        <th scope="col">全部层级</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in rows" :key="row.model">
                        <th scope="row">
                            {{ row.model }}
                            <span v-if="!row.registered">（已从目录移除）</span>
                            <span v-else-if="!tiers.some(tier => allowed(tier.id, row.model))">（待授权）</span>
                            <span v-if="!isEnabled(row.model)">（全局隐藏）</span>
                        </th>
                        <td>
                            <input
                                type="checkbox"
                                :checked="isEnabled(row.model)"
                                :aria-label="`${row.model} 是否启用`"
                                :disabled="disabled || !visibilityAvailable || !row.registered"
                                @change="setEnabled(row.model, $event.target.checked)"
                            />
                        </td>
                        <td v-for="tier in tiers" :key="tier.id">
                            <input
                                type="checkbox"
                                :checked="allowed(tier.id, row.model)"
                                :aria-label="`${row.model} ${tier.label}`"
                                :disabled="disabled || !row.registered"
                                @change="setModel(tier.id, row.model, $event.target.checked)"
                            />
                        </td>
                        <td>
                            <input
                                type="checkbox"
                                :checked="tiers.every(tier => allowed(tier.id, row.model))"
                                :aria-label="`${row.model} 全部层级`"
                                :disabled="disabled || !row.registered"
                                @change="setAll(row.model, $event.target.checked)"
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div class="allowlist-actions">
            <ElButton
                type="primary"
                :disabled="disabled || !visibilityAvailable || !pendingVisibility.length"
                @click="applyVisibility"
            >
                应用启用状态（{{ pendingVisibility.length }}）
            </ElButton>
            <ElButton :disabled="disabled || !pendingVisibility.length" @click="visibilityDraft = {}"
                >放弃启用状态修改</ElButton
            >
        </div>
        <p v-if="!visibilityAvailable">启用状态管理需要启用模型调度模式。</p>
        <p>
            “是否启用”与控制台“禁用模型／启用模型”一致，禁用后停止接收该模型的新请求，已发送请求正常完成。全部启用／禁用仅作用于搜索结果，点击“应用启用状态”后生效。
        </p>
        <p v-if="visibilityMessage" role="status">{{ visibilityMessage }}</p>
        <p v-if="visibilityError" role="alert">{{ visibilityError }}</p>
        <p>
            层级全选作用于当前目录的全部模型；清空会移除该层级所有权限。层级权限的勾选、复制和批量操作需点击页面“保存”后生效。
        </p>
    </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { ElButton, ElInput, ElSelect, ElOption } from "element-plus";
const props = defineProps({
    disabled: Boolean,
    hiddenModels: { default: () => [], type: Array },
    models: { required: true, type: Array },
    modelValue: { required: true, type: Object },
    visibilityAvailable: Boolean,
});
const emit = defineEmits(["update:modelValue", "update:hiddenModels", "visibility-busy", "visibility-dirty"]);
const tiers = [
    { id: "free", label: "Free" },
    { id: "pro", label: "Pro" },
    { id: "ultra", label: "Ultra 5x" },
    { id: "ultra20", label: "Ultra 20x" },
];
const search = ref(""),
    copyFrom = ref("pro"),
    copyTo = ref("ultra");
const names = computed(() => [...new Set([...props.models, ...Object.values(props.modelValue.tiers).flat()])].sort());
const stale = computed(() => names.value.filter(model => !props.models.includes(model)));
const rows = computed(() =>
    names.value
        .filter(model => model.toLowerCase().includes(search.value.toLowerCase()))
        .map(model => ({ model, registered: props.models.includes(model) }))
);
const visibilityDraft = ref({}),
    visibilityMessage = ref(""),
    visibilityError = ref("");
const pendingVisibility = computed(() =>
    Object.entries(visibilityDraft.value).filter(
        ([model, enabled]) => props.models.includes(model) && enabled !== !props.hiddenModels.includes(model)
    )
);
watch(
    () => pendingVisibility.value.length > 0,
    dirty => emit("visibility-dirty", dirty),
    { immediate: true }
);
const isEnabled = model =>
    Object.hasOwn(visibilityDraft.value, model) ? visibilityDraft.value[model] : !props.hiddenModels.includes(model);
watch(
    () => props.hiddenModels,
    () => {
        for (const [model, enabled] of Object.entries(visibilityDraft.value)) {
            if (enabled === !props.hiddenModels.includes(model)) delete visibilityDraft.value[model];
        }
    }
);
function setEnabled(model, enabled) {
    visibilityMessage.value = "";
    visibilityError.value = "";
    if (enabled === !props.hiddenModels.includes(model)) delete visibilityDraft.value[model];
    else visibilityDraft.value[model] = enabled;
}
function setEnabledRows(enabled) {
    for (const row of rows.value) if (row.registered) setEnabled(row.model, enabled);
}
async function applyVisibility() {
    if (props.disabled || !props.visibilityAvailable) return;
    const changes = [...pendingVisibility.value];
    if (!changes.length) return;
    emit("visibility-busy", true);
    visibilityMessage.value = "";
    visibilityError.value = "";
    let succeeded = 0;
    const failures = [];
    try {
        for (const [model, enabled] of changes) {
            try {
                const response = await fetch(`/api/scheduler/models/${enabled ? "show" : "hide"}`, {
                    body: JSON.stringify({ model }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                });
                const result = await response.json();
                if (!response.ok || result.success !== true)
                    throw new Error(result.error || `启用状态提交失败（${response.status}）`);
                const hidden = new Set(props.hiddenModels);
                if (enabled) hidden.delete(model);
                else hidden.add(model);
                emit("update:hiddenModels", [...hidden].sort());
                delete visibilityDraft.value[model];
                succeeded++;
            } catch (error) {
                failures.push(`${model}：${error.message}`);
            }
        }
        visibilityMessage.value = `已应用 ${succeeded} 项启用状态。`;
        if (failures.length) visibilityError.value = `以下修改未生效，已保留以便重试：${failures.join("；")}`;
    } finally {
        emit("visibility-busy", false);
    }
}
const allowed = (tier, model) => props.modelValue.tiers[tier].includes(model);
function update(change) {
    const next = JSON.parse(JSON.stringify(props.modelValue));
    change(next.tiers);
    for (const tier of tiers) next.tiers[tier.id] = [...new Set(next.tiers[tier.id])].sort();
    emit("update:modelValue", next);
}
function setModel(tier, model, enabled) {
    update(value => {
        value[tier] = enabled ? [...value[tier], model] : value[tier].filter(name => name !== model);
    });
}
function setAll(model, enabled) {
    update(value => {
        for (const tier of tiers)
            value[tier.id] = enabled ? [...value[tier.id], model] : value[tier.id].filter(name => name !== model);
    });
}
function setTier(tier, enabled) {
    update(value => {
        value[tier] = enabled ? [...value[tier], ...props.models] : [];
    });
}
function copyTier() {
    update(value => {
        value[copyTo.value] = [...value[copyFrom.value]].filter(model => props.models.includes(model));
    });
}
function removeStale() {
    update(value => {
        for (const tier of tiers) value[tier.id] = value[tier.id].filter(model => props.models.includes(model));
    });
}
</script>

<style scoped>
.allowlist-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}
.allowlist-actions .el-input,
.allowlist-actions .el-select {
    width: 180px;
}
.allowlist-table {
    overflow-x: auto;
}
table {
    width: 100%;
    border-collapse: collapse;
}
th,
td {
    border: 1px solid var(--el-border-color);
    padding: 8px;
    text-align: center;
}
tbody th {
    text-align: left;
    overflow-wrap: anywhere;
}
input[type="checkbox"] {
    width: 18px;
    height: 18px;
}
</style>
