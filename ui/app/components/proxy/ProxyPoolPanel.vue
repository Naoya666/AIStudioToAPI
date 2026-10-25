<template>
    <div class="proxy-pool">
        <PageHeader :title="t('adminProxyPool')" :description="t('adminProxyDescription')"
            ><template #actions
                ><el-button @click="loadAll">{{ t("adminRefresh") }}</el-button></template
            ></PageHeader
        >
        <PageState
            v-if="loadError"
            :error="true"
            :message="t('adminRefreshFailed')"
            :retry-label="t('adminRetry')"
            @retry="loadAll"
        />
        <PageState v-else-if="!loaded" :loading="true" :message="t('loading')" />
        <template v-if="loaded">
            <section class="pool-card">
                <div class="section-title">
                    <h3>Mihomo 状态</h3>
                    <el-tag :type="status.mihomo?.ready ? 'success' : 'danger'">{{
                        status.mihomo?.ready ? "就绪" : "未就绪"
                    }}</el-tag>
                </div>
                <div class="status-grid">
                    <span>节点池：{{ status.enabled ? "已启用" : "已停用" }}</span>
                    <span>二进制：{{ status.mihomo?.binaryFound ? "已找到" : "未找到" }}</span>
                    <span>版本：{{ status.mihomo?.version || "-" }}</span>
                    <span>节点 / 当前账号绑定：{{ status.nodeCount || 0 }} / {{ status.bindingCount || 0 }}</span>
                </div>
                <el-alert
                    v-if="status.mihomo?.lastError"
                    :title="status.mihomo.lastError"
                    type="error"
                    :closable="false"
                />
                <div class="actions">
                    <el-button @click="mihomo('start')">启动</el-button
                    ><el-button @click="mihomo('stop')">停止</el-button
                    ><el-button @click="mihomo('reload')">重载</el-button>
                </div>
                <details class="pool-settings">
                    <summary>{{ t("adminProxySettings") }}</summary>
                    <div class="actions">
                        <el-switch v-model="settings.enabled" active-text="启用节点池" />
                        <el-input-number
                            v-model="settings.basePort"
                            :min="1024"
                            :max="65535"
                            controls-position="right"
                        />
                        <span>起始端口</span>
                        <el-input-number v-model="settings.controllerPort" :min="1024" :max="65535" />
                        <span>控制端口</span>
                        <el-input v-model="settings.binaryPath" placeholder="Mihomo 程序路径（留空使用环境配置）" />
                    </div>
                    <div class="actions">
                        <el-input v-model="settings.testUrl" placeholder="节点测试 URL" style="width: 360px" />
                        <el-input
                            v-model="settings.exitIpUrl"
                            clearable
                            placeholder="出口 IP URL（可选）"
                            style="width: 360px"
                        />
                        <el-input-number
                            v-model="settings.healthTimeoutMs"
                            :min="1000"
                            :max="120000"
                            :step="1000"
                            controls-position="right"
                        />
                        <span>超时毫秒</span>
                        <el-button :disabled="settingsConflict" @click="saveSettings">保存节点池设置</el-button>
                    </div>
                    <p v-if="settingsDirty">节点池设置尚未保存，保存后会应用必要的 Mihomo 重载。</p>
                    <p v-if="settingsConflict">配置已被其他页面修改，请放弃草稿并刷新后处理差异。</p>
                    <el-button
                        @click="
                            savedSettings = null;
                            loadAll();
                        "
                        >放弃设置草稿 / 刷新</el-button
                    >
                </details>
            </section>

            <section class="pool-card">
                <div class="section-title">
                    <h3>代理节点</h3>
                    <div>
                        <el-button type="danger" plain :disabled="!selectedNodes.length" @click="deleteSelectedNodes"
                            >删除选中</el-button
                        ><el-button @click="importVisible = true">批量导入</el-button
                        ><el-button type="primary" @click="openNode()">添加节点</el-button>
                    </div>
                </div>
                <el-table
                    ref="nodeTable"
                    class="desktop-list"
                    :data="nodes"
                    empty-text="暂无节点"
                    @selection-change="selectedNodes = $event"
                >
                    <el-table-column type="selection" width="45" />
                    <el-table-column prop="name" label="名称" min-width="130" />
                    <el-table-column prop="egressGroup" label="出口组" min-width="110" />
                    <el-table-column label="类型" width="90">
                        <template #default="{ row }">{{ row.type === "direct" ? "直连" : row.type }}</template>
                    </el-table-column>
                    <el-table-column label="远程地址" min-width="180"
                        ><template #default="{ row }">{{
                            row.type === "direct" ? "VPS 本机出口" : `${row.host}:${row.port}`
                        }}</template></el-table-column
                    >
                    <el-table-column label="本地端口" width="100">
                        <template #default="{ row }">{{
                            row.type === "direct" ? "不经过 Mihomo" : row.localPort
                        }}</template>
                    </el-table-column>
                    <el-table-column label="延迟" width="90">
                        <template #default="{ row }">{{
                            row.latencyMs == null ? "-" : `${row.latencyMs} ms`
                        }}</template>
                    </el-table-column>
                    <el-table-column prop="exitIp" label="出口 IP" min-width="130" />
                    <el-table-column prop="boundAccounts" label="绑定" width="70" />
                    <el-table-column label="状态" width="100"
                        ><template #default="{ row }"
                            ><el-tag :type="row.enabled && row.status !== 'missing' ? 'success' : 'info'">{{
                                row.status === "missing" ? "订阅缺失" : row.enabled ? "启用" : "停用"
                            }}</el-tag></template
                        ></el-table-column
                    >
                    <el-table-column label="操作" width="220"
                        ><template #default="{ row }"
                            ><el-button link :loading="testingNodes.has(row.id)" @click="testNode(row)">测试</el-button
                            ><el-button link @click="openNode(row)">编辑</el-button
                            ><el-button link type="danger" @click="removeNode(row)">删除</el-button></template
                        ></el-table-column
                    >
                </el-table>
                <div class="mobile-list">
                    <p v-if="!nodes.length">暂无节点</p>
                    <article v-for="row in nodes" :key="row.id" class="mobile-item">
                        <el-checkbox
                            :model-value="selectedNodes.some(item => item.id === row.id)"
                            @change="value => nodeTable?.toggleRowSelection(row, value)"
                            >{{ row.name }}</el-checkbox
                        >
                        <p>
                            {{ row.type === "direct" ? "直连" : row.type }} ·
                            {{ row.status === "missing" ? "订阅缺失" : row.enabled ? "启用" : "停用" }} ·
                            {{ row.latencyMs == null ? "-" : `${row.latencyMs} ms` }}
                        </p>
                        <p>
                            出口 IP：{{ row.exitIp || "-" }} · 绑定：{{ row.boundAccounts || 0 }} · 出口组：{{
                                row.egressGroup || "默认"
                            }}
                        </p>
                        <details>
                            <summary>地址和本地端口</summary>
                            <p>
                                {{
                                    row.type === "direct"
                                        ? "VPS 本机出口，不经过 Mihomo"
                                        : `${row.host}:${row.port} / ${row.localPort || "-"}`
                                }}
                            </p>
                        </details>
                        <div class="actions">
                            <el-button :loading="testingNodes.has(row.id)" @click="testNode(row)">测试</el-button
                            ><el-button @click="openNode(row)">编辑</el-button
                            ><el-button type="danger" plain @click="removeNode(row)">删除</el-button>
                        </div>
                    </article>
                </div>
            </section>

            <section class="pool-card">
                <div class="section-title">
                    <h3>订阅（手动刷新）</h3>
                    <div>
                        <el-button
                            type="danger"
                            plain
                            :disabled="!selectedSubscriptions.length"
                            @click="deleteSelectedSubscriptions"
                            >删除选中</el-button
                        >
                        <el-button type="primary" @click="subscriptionVisible = true">添加订阅</el-button>
                    </div>
                </div>
                <el-table
                    ref="subscriptionTable"
                    class="desktop-list"
                    :data="subscriptions"
                    empty-text="暂无订阅"
                    @selection-change="selectedSubscriptions = $event"
                >
                    <el-table-column type="selection" width="45" />
                    <el-table-column prop="name" label="名称" />
                    <el-table-column prop="url" label="地址（已脱敏）" min-width="220" />
                    <el-table-column prop="nodeCount" label="节点" width="70" />
                    <el-table-column prop="lastRefreshedAt" label="最近刷新" min-width="170" />
                    <el-table-column label="操作" width="140"
                        ><template #default="{ row }"
                            ><el-button link @click="refreshSubscription(row)">刷新</el-button
                            ><el-button link type="danger" @click="removeSubscription(row)">删除</el-button></template
                        ></el-table-column
                    >
                </el-table>
                <div class="mobile-list">
                    <p v-if="!subscriptions.length">暂无订阅</p>
                    <article v-for="row in subscriptions" :key="row.id" class="mobile-item">
                        <el-checkbox
                            :model-value="selectedSubscriptions.some(item => item.id === row.id)"
                            @change="value => subscriptionTable?.toggleRowSelection(row, value)"
                            >{{ row.name }}</el-checkbox
                        >
                        <p>地址（已脱敏）：{{ row.url }}</p>
                        <p>节点：{{ row.nodeCount }} · 最近刷新：{{ row.lastRefreshedAt || "-" }}</p>
                        <div class="actions">
                            <el-button @click="refreshSubscription(row)">刷新</el-button
                            ><el-button type="danger" plain @click="removeSubscription(row)">删除</el-button>
                        </div>
                    </article>
                </div>
            </section>

            <section class="pool-card">
                <div class="section-title">
                    <h3>账号出口</h3>
                    <div>
                        <el-button @click="applyIdle">应用空闲账号</el-button
                        ><el-button @click="applyPending">排队应用全部</el-button>
                    </div>
                </div>
                <div class="actions">
                    <el-input v-model="accountSearch" clearable placeholder="搜索账号" style="width: 220px" />
                    <el-select v-model="stateFilter" clearable placeholder="全部状态" style="width: 140px">
                        <el-option v-for="state in bindingStates" :key="state" :label="state" :value="state" />
                    </el-select>
                    <el-select v-model="nodeFilter" clearable placeholder="全部出口组" style="width: 180px">
                        <el-option label="未绑定" value="__unbound__" />
                        <el-option v-for="node in nodes" :key="node.id" :label="node.name" :value="node.id" />
                    </el-select>
                    <el-select v-model="batchNodeId" clearable placeholder="批量绑定节点" style="width: 180px">
                        <el-option v-for="node in usableNodes" :key="node.id" :label="node.name" :value="node.id" />
                    </el-select>
                    <el-button :disabled="!selectedBindings.length" @click="saveBatchBinding">保存选中绑定</el-button>
                </div>
                <p>未登录账号可先保存出口绑定，首次登录及后续请求会沿用该节点，无需点击「应用」。</p>
                <el-table
                    ref="bindingTable"
                    class="desktop-list"
                    :data="pagedBindings"
                    empty-text="暂无账号"
                    @selection-change="selectedBindings = $event"
                >
                    <el-table-column type="selection" width="45" />
                    <el-table-column label="#" width="85"
                        ><template #default="{ row }">{{ row.authIndex === null ? "未登录" : row.authIndex }}</template>
                    </el-table-column>
                    <el-table-column prop="accountName" label="账号" min-width="180" />
                    <el-table-column prop="proxySource" label="当前来源" width="145" />
                    <el-table-column label="期望节点" min-width="170"
                        ><template #default="{ row }"
                            ><el-select
                                v-model="row.desiredNodeId"
                                clearable
                                placeholder="未绑定"
                                @change="saveBinding(row)"
                                ><el-option
                                    v-for="node in usableNodes"
                                    :key="node.id"
                                    :label="node.name"
                                    :value="node.id" /></el-select></template
                    ></el-table-column>
                    <el-table-column label="出口组覆盖" min-width="170">
                        <template #default="{ row }">
                            <el-input
                                v-model="row.egressGroup"
                                maxlength="80"
                                placeholder="可选，覆盖节点默认组"
                                @change="saveBinding(row)"
                            />
                        </template>
                    </el-table-column>
                    <el-table-column label="状态" width="110"
                        ><template #default="{ row }"
                            ><el-tag :type="stateType(row.state)">{{ row.state }}</el-tag></template
                        ></el-table-column
                    >
                    <el-table-column prop="inflight" label="在途" width="70" />
                    <el-table-column label="操作" width="90"
                        ><template #default="{ row }"
                            ><el-button
                                link
                                :disabled="row.authIndex === null || row.state === 'applied'"
                                @click="applyOne(row)"
                                >应用</el-button
                            ></template
                        ></el-table-column
                    >
                </el-table>
                <div class="mobile-list">
                    <p v-if="!pagedBindings.length">暂无账号</p>
                    <article v-for="row in pagedBindings" :key="row.accountKey" class="mobile-item">
                        <el-checkbox
                            :model-value="selectedBindings.some(item => item.accountKey === row.accountKey)"
                            @change="value => bindingTable?.toggleRowSelection(row, value)"
                            >{{ row.accountName }}</el-checkbox
                        >
                        <p>
                            {{ row.authIndex === null ? "未登录" : `#${row.authIndex}` }} · 当前来源：{{
                                row.proxySource || "-"
                            }}
                        </p>
                        <p>状态：{{ row.state }} · 在途：{{ row.inflight || 0 }}</p>
                        <label
                            >期望节点<el-select v-model="row.desiredNodeId" clearable placeholder="未绑定"
                                ><el-option
                                    v-for="node in usableNodes"
                                    :key="node.id"
                                    :label="node.name"
                                    :value="node.id" /></el-select
                        ></label>
                        <label
                            >出口组覆盖<el-input
                                v-model="row.egressGroup"
                                maxlength="80"
                                placeholder="可选，覆盖节点默认组"
                        /></label>
                        <div class="actions">
                            <el-button @click="saveBinding(row)">保存绑定</el-button
                            ><el-button
                                :disabled="row.authIndex === null || row.state === 'applied'"
                                @click="applyOne(row)"
                                >应用</el-button
                            >
                        </div>
                    </article>
                </div>
                <el-pagination
                    v-model:current-page="accountPage"
                    v-model:page-size="accountPageSize"
                    class="pagination desktop-list"
                    layout="total, sizes, prev, pager, next"
                    :page-sizes="[20, 50, 100]"
                    :total="filteredBindings.length"
                />
                <div class="mobile-list mobile-pagination">
                    <span>共 {{ filteredBindings.length }} 个账号</span>
                    <el-select v-model="accountPageSize" aria-label="每页账号数"
                        ><el-option v-for="size in [20, 50, 100]" :key="size" :label="`每页 ${size} 条`" :value="size"
                    /></el-select>
                    <div class="actions">
                        <el-button :disabled="accountPage <= 1" @click="accountPage--">上一页</el-button
                        ><span
                            >{{ accountPage }} /
                            {{ Math.max(1, Math.ceil(filteredBindings.length / accountPageSize)) }}</span
                        ><el-button
                            :disabled="accountPage * accountPageSize >= filteredBindings.length"
                            @click="accountPage++"
                            >下一页</el-button
                        >
                    </div>
                </div>
            </section>

            <el-dialog
                v-model="nodeVisible"
                :title="editingId ? '编辑节点' : '添加节点'"
                width="min(520px, calc(100vw - 24px))"
                class="proxy-dialog"
            >
                <el-form label-position="top">
                    <el-form-item label="类型"
                        ><el-select v-model="nodeForm.type"
                            ><el-option
                                v-for="type in ['direct', 'ss', 'socks5', 'trojan', 'vless', 'vmess']"
                                :key="type"
                                :label="type === 'direct' ? '直连（VPS 出口）' : type"
                                :value="type" /></el-select
                    ></el-form-item>
                    <el-form-item label="名称"><el-input v-model="nodeForm.name" /></el-form-item>
                    <el-alert
                        v-if="nodeForm.type === 'direct'"
                        title="直连节点使用 VPS 自身出口，不启动 Mihomo listener，也不继承环境代理。"
                        type="info"
                        :closable="false"
                    />
                    <el-form-item v-if="nodeForm.type !== 'direct'" label="主机"
                        ><el-input v-model="nodeForm.host"
                    /></el-form-item>
                    <el-form-item v-if="nodeForm.type !== 'direct'" label="端口"
                        ><el-input-number v-model="nodeForm.port" :min="1" :max="65535"
                    /></el-form-item>
                    <el-form-item v-if="nodeForm.type === 'ss'" label="加密"
                        ><el-input v-model="nodeForm.cipher"
                    /></el-form-item>
                    <el-form-item v-if="nodeForm.type === 'socks5'" label="用户名"
                        ><el-input v-model="nodeForm.username"
                    /></el-form-item>
                    <el-form-item v-if="['vless', 'vmess'].includes(nodeForm.type)" label="UUID"
                        ><el-input v-model="nodeForm.uuid"
                    /></el-form-item>
                    <el-form-item v-if="!['direct', 'vless', 'vmess'].includes(nodeForm.type)" label="密码"
                        ><el-input
                            v-model="nodeForm.password"
                            show-password
                            :placeholder="editingId ? '留空保留原密码' : ''"
                    /></el-form-item>
                    <el-form-item v-if="nodeForm.type !== 'direct'" label="出口组">
                        <el-input
                            v-model="nodeForm.egressGroup"
                            maxlength="80"
                            placeholder="可选，同公网出口填写相同组名"
                        />
                    </el-form-item>
                    <p>出口组修改需对账号应用后生效；直连统一归组。分组不会改变代理连接。</p>
                    <el-form-item label="启用"><el-switch v-model="nodeForm.enabled" /></el-form-item>
                </el-form>
                <template #footer
                    ><el-button @click="nodeVisible = false">取消</el-button
                    ><el-button type="primary" @click="saveNode">保存</el-button></template
                >
            </el-dialog>

            <el-dialog
                v-model="importVisible"
                title="批量导入分享链接 / Clash / Base64"
                width="min(650px, calc(100vw - 24px))"
                class="proxy-dialog"
            >
                <el-radio-group v-model="importFormat"
                    ><el-radio-button value="links">分享链接</el-radio-button
                    ><el-radio-button value="subscription">Clash / Base64</el-radio-button></el-radio-group
                >
                <el-input
                    v-model="importText"
                    type="textarea"
                    :rows="10"
                    placeholder="粘贴订阅内容，或每行一个分享链接"
                />
                <template #footer
                    ><el-button @click="previewImport">预览</el-button
                    ><el-button type="primary" @click="commitImport">导入</el-button></template
                >
            </el-dialog>

            <el-dialog
                v-model="subscriptionVisible"
                title="添加订阅"
                width="min(520px, calc(100vw - 24px))"
                class="proxy-dialog"
            >
                <el-input v-model="subscriptionForm.name" placeholder="名称" /><el-input
                    v-model="subscriptionForm.url"
                    placeholder="https://..."
                />
                <template #footer
                    ><el-button @click="subscriptionVisible = false">取消</el-button
                    ><el-button type="primary" @click="addSubscription">保存</el-button></template
                >
            </el-dialog>
        </template>
    </div>
</template>

<script setup>
import PageHeader from "../common/PageHeader.vue";
import PageState from "../common/PageState.vue";
import { useI18n } from "../../composables/useI18n";
const { t } = useI18n();
const loaded = ref(false),
    loadError = ref(false);
import { useDraftGuard } from "../../composables/useDraftGuard";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";

const nodeTable = ref(null),
    subscriptionTable = ref(null),
    bindingTable = ref(null);
const status = reactive({ mihomo: {} });
const settings = reactive({
    basePort: 10801,
    binaryPath: "",
    controllerPort: 19090,
    enabled: false,
    exitIpUrl: "",
    healthTimeoutMs: 5000,
    testUrl: "https://www.google.com/generate_204",
});
const savedSettings = ref(null);
const settingsConflict = ref(false);
const settingsDirty = computed(
    () => savedSettings.value && Object.keys(settings).some(key => settings[key] !== savedSettings.value[key])
);
const nodes = ref([]);
const bindings = ref([]);
const subscriptions = ref([]);
const nodeVisible = ref(false);
const importVisible = ref(false);
const subscriptionVisible = ref(false);
const editingId = ref(null);
const importText = ref("");
const importFormat = ref("links");
const nodeForm = reactive({
    cipher: "aes-256-gcm",
    egressGroup: "",
    enabled: true,
    host: "",
    name: "",
    password: "",
    port: 443,
    type: "ss",
    username: "",
    uuid: "",
});
const subscriptionForm = reactive({ name: "", url: "" });
const accountPage = ref(1);
const accountPageSize = ref(20);
const accountSearch = ref("");
const batchNodeId = ref("");
const bindingStates = ["unbound", "pending", "applied", "offline", "draining", "rebuilding", "error"];
const nodeFilter = ref("");
const selectedBindings = ref([]);
const selectedNodes = ref([]);
const selectedSubscriptions = ref([]);
const stateFilter = ref("");
const usableNodes = computed(() => nodes.value.filter(node => node.enabled && node.status !== "missing"));
const filteredBindings = computed(() => {
    const query = accountSearch.value.trim().toLowerCase();
    return bindings.value.filter(
        item =>
            (!query || item.accountName.toLowerCase().includes(query) || item.accountKey.includes(query)) &&
            (!stateFilter.value || item.state === stateFilter.value) &&
            (!nodeFilter.value ||
                (nodeFilter.value === "__unbound__" ? !item.desiredNodeId : item.desiredNodeId === nodeFilter.value))
    );
});
const pagedBindings = computed(() => {
    const start = (accountPage.value - 1) * accountPageSize.value;
    return filteredBindings.value.slice(start, start + accountPageSize.value);
});
watch([accountSearch, stateFilter, nodeFilter, accountPageSize], () => {
    accountPage.value = 1;
});
watch(
    () => filteredBindings.value.length,
    total => {
        accountPage.value = Math.min(accountPage.value, Math.max(1, Math.ceil(total / accountPageSize.value)));
    }
);
const request = async (url, options = {}) => {
    const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    return body;
};
const loadAll = async () => {
    try {
        const [s, cfg, n, b, sub] = await Promise.all([
            request("/api/proxy-pool/status"),
            request("/api/proxy-pool/settings"),
            request("/api/proxy-pool/nodes"),
            request("/api/proxy-pool/bindings"),
            request("/api/proxy-pool/subscriptions"),
        ]);
        loaded.value = true;
        loadError.value = false;
        Object.assign(status, s);
        if (!settingsDirty.value) {
            Object.assign(settings, cfg);
            savedSettings.value = { ...cfg };
            settingsConflict.value = false;
        } else if (savedSettings.value.revision !== cfg.revision) settingsConflict.value = true;
        nodes.value = n.nodes;
        bindings.value = b.bindings;
        subscriptions.value = sub.subscriptions;
    } catch (error) {
        loadError.value = true;
        ElMessage.error(error.message);
    }
};
const saveSettings = async () => {
    try {
        const changes = Object.fromEntries(
            Object.keys(settings)
                .filter(key => !savedSettings.value || settings[key] !== savedSettings.value[key])
                .map(key => [key, settings[key]])
        );
        const saved = await request("/api/proxy-pool/settings", {
            body: JSON.stringify({ ...changes, revision: savedSettings.value?.revision }),
            method: "PUT",
        });
        Object.assign(settings, saved);
        savedSettings.value = { ...saved };
        await loadAll();
        ElMessage.success("节点池设置已保存并应用，必要时已重载 Mihomo。");
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const mihomo = async action => {
    try {
        await request(`/api/proxy-pool/mihomo/${action}`, { method: "POST" });
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const openNode = row => {
    editingId.value = row?.id || null;
    Object.assign(
        nodeForm,
        {
            cipher: "aes-256-gcm",
            egressGroup: "",
            enabled: true,
            host: "",
            name: "",
            password: "",
            port: 443,
            type: "ss",
            username: "",
            uuid: "",
        },
        row || {},
        { password: "" }
    );
    nodeVisible.value = true;
};
const saveNode = async () => {
    try {
        await request(editingId.value ? `/api/proxy-pool/nodes/${editingId.value}` : "/api/proxy-pool/nodes", {
            body: JSON.stringify(nodeForm),
            method: editingId.value ? "PUT" : "POST",
        });
        nodeVisible.value = false;
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const removeNode = async row => {
    try {
        await ElMessageBox.confirm(`删除节点 ${row.name}？当前绑定 ${row.boundAccounts} 个账号。`, "影响确认", {
            type: "warning",
        });
        await request(`/api/proxy-pool/nodes/${row.id}`, { method: "DELETE" });
        await loadAll();
    } catch (error) {
        if (error !== "cancel") ElMessage.error(error.message);
    }
};
const deleteSelectedNodes = async () => {
    try {
        const boundCount = selectedNodes.value.reduce((sum, node) => sum + (node.boundAccounts || 0), 0);
        await ElMessageBox.confirm(
            `删除选中的 ${selectedNodes.value.length} 个节点？其中绑定账号数为 ${boundCount}，被使用的节点将拒绝整批删除。`,
            "批量删除节点",
            { type: "warning" }
        );
        const result = await request("/api/proxy-pool/nodes/delete", {
            body: JSON.stringify({ ids: selectedNodes.value.map(node => node.id) }),
            method: "POST",
        });
        ElMessage.success(`已删除 ${result.deleted} 个节点`);
        await loadAll();
    } catch (error) {
        if (error !== "cancel") ElMessage.error(error.message);
    }
};
const testingNodes = reactive(new Set());
const testNode = async row => {
    if (testingNodes.has(row.id)) return;
    testingNodes.add(row.id);
    try {
        const result = await request(`/api/proxy-pool/nodes/${row.id}/test`, { method: "POST" });
        Object.assign(nodes.value.find(node => node.id === row.id) || row, result);
        ElMessage.success(`延迟 ${result.latencyMs} ms`);
    } catch (error) {
        Object.assign(nodes.value.find(node => node.id === row.id) || row, { exitIp: null, latencyMs: null });
        ElMessage.error(error.message);
    } finally {
        testingNodes.delete(row.id);
    }
};
const doImport = preview =>
    request("/api/proxy-pool/nodes/import", {
        body: JSON.stringify({ format: importFormat.value, preview, text: importText.value }),
        method: "POST",
    });
const previewImport = async () => {
    try {
        const result = await doImport(true);
        ElMessage.info(`解析成功 ${result.nodes.length}，失败 ${result.errors.length}`);
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const commitImport = async () => {
    try {
        const result = await doImport(false);
        ElMessage.success(`已导入 ${result.added.length}，跳过 ${result.skipped}`);
        importVisible.value = false;
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const saveBinding = async row => {
    try {
        await request(`/api/proxy-pool/bindings/${encodeURIComponent(row.accountKey)}`, {
            body: JSON.stringify({ desiredNodeId: row.desiredNodeId || null, egressGroup: row.egressGroup || "" }),
            method: "PUT",
        });
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const saveBatchBinding = async () => {
    try {
        await request("/api/proxy-pool/bindings/batch", {
            body: JSON.stringify({
                bindings: selectedBindings.value.map(item => ({
                    accountKey: item.accountKey,
                    desiredNodeId: batchNodeId.value || null,
                })),
            }),
            method: "POST",
        });
        ElMessage.success(`已保存 ${selectedBindings.value.length} 个账号绑定`);
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const applyOne = async row => {
    try {
        await request(`/api/proxy-pool/bindings/${encodeURIComponent(row.accountKey)}/apply`, { method: "POST" });
        ElMessage.success("已加入安全排空队列");
        setTimeout(loadAll, 1000);
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const applyIdle = async () => {
    await request("/api/proxy-pool/bindings/apply-idle", { method: "POST" });
    ElMessage.success("已处理空闲账号");
    setTimeout(loadAll, 1000);
};
const applyPending = async () => {
    try {
        await ElMessageBox.confirm("待应用账号将在请求排空后重建 Context，期间暂不可调度。", "影响确认", {
            type: "warning",
        });
        await request("/api/proxy-pool/bindings/apply-pending", { method: "POST" });
        ElMessage.success("已加入排空队列");
    } catch (error) {
        if (error !== "cancel") ElMessage.error(error.message);
    }
};
const addSubscription = async () => {
    try {
        await request("/api/proxy-pool/subscriptions", { body: JSON.stringify(subscriptionForm), method: "POST" });
        subscriptionVisible.value = false;
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const refreshSubscription = async row => {
    try {
        const result = await request(`/api/proxy-pool/subscriptions/${row.id}/refresh`, { method: "POST" });
        ElMessage.success(`刷新完成：${result.nodeCount} 个节点`);
        await loadAll();
    } catch (error) {
        ElMessage.error(error.message);
    }
};
const removeSubscription = async row => {
    await deleteSubscriptions([row]);
};
const deleteSelectedSubscriptions = async () => deleteSubscriptions(selectedSubscriptions.value);
const deleteSubscriptions = async selected => {
    try {
        const nodeCount = selected.reduce((sum, subscription) => sum + (subscription.nodeCount || 0), 0);
        await ElMessageBox.confirm(
            `删除选中的 ${selected.length} 个订阅及其 ${nodeCount} 个节点？存在账号绑定或运行中 Context 时将拒绝整批删除。`,
            "批量删除订阅",
            { type: "warning" }
        );
        const result = await request("/api/proxy-pool/subscriptions/delete", {
            body: JSON.stringify({ ids: selected.map(subscription => subscription.id) }),
            method: "POST",
        });
        ElMessage.success(`已删除 ${result.deletedSubscriptions} 个订阅和 ${result.deletedNodes} 个节点`);
        await loadAll();
    } catch (error) {
        if (error !== "cancel") ElMessage.error(error.message);
    }
};
const stateType = state =>
    ({ applied: "success", draining: "warning", error: "danger", pending: "warning", rebuilding: "warning" })[state] ||
    "info";
onMounted(loadAll);

useDraftGuard(() => settingsDirty.value);
</script>

<style scoped lang="less">
.proxy-pool {
    display: grid;
    gap: 18px;
    min-width: 0;
    container-type: inline-size;
    overflow-wrap: anywhere;
}
.page-header,
.section-title,
.actions,
.status-grid {
    display: flex;
    align-items: center;
    gap: 12px;
}
.page-header,
.section-title {
    justify-content: space-between;
}
.pool-card {
    padding: 20px;
    min-width: 0;
    border: 1px solid var(--el-border-color-light);
    border-radius: 10px;
    background: var(--el-bg-color);
}
.status-grid {
    flex-wrap: wrap;
    margin: 12px 0;
    gap: 14px 30px;
}
.actions {
    flex-wrap: wrap;
    margin-top: 14px;
}
.el-textarea,
.el-dialog .el-input {
    margin-top: 14px;
}
.pagination {
    justify-content: flex-end;
    margin-top: 14px;
}
.mobile-list {
    display: none;
}
.mobile-item {
    padding: 12px 0;
    border-bottom: 1px solid var(--el-border-color-light);
}
@container (max-width: 767px) {
    .desktop-list {
        display: none;
    }
    .mobile-list {
        display: grid;
        gap: 12px;
        min-width: 0;
    }
    .pool-card {
        padding: 12px;
    }
    .section-title {
        align-items: flex-start;
        flex-wrap: wrap;
    }
    .section-title > div {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
    }
    .status-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: start;
        gap: 10px;
    }
    .actions {
        gap: 8px;
    }
    .actions :deep(.el-input),
    .actions :deep(.el-select),
    .mobile-item :deep(.el-select) {
        width: 100% !important;
        min-width: 0;
    }
    :deep(.el-button) {
        min-height: 44px;
        margin-left: 0;
        white-space: normal;
    }
    :deep(.el-input__wrapper),
    :deep(.el-select__wrapper) {
        min-height: 44px;
        box-sizing: border-box;
    }
    :deep(.el-checkbox) {
        height: auto;
        min-height: 44px;
        max-width: 100%;
    }
    :deep(.el-checkbox__label) {
        white-space: normal;
        overflow-wrap: anywhere;
    }
    summary {
        min-height: 44px;
        display: flex;
        align-items: center;
        cursor: pointer;
    }
}
:global(.proxy-dialog) {
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    margin: 12px auto;
    overflow-wrap: anywhere;
}
:global(.proxy-dialog .el-select) {
    width: 100%;
}
@media (max-width: 767px) {
    :global(.proxy-dialog .el-button) {
        min-height: 44px;
    }
    :global(.proxy-dialog .el-input__wrapper),
    :global(.proxy-dialog .el-select__wrapper) {
        min-height: 44px;
        box-sizing: border-box;
    }
}
:global(.proxy-dialog .el-dialog__footer) {
    position: sticky;
    bottom: -16px;
    background: var(--el-bg-color);
}
h1,
h3 {
    margin: 0;
}
</style>
