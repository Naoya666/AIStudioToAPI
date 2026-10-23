<template>
    <section v-if="data" class="status-card scheduler-status">
        <!-- 1. Header & Load Capacity Bar -->
        <div class="scheduler-header">
            <div class="header-title-wrap">
                <div class="header-main-title">
                    <span class="status-pulse-dot"></span>
                    <h3>{{ t("schedulerTitle") }}</h3>
                </div>
                <p class="header-sub">
                    {{ t("schedulerWorkers") }}: <strong class="font-mono">{{ data.active_workers }}</strong> /
                    {{ totalCapacity }} · {{ t("schedulerQueued") }}:
                    <strong class="font-mono" :class="{ 'text-warning': data.queued_requests > 0 }">{{
                        data.queued_requests
                    }}</strong>
                </p>
            </div>

            <!-- Health & Capacity Meter Chips -->
            <div class="header-chips">
                <div class="metric-meter-chip">
                    <span class="meter-label">{{ t("schedulerWorkers") }}:</span>
                    <span class="font-mono meter-val">{{ data.active_workers }} / {{ totalCapacity }}</span>
                    <div class="mini-progress-track">
                        <div class="mini-progress-fill" :style="{ width: slotUsagePercent + '%' }"></div>
                    </div>
                </div>

                <div
                    class="health-chip"
                    :class="totalErrors === 0 ? 'health-chip-ok' : 'health-chip-warn'"
                    :title="errorMetricsHint"
                >
                    <svg
                        v-if="totalErrors === 0"
                        class="chip-icon"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                    </svg>
                    <svg v-else class="chip-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        ></path>
                    </svg>
                    <span>{{ totalErrors === 0 ? t("schedulerLinkHealthy") : `${totalErrors} 项链路异常` }}</span>
                </div>
            </div>
        </div>

        <p v-if="data.contexts_summary" class="header-sub" :title="t('schedulerPoolTargetTip')">
            {{
                t("schedulerPoolTarget", {
                    configured: data.contexts_summary.configured_min_ready ?? 0,
                    effective: data.contexts_summary.effective_warm_target ?? 0,
                    ready: data.contexts_summary.ready ?? 0,
                    draining: data.contexts_summary.draining ?? 0,
                    exhausted: data.contexts_summary.quota_exhausted_accounts ?? 0,
                })
            }}
        </p>
        <p v-if="data.contexts_summary?.all_visible_models_rate_limited" class="scheduler-empty">
            {{ t("schedulerPoolExhausted") }}
        </p>
        <p v-if="data.contexts_summary?.next_cooldown_check_at" class="header-sub">
            {{
                t("schedulerPoolNextCheck", {
                    time: new Date(data.contexts_summary.next_cooldown_check_at).toLocaleString(),
                })
            }}
        </p>

        <!-- 2. Quota Section -->
        <div class="quota-section" :title="t('schedulerEstimatedQuotaTooltip')">
            <div class="quota-header">
                <div class="quota-title-row">
                    <svg class="quota-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                        ></path>
                    </svg>
                    <strong>{{ t("schedulerEstimatedQuota") }}</strong>
                    <span v-if="data.usage_window?.date" class="date-badge">{{ data.usage_window.date }} PT</span>
                </div>
                <span class="quota-hint">{{ t("schedulerEstimatedQuotaHint") }}</span>
            </div>

            <p v-if="!data.quota_by_model?.length" class="scheduler-empty">
                {{ t("schedulerNoVisibleQuota") }}
            </p>

            <div v-else class="quota-grid">
                <div
                    v-for="quota in data.quota_by_model"
                    :key="quota.model"
                    class="quota-card"
                    :class="{ 'quota-card-alert': getQuotaPercent(quota) <= 10 }"
                >
                    <div class="quota-card-top">
                        <div class="model-info">
                            <span class="model-type-tag" :class="getModelTagClass(quota.model)">
                                {{ getModelTagLabel(quota.model) }}
                            </span>
                            <span class="quota-model-name" :title="quota.model">{{ quota.model }}</span>
                        </div>
                        <div class="quota-card-val">
                            <span class="quota-number">{{ formatNumber(quota.estimated_remaining_quota) }}</span>
                            <small class="quota-unit">{{ t("schedulerQuotaUnit") }}</small>
                            <div v-if="getQuotaPercent(quota) <= 10" class="quota-warning-text">
                                仅剩 {{ getQuotaPercent(quota) }}% (告警)
                            </div>
                            <div v-else class="quota-percent-text">剩余 {{ getQuotaPercent(quota) }}%</div>
                        </div>
                    </div>

                    <!-- Visual Quota Remaining Progress Bar -->
                    <div class="quota-progress-track">
                        <div
                            class="quota-progress-bar"
                            :class="getQuotaPercent(quota) <= 10 ? 'bar-alert' : 'bar-normal'"
                            :style="{ width: getQuotaPercent(quota) + '%' }"
                        ></div>
                    </div>

                    <div class="quota-card-footer">
                        <span
                            >{{ t("schedulerQuotaTotal") }}
                            {{ quota.total_quota ?? quota.tracked_accounts * quota.quota_per_account }}</span
                        >
                        <span
                            >{{ t("schedulerTodayRequests") }}
                            <strong>{{ formatNumber(quota.daily_requests) }}</strong></span
                        >
                    </div>
                </div>
            </div>
        </div>

        <!-- 3. Action Toolbar & Excluded Models Popover -->
        <div class="scheduler-actions">
            <div class="action-buttons-group">
                <button class="btn btn-primary" :disabled="busy" @click="resetAllRateLimits">
                    <svg class="btn-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        ></path>
                    </svg>
                    {{ t("schedulerResetAll429") }}
                </button>

                <button class="btn btn-default" :disabled="busy" @click="resetAllAccounts">
                    {{ t("schedulerResetAllAccounts") }}
                </button>

                <!-- Hidden Models Popover -->
                <div class="popover-wrapper" @click.stop>
                    <button
                        class="btn btn-dashed"
                        :class="{ active: hiddenModelsOpen }"
                        @click="toggleHiddenModelsPopover"
                    >
                        <svg class="btn-icon text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"
                            ></path>
                        </svg>
                        <span>{{ t("schedulerHiddenModels", { count: hiddenModels.length }) }}</span>
                    </button>

                    <div v-if="hiddenModelsOpen" class="hidden-models-popover">
                        <div class="popover-head">
                            <span class="popover-title">已从面板移除的模型 ({{ hiddenModels.length }})</span>
                            <button class="popover-close-btn" @click="hiddenModelsOpen = false">×</button>
                        </div>
                        <p class="popover-tip">{{ t("schedulerHiddenModelsTip") }}</p>
                        <p v-if="hiddenModelsLoading" class="popover-loading">
                            {{ t("schedulerHiddenModelsLoading") }}
                        </p>
                        <p v-else-if="!hiddenModels.length" class="scheduler-empty">
                            {{ t("schedulerNoHiddenModels") }}
                        </p>
                        <ul v-else class="popover-list">
                            <li v-for="model in hiddenModels" :key="model" class="popover-item">
                                <span class="popover-model-name" :title="model">{{ model }}</span>
                                <button
                                    class="btn-text-action"
                                    :disabled="busy || operatingModel === model"
                                    @click="setModelVisibility(model, false)"
                                >
                                    {{ t("schedulerShowModel") }}
                                </button>
                            </li>
                        </ul>
                    </div>
                </div>
            </div>

            <div v-if="data.metrics" class="error-metrics-strip">
                <span
                    >{{ t("schedulerLocalTransport") }}: <b>{{ data.metrics.local_transport }}</b></span
                >
                <span>·</span>
                <span
                    >{{ t("schedulerDispatchTimeout") }}: <b>{{ data.metrics.dispatch_timeout }}</b></span
                >
                <span>·</span>
                <span
                    >{{ t("schedulerUpstreamErrors") }}: <b>{{ data.metrics.upstream_error }}</b></span
                >
            </div>
        </div>

        <!-- Alert messages -->
        <div v-if="rateLimitsReset" class="alert-box alert-success" role="status">
            {{ t("schedulerResetAll429Success") }}
        </div>
        <div v-if="allAccountsResetMessage" class="alert-box alert-success" role="status">
            {{ allAccountsResetMessage }}
        </div>
        <div v-if="modelVisibilityMessage" class="alert-box alert-info" role="status">
            {{ modelVisibilityMessage }}
        </div>
        <div v-if="accountActionMessage" class="alert-box alert-info" role="status">
            {{ accountActionMessage }}
        </div>

        <!-- 4. Context Browser Pool Section (Expandable 1) -->
        <div class="collapsible-card context-pool-card">
            <div class="collapsible-header" @click="toggleContexts">
                <div class="header-left">
                    <svg
                        class="chevron-icon"
                        :class="{ rotated: contextsOpen }"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                    <strong>Context 浏览器池详情</strong>
                    <span class="capacity-pill font-mono">
                        {{ contextOccupied }} / {{ contextSummary.max || 0 }}
                        {{ t("contextCapacityInUse") }}
                    </span>
                </div>

                <div class="header-pills">
                    <span class="status-pill pill-busy">
                        <span class="dot dot-busy"></span> {{ t("contextBusy") }} {{ contextSummary.busy || 0 }}
                    </span>
                    <span class="status-pill pill-ready">
                        <span class="dot dot-ready"></span> {{ t("contextReady") }} {{ contextSummary.ready || 0 }}
                    </span>
                    <span v-if="(contextSummary.draining || 0) > 0" class="status-pill pill-draining">
                        <span class="dot dot-draining"></span> {{ t("contextDraining") }}
                        {{ contextSummary.draining }}
                    </span>
                    <span v-if="(contextSummary.closing || 0) > 0" class="status-pill pill-closing">
                        <span class="dot dot-closing"></span> {{ t("contextClosing") }}
                        {{ contextSummary.closing }}
                    </span>
                    <span v-if="(contextSummary.initializing || 0) > 0" class="status-pill pill-init">
                        <span class="dot dot-init"></span> {{ t("contextInitializing") }}
                        {{ contextSummary.initializing }}
                    </span>
                    <span v-if="(contextSummary.reconnecting || 0) > 0" class="status-pill pill-reconnecting">
                        <span class="dot dot-reconnecting"></span> {{ t("contextReconnecting") }}
                        {{ contextSummary.reconnecting }}
                    </span>
                    <span v-if="(contextSummary.unavailable || 0) > 0" class="status-pill pill-error">
                        <span class="dot dot-error"></span> {{ t("contextUnavailable") }}
                        {{ contextSummary.unavailable }}
                    </span>
                    <span class="toggle-text">
                        {{ contextsOpen ? t("schedulerCollapseInstanceMatrix") : t("schedulerExpandInstanceMatrix") }}
                    </span>
                </div>
            </div>

            <!-- Stacked Capacity Visual Bar -->
            <div class="context-slot-bar-wrap">
                <div class="context-slot-bar">
                    <div
                        class="slot-fill slot-busy"
                        :style="{ width: getContextRatio(contextSummary.busy) + '%' }"
                        :title="`${t('contextBusy')} ${contextSummary.busy || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-ready"
                        :style="{ width: getContextRatio(contextSummary.ready) + '%' }"
                        :title="`${t('contextReady')} ${contextSummary.ready || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-draining"
                        :style="{ width: getContextRatio(contextSummary.draining) + '%' }"
                        :title="`${t('contextDraining')} ${contextSummary.draining || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-closing"
                        :style="{ width: getContextRatio(contextSummary.closing) + '%' }"
                        :title="`${t('contextClosing')} ${contextSummary.closing || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-init"
                        :style="{ width: getContextRatio(contextSummary.initializing) + '%' }"
                        :title="`${t('contextInitializing')} ${contextSummary.initializing || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-reconnecting"
                        :style="{ width: getContextRatio(contextSummary.reconnecting) + '%' }"
                        :title="`${t('contextReconnecting')} ${contextSummary.reconnecting || 0}`"
                    ></div>
                    <div
                        class="slot-fill slot-unavailable"
                        :style="{ width: getContextRatio(contextSummary.unavailable_occupied) + '%' }"
                        :title="`${t('contextUnavailable')} ${contextSummary.unavailable_occupied || 0}`"
                    ></div>
                </div>
            </div>

            <!-- Expanded Context Body -->
            <div v-if="contextsOpen" class="collapsible-body">
                <div class="context-view-switch">
                    <div class="view-switch-info">
                        <span class="view-switch-tip">共 {{ contexts.length }} 个实例槽位</span>
                        <span v-if="coldContexts.length > 0" class="context-ratio-hint">
                            （{{ activeContexts.length }} 活跃 / {{ coldContexts.length }} 冷备）
                        </span>
                        <button
                            v-if="contextViewMode === 'matrix' && coldContexts.length > 0 && !showAllContexts"
                            class="btn-inline-toggle"
                            @click="showAllContexts = true"
                        >
                            {{ t("schedulerShowAllContexts") }} ▾
                        </button>
                        <button
                            v-else-if="contextViewMode === 'matrix' && coldContexts.length > 0 && showAllContexts"
                            class="btn-inline-toggle"
                            @click="showAllContexts = false"
                        >
                            {{ t("schedulerCollapseColdContexts") }} ▴
                        </button>
                    </div>
                    <div class="switch-button-group">
                        <button
                            class="switch-btn"
                            :class="{ active: contextViewMode === 'matrix' }"
                            @click="contextViewMode = 'matrix'"
                        >
                            {{ t("schedulerViewMatrix") }}
                        </button>
                        <button
                            class="switch-btn"
                            :class="{ active: contextViewMode === 'table' }"
                            @click="contextViewMode = 'table'"
                        >
                            {{ t("schedulerViewTable") }}
                        </button>
                    </div>
                </div>

                <!-- A: Matrix View -->
                <div v-if="contextViewMode === 'matrix'" class="context-matrix-wrapper">
                    <div class="context-matrix-grid">
                        <div
                            v-for="context in displayedMatrixContexts"
                            :key="context.auth_index"
                            class="node-card"
                            :class="'node-' + (context.state || 'unknown').toLowerCase()"
                        >
                            <div class="node-header">
                                <span class="node-id font-mono">#{{ context.auth_index }}</span>
                                <span class="node-state-tag">{{ contextStateLabel(context.state) }}</span>
                            </div>
                            <div class="node-body">
                                <span v-if="context.draining" class="node-sub-text">
                                    {{ contextDrainLabel(context.drain_reason) }}
                                </span>
                                <span
                                    v-else-if="context.last_disconnect_reason"
                                    class="node-error-text"
                                    :title="context.last_disconnect_reason"
                                >
                                    ⚠️ {{ context.last_disconnect_reason }}
                                </span>
                                <span v-else class="node-sub-text">
                                    {{ contextDescription(context.state) }}
                                </span>
                            </div>
                            <div class="node-footer font-mono">
                                <span>在途: {{ context.inflight }}</span>
                                <span>Epoch: {{ context.connection_epoch || "—" }}</span>
                            </div>
                        </div>
                        <!-- Toggle Card when collapsed -->
                        <div
                            v-if="!showAllContexts && coldContexts.length > 0 && activeContexts.length > 0"
                            class="node-card node-expand-toggle"
                            @click="showAllContexts = true"
                        >
                            <div class="expand-toggle-inner">
                                <svg class="expand-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M19 9l-7 7-7-7"
                                    ></path>
                                </svg>
                                <span class="expand-title">+ 其余 {{ coldContexts.length }} 个冷备实例</span>
                                <span class="expand-action">{{ t("schedulerShowAllContexts") }}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Bottom Collapse Action when expanded -->
                    <div
                        v-if="showAllContexts && coldContexts.length > 0 && activeContexts.length > 0"
                        class="matrix-collapse-bar"
                    >
                        <button class="btn btn-sm btn-default" @click="showAllContexts = false">
                            {{ t("schedulerCollapseColdContexts") }} ▴
                        </button>
                    </div>
                </div>

                <!-- B: Table View -->
                <div v-else class="scheduler-table modern-table-wrap">
                    <table class="modern-table">
                        <thead>
                            <tr>
                                <th>Context</th>
                                <th>{{ t("schedulerStatus") }}</th>
                                <th>{{ t("schedulerInflight") }}</th>
                                <th>WS Epoch</th>
                                <th>Models</th>
                                <th>Replacement</th>
                                <th>{{ t("schedulerLastDisconnect") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="context in contexts"
                                :key="context.auth_index"
                                :class="{ 'row-error': context.state === 'UNAVAILABLE' }"
                            >
                                <td class="font-mono font-bold">#{{ context.auth_index }}</td>
                                <td>
                                    <span class="status-badge" :class="'badge-' + (context.state || '').toLowerCase()">
                                        {{ contextStateLabel(context.state) }}
                                    </span>
                                    <span v-if="context.draining" class="node-sub-text">
                                        {{ contextDrainLabel(context.drain_reason) }}
                                    </span>
                                </td>
                                <td class="font-mono">{{ context.inflight }}</td>
                                <td class="font-mono">{{ context.connection_epoch || "—" }}</td>
                                <td class="font-mono">{{ context.requested_for_models?.join(", ") || "—" }}</td>
                                <td>
                                    {{ context.replacement_for == null ? "—" : `#${context.replacement_for}` }}
                                    {{ context.replacement_reason || "" }}
                                </td>
                                <td class="font-mono" :class="{ 'text-error': context.last_disconnect_reason }">
                                    {{ context.last_disconnect_reason || "—" }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- 5. Main Model Summary Table (Ultra Clean: header explicitly defines meaning, no cell repetition) -->
        <div class="scheduler-table modern-table-wrap model-summary-wrap">
            <table class="modern-table">
                <thead>
                    <tr>
                        <th>{{ t("schedulerModel") }}</th>
                        <th>{{ t("schedulerTodayRequests") }}</th>
                        <th>层级允许 / {{ t("schedulerAvailable") }}</th>
                        <th class="text-center">429</th>
                        <th>{{ t("schedulerQueued") }}</th>
                        <th>{{ t("schedulerWorkers") }}</th>
                        <th>Min / Preferred</th>
                        <th class="text-right">{{ t("schedulerActions") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!data.models?.length">
                        <td colspan="8" class="scheduler-empty">{{ t("schedulerNoVisibleModels") }}</td>
                    </tr>
                    <tr v-for="model in data.models" :key="model.model">
                        <td>
                            <div class="model-cell">
                                <span class="model-name font-mono">{{ model.model }}</span>
                                <span class="model-type-tag" :class="getModelTagClass(model.model)">
                                    {{ getModelTagLabel(model.model) }}
                                </span>
                            </div>
                        </td>
                        <td class="font-mono font-medium">{{ formatNumber(model.daily_requests) }}</td>
                        <!-- 可用账号: 纯数字，过低时黄色预警 -->
                        <td class="font-mono font-bold" :class="{ 'text-warning': model.available_accounts <= 1 }">
                            {{ model.tier_allowed_accounts ?? "—" }} / {{ model.available_accounts }}
                        </td>
                        <!-- 429: 表头已有明确定义，单元格仅保留纯数字徽章，绝不重复文字 -->
                        <td class="text-center">
                            <span v-if="model.rate_limited_accounts > 0" class="number-badge-429">
                                {{ model.rate_limited_accounts }}
                            </span>
                            <span v-else class="text-slate-400 font-mono">0</span>
                        </td>
                        <!-- 排队: 纯数字 -->
                        <td class="font-mono" :class="{ 'text-warning font-bold': model.queue_length > 0 }">
                            {{ model.queue_length }}
                        </td>
                        <!-- 逻辑执行槽: 纯数字 -->
                        <td class="font-mono font-medium text-slate-700">{{ model.active_workers }}</td>
                        <!-- Min / Preferred -->
                        <td class="font-mono text-slate-500">
                            {{ model.configured_workers.min }} / {{ model.configured_workers.preferred }}
                        </td>
                        <!-- 操作 -->
                        <td class="text-right">
                            <button
                                class="btn-table-action"
                                :disabled="busy || operatingModel === model.model"
                                @click="hideModel(model.model)"
                            >
                                {{ t("schedulerHideModel") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- 6. Account × Model Health Drilldown (Expandable 2) -->
        <div class="collapsible-card accounts-detail-card">
            <div class="collapsible-header" @click="toggleAccounts">
                <div class="header-left">
                    <svg
                        class="chevron-icon"
                        :class="{ rotated: accountsOpen }"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                    <strong>{{ t("schedulerAccounts") }}</strong>
                    <span class="capacity-pill font-mono">{{ summaryCounts.total }} 个账号</span>
                </div>

                <div class="header-pills">
                    <span v-if="summaryCounts.rateLimited > 0" class="status-pill pill-error">
                        {{ summaryCounts.rateLimited }} 个 429
                    </span>
                    <span v-if="summaryCounts.riskControlled > 0" class="status-pill pill-purple">
                        {{ summaryCounts.riskControlled }} 个 403
                    </span>
                    <span v-if="summaryCounts.persistent403 > 0" class="status-pill pill-persistent-403">
                        {{ t("schedulerPersistent403Summary", { count: summaryCounts.persistent403 }) }}
                    </span>
                    <span v-if="summaryCounts.disabled > 0" class="status-pill pill-slate">
                        {{ summaryCounts.disabled }} 个禁用
                    </span>
                    <span class="toggle-text">
                        {{ accountsOpen ? t("schedulerCollapseDetails") : t("schedulerExpandDetails") }}
                    </span>
                </div>
            </div>

            <!-- Expanded Accounts Body -->
            <div v-if="accountsOpen" class="collapsible-body">
                <!-- Smart Filter & Search Bar -->
                <div class="accounts-toolbar">
                    <div class="filter-tabs">
                        <button
                            class="filter-tab"
                            :class="{ active: accountFilter === 'all' }"
                            @click="accountFilter = 'all'"
                        >
                            {{ t("schedulerFilterAll") }} ({{ accounts.length }})
                        </button>
                        <button
                            class="filter-tab tab-429"
                            :class="{ active: accountFilter === '429' }"
                            @click="accountFilter = '429'"
                        >
                            🚨 {{ t("schedulerFilter429") }} ({{ summaryCounts.rateLimited }})
                        </button>
                        <button
                            class="filter-tab tab-403"
                            :class="{ active: accountFilter === '403' }"
                            @click="accountFilter = '403'"
                        >
                            🛡️ {{ t("schedulerFilter403") }} ({{ summaryCounts.riskControlled }})
                        </button>
                        <button
                            class="filter-tab tab-persistent-403"
                            :class="{ active: accountFilter === 'persistent-403' }"
                            @click="accountFilter = 'persistent-403'"
                        >
                            ⚠️ {{ t("schedulerFilterPersistent403") }} ({{ summaryCounts.persistent403 }})
                        </button>
                        <button
                            class="filter-tab tab-disabled"
                            :class="{ active: accountFilter === 'disabled' }"
                            @click="accountFilter = 'disabled'"
                        >
                            🚫 {{ t("schedulerFilterDisabled") }} ({{ summaryCounts.disabled }})
                        </button>
                        <button
                            class="filter-tab tab-healthy"
                            :class="{ active: accountFilter === 'healthy' }"
                            @click="accountFilter = 'healthy'"
                        >
                            ✅ {{ t("schedulerFilterHealthy") }} ({{ summaryCounts.healthy }})
                        </button>
                    </div>

                    <div class="search-input-wrap">
                        <svg class="search-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                            ></path>
                        </svg>
                        <input
                            v-model="searchQuery"
                            type="text"
                            :placeholder="t('schedulerSearchPlaceholder')"
                            class="search-input"
                        />
                    </div>
                </div>

                <!-- Account Cards List -->
                <div class="accounts-card-list">
                    <div v-if="!filteredAccounts.length" class="scheduler-empty py-4 text-center">
                        没有符合条件的账号
                    </div>

                    <div
                        v-for="account in filteredAccounts"
                        :key="account.index"
                        class="account-row-card"
                        :class="'border-' + getAccountState(account)"
                    >
                        <!-- Account Header Strip -->
                        <div class="account-card-header" @click="toggleAccountManual(account.index)">
                            <div class="acc-header-left">
                                <svg
                                    class="acc-chevron"
                                    :class="{ rotated: expandedAccounts.has(account.index) }"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M9 5l7 7-7 7"
                                    ></path>
                                </svg>
                                <span class="acc-status-dot" :class="'dot-' + getAccountState(account)"></span>
                                <span class="acc-index font-mono">#{{ account.index }}</span>
                                <span
                                    class="acc-key font-mono"
                                    :class="{ 'line-through text-slate-400': account.disabled }"
                                >
                                    {{ account.key }}
                                </span>

                                <!-- Concise Badge: strictly clear without verbose text -->
                                <span class="acc-badge" :class="'badge-' + getAccountState(account)">
                                    {{ getAccountStateLabel(account) }}
                                </span>
                                <span
                                    v-if="account.persistent_403"
                                    class="acc-badge badge-persistent-403"
                                    :title="t('schedulerPersistent403Tooltip')"
                                >
                                    ⚠
                                    {{
                                        t("schedulerPersistent403Badge", {
                                            duration: formatPersistent403Duration(account),
                                        })
                                    }}
                                </span>
                            </div>

                            <!-- Unified Action Buttons (Never split wording!) -->
                            <div class="acc-header-right" @click.stop>
                                <span class="acc-inflight-text">
                                    {{ t("schedulerInflight") }}: <b class="font-mono">{{ account.inflight }}</b>
                                </span>

                                <button
                                    class="btn btn-sm btn-primary-soft"
                                    :disabled="busy || account.inflight > 0"
                                    @click="reset(account.index)"
                                >
                                    {{ t("schedulerResetAccount") }}
                                </button>

                                <button
                                    class="btn btn-sm btn-default"
                                    :disabled="busy || account.disabled"
                                    @click="disableAccount(account.index)"
                                >
                                    {{ t("schedulerDisableAccount") }}
                                </button>
                            </div>
                        </div>

                        <!-- Inside Account: Model Slots Detail -->
                        <div v-if="expandedAccounts.has(account.index)" class="account-card-body">
                            <div v-if="loadingAccounts.has(account.index)" class="scheduler-empty py-2">
                                正在加载模型槽位详情…
                            </div>
                            <div v-else-if="!account.models?.length" class="scheduler-empty py-2">
                                {{ t("schedulerNoVisibleModels") }}
                            </div>
                            <div v-else class="model-slots-list">
                                <div
                                    v-for="slot in account.models"
                                    :key="slot.model"
                                    class="model-slot-row"
                                    :class="{ 'slot-alert': isSlotRestricted(slot) }"
                                >
                                    <div class="slot-row-main">
                                        <div class="slot-info">
                                            <span class="model-type-tag" :class="getModelTagClass(slot.model)">
                                                {{ getModelTagLabel(slot.model) }}
                                            </span>
                                            <span class="slot-model-name font-mono font-bold">{{ slot.model }}</span>
                                            <span
                                                class="slot-status-badge"
                                                :class="'badge-' + getSlotStatusClass(slot)"
                                            >
                                                {{ getSlotStatusLabel(slot) }}
                                            </span>
                                        </div>

                                        <div class="slot-meta font-mono">
                                            <span
                                                >今日请求: <b>{{ slot.daily_requests }}</b></span
                                            >
                                            <span
                                                >失败:
                                                <b :class="{ 'text-error': slot.daily_failures > 0 }">{{
                                                    slot.daily_failures
                                                }}</b></span
                                            >
                                            <span v-if="slot.cooldown_until" class="text-warning font-semibold">
                                                冷却截止: {{ formatDateTime(slot.cooldown_until) }}
                                            </span>
                                            <button
                                                class="btn-text-action"
                                                :disabled="busy || account.inflight > 0"
                                                @click="reset(account.index, slot.model)"
                                            >
                                                {{ t("schedulerReset") }}
                                            </button>
                                        </div>
                                    </div>

                                    <!-- Clean error excerpt box (never breaks table width) -->
                                    <div v-if="slot.last_error" class="slot-error-box">
                                        <span class="error-tag font-mono font-bold">{{ getErrorTag(slot) }}</span>
                                        <span class="error-msg truncate" :title="slot.last_error">
                                            {{ slot.last_error }}
                                        </span>
                                        <button
                                            v-if="isJsonError(slot.last_error)"
                                            class="btn-expand-json"
                                            @click="toggleErrorJson(account.index, slot.model)"
                                        >
                                            {{ t("schedulerFullJson") }} ▾
                                        </button>
                                    </div>
                                    <pre v-if="isErrorJsonOpen(account.index, slot.model)" class="json-code-view">{{
                                        formatJsonError(slot.last_error)
                                    }}</pre>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <p v-if="error" class="alert-box alert-error" role="alert">{{ error }}</p>
    </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
    data: { default: null, type: Object },
    t: { required: true, type: Function },
});
const emit = defineEmits(["refresh"]);

const busy = ref(false),
    error = ref(""),
    rateLimitsReset = ref(false),
    allAccountsResetMessage = ref(""),
    modelVisibilityMessage = ref(""),
    operatingModel = ref(""),
    accountActionMessage = ref("");

const contextsOpen = ref(false),
    accountsOpen = ref(false),
    hiddenModelsOpen = ref(false),
    contexts = ref([]),
    accounts = ref([]),
    expandedAccounts = ref(new Set()),
    loadingAccounts = ref(new Set()),
    showAllContexts = ref(false),
    hiddenModels = ref([]),
    hiddenModelsLoading = ref(false);

const accountFilter = ref("all");
const searchQuery = ref("");
const contextViewMode = ref("matrix");
const expandedErrors = ref(new Set());

const activeContexts = computed(() => {
    return contexts.value.filter(c => {
        const state = (c.state || "").toUpperCase();
        return (
            state === "READY" ||
            state === "INITIALIZING" ||
            state === "BUSY" ||
            state === "RECONNECTING" ||
            state === "DRAINING" ||
            state === "CLOSING" ||
            state === "UNAVAILABLE" ||
            c.inflight > 0
        );
    });
});

const coldContexts = computed(() => {
    return contexts.value.filter(c => {
        const state = (c.state || "").toUpperCase();
        return !(
            state === "READY" ||
            state === "INITIALIZING" ||
            state === "BUSY" ||
            state === "RECONNECTING" ||
            state === "DRAINING" ||
            state === "CLOSING" ||
            state === "UNAVAILABLE" ||
            c.inflight > 0
        );
    });
});

const displayedMatrixContexts = computed(() => {
    if (showAllContexts.value || coldContexts.value.length === 0 || activeContexts.value.length === 0) {
        return contexts.value;
    }
    return activeContexts.value;
});

const contextSummary = computed(() => props.data?.contexts_summary || {});
const contextOccupied = computed(
    () =>
        contextSummary.value.occupied ??
        ["busy", "ready", "initializing", "reconnecting", "draining", "closing"].reduce(
            (total, state) => total + (contextSummary.value[state] || 0),
            0
        )
);

function contextStateLabel(state) {
    return state === "DRAINING" ? props.t("contextDraining") : state === "CLOSING" ? props.t("contextClosing") : state;
}

function contextDrainLabel(reason) {
    const key = {
        account_disabled: "schedulerPoolDisabledDraining",
        context_capacity: "schedulerPoolCapacityDraining",
        visible_models_rate_limited: "schedulerPoolQuotaDraining",
    }[reason];
    return props.t(key || "schedulerPoolDraining");
}

function contextDescription(state) {
    const key = {
        BUSY: "contextBusyDescription",
        CLOSING: "contextClosingDescription",
        COLD: "contextColdDescription",
        DRAINING: "schedulerPoolDraining",
        INITIALIZING: "contextInitializingDescription",
        READY: "contextReadyDescription",
        RECONNECTING: "contextReconnectingDescription",
        UNAVAILABLE: "contextUnavailableDescription",
    }[state];
    return key ? props.t(key) : state || "—";
}
const totalCapacity = computed(() => (props.data?.active_workers || 0) + (props.data?.idle_workers || 0));
const slotUsagePercent = computed(() => {
    const total = totalCapacity.value;
    if (!total) return 0;
    return Math.min(100, Math.round(((props.data?.active_workers || 0) / total) * 100));
});

const totalErrors = computed(() => {
    if (!props.data?.metrics) return 0;
    return (
        (props.data.metrics.local_transport || 0) +
        (props.data.metrics.dispatch_timeout || 0) +
        (props.data.metrics.upstream_error || 0)
    );
});

const errorMetricsHint = computed(() => {
    if (!props.data?.metrics) return "";
    return `传输错误: ${props.data.metrics.local_transport} · 调度超时: ${props.data.metrics.dispatch_timeout} · 上游错误: ${props.data.metrics.upstream_error}`;
});

let contextsController = null;
let accountsController = null;
let hiddenModelsController = null;

const formatNumber = value => Number(value || 0).toLocaleString();

function formatDateTime(val) {
    if (!val) return "—";
    const d = new Date(val);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function formatPersistent403Duration(account) {
    const duration = Math.max(0, Number(account.continuous_403_duration_ms) || 0);
    const days = Math.floor(duration / 86400000);
    const hours = Math.floor((duration % 86400000) / 3600000);
    return props.t("schedulerPersistent403Duration", { days, hours });
}

function getQuotaPercent(quota) {
    const total = quota.total_quota ?? (quota.tracked_accounts || 0) * (quota.quota_per_account || 0);
    if (!total) return 0;
    const remaining = quota.estimated_remaining_quota || 0;
    return Math.min(100, Math.max(0, Math.round((remaining / total) * 100)));
}

function getModelTagLabel(modelName) {
    if (!modelName) return "MODEL";
    const lower = modelName.toLowerCase();
    if (lower.includes("pro")) return "Pro";
    if (lower.includes("flash")) return "Flash";
    return "Gemini";
}

function getModelTagClass(modelName) {
    if (!modelName) return "tag-default";
    const lower = modelName.toLowerCase();
    if (lower.includes("pro")) return "tag-pro";
    if (lower.includes("flash")) return "tag-flash";
    return "tag-default";
}

function getContextRatio(count) {
    const max = Number(contextSummary.value.max) || 0;
    const value = Number(count) || 0;
    if (max <= 0) return 0;
    return Math.min(100, Math.max(0, (value / max) * 100));
}

// Account State Determination
function hasAccount403(account) {
    if (account.has_403) return true;
    const models = account.models || [];
    return models.some(m => m.status === "RISK_CONTROLLED" || m.last_error_kind === "risk_controlled");
}

function hasAccount429(account) {
    if (account.has_429) return true;
    const models = account.models || [];
    return models.some(
        m =>
            m.status === "RATE_LIMITED" ||
            m.status === "COOLDOWN" ||
            (m.cooldown_until && m.status !== "RISK_CONTROLLED")
    );
}

function getAccountState(account) {
    if (account.disabled) return "disabled";
    if (hasAccount403(account)) return "403";
    if (hasAccount429(account)) return "429";
    if (!account.healthy) return "unhealthy";
    return "healthy";
}

function getAccountStateLabel(account) {
    const state = getAccountState(account);
    if (state === "disabled") return props.t("schedulerStatusDisabled");
    if (state === "403") return props.t("schedulerStatusRiskControlled");
    if (state === "429") return props.t("schedulerStatusRateLimited");
    if (state === "unhealthy") return "异常";
    return props.t("schedulerStatusHealthy");
}

function isSlotRestricted(slot) {
    return (
        slot.status === "RATE_LIMITED" ||
        slot.status === "RISK_CONTROLLED" ||
        slot.status === "COOLDOWN" ||
        Boolean(slot.cooldown_until)
    );
}

function getSlotStatusClass(slot) {
    if (slot.status === "RISK_CONTROLLED" || slot.last_error_kind === "risk_controlled") return "403";
    if (slot.status === "RATE_LIMITED" || slot.status === "COOLDOWN") return "429";
    if (slot.status === "HEALTHY") return "healthy";
    return "default";
}

function getSlotStatusLabel(slot) {
    if (slot.status === "RISK_CONTROLLED" || slot.last_error_kind === "risk_controlled")
        return props.t("schedulerStatusRiskControlled");
    if (slot.status === "RATE_LIMITED") return props.t("schedulerStatusRateLimited");
    if (slot.status === "COOLDOWN") return props.t("schedulerCooldown");
    if (slot.status === "HEALTHY") return props.t("schedulerStatusHealthy");
    return slot.status || "—";
}

function getErrorTag(slot) {
    if (slot.status === "RATE_LIMITED" || slot.last_error?.includes("429")) return "[429]";
    if (slot.status === "RISK_CONTROLLED" || slot.last_error?.includes("403")) return "[403]";
    return "[ERR]";
}

function isJsonError(err) {
    return typeof err === "string" && (err.includes("{") || err.includes("Google API returned error"));
}

function formatJsonError(err) {
    if (!err) return "";
    const jsonIdx = err.indexOf("{");
    if (jsonIdx >= 0) {
        try {
            const parsed = JSON.parse(err.slice(jsonIdx));
            return JSON.stringify(parsed, null, 2);
        } catch {
            return err;
        }
    }
    return err;
}

function toggleErrorJson(accIdx, model) {
    const key = `${accIdx}_${model}`;
    if (expandedErrors.value.has(key)) expandedErrors.value.delete(key);
    else expandedErrors.value.add(key);
}

function isErrorJsonOpen(accIdx, model) {
    return expandedErrors.value.has(`${accIdx}_${model}`);
}

// Summary counts for filter tabs
const summaryCounts = computed(() => {
    const overview = props.data?.accounts_summary;
    if (overview) {
        return {
            disabled: overview.disabled || 0,
            healthy: overview.healthy || 0,
            persistent403: overview.persistent_403 || 0,
            rateLimited: overview.rate_limited || 0,
            riskControlled: overview.risk_controlled || 0,
            total: overview.total || 0,
        };
    }
    let rateLimited = 0;
    let riskControlled = 0;
    let disabled = 0;
    let healthy = 0;
    let persistent403 = 0;

    for (const acc of accounts.value) {
        if (acc.persistent_403) persistent403++;
        const state = getAccountState(acc);
        if (state === "disabled") disabled++;
        else if (state === "403") riskControlled++;
        else if (state === "429") rateLimited++;
        else if (state === "healthy") healthy++;
    }

    return { disabled, healthy, persistent403, rateLimited, riskControlled, total: accounts.value.length };
});

const filteredAccounts = computed(() => {
    const filter = accountFilter.value;
    const query = searchQuery.value.trim().toLowerCase();

    return accounts.value.filter(acc => {
        // Tab filter
        if (filter !== "all") {
            if (filter === "persistent-403") {
                if (!acc.persistent_403) return false;
            } else {
                const state = getAccountState(acc);
                if (state !== filter) return false;
            }
        }

        // Query filter
        if (query) {
            const key = (acc.key || "").toLowerCase();
            const idx = `#${acc.index}`;
            if (!key.includes(query) && !idx.includes(query)) return false;
        }

        return true;
    });
});

async function getJson(url, signal) {
    const response = await fetch(url, { signal });
    if (response.status === 304) return null;
    if (response.redirected || response.status === 401) {
        window.location.href = response.redirected ? response.url : "/login";
        return null;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
    return result;
}

async function fetchContexts(force = false) {
    if (!contextsOpen.value) return;
    if (contextsController) {
        if (!force) return;
        contextsController.abort();
    }
    const controller = new AbortController();
    contextsController = controller;
    try {
        const result = await getJson("/api/scheduler/contexts", controller.signal);
        if (result && contextsOpen.value) contexts.value = result.contexts || [];
    } finally {
        if (contextsController === controller) contextsController = null;
    }
}

async function fetchAccounts(force = false) {
    if (!accountsOpen.value) return;
    if (accountsController) {
        if (!force) return;
        accountsController.abort();
    }
    const controller = new AbortController();
    accountsController = controller;
    const ids = [...expandedAccounts.value];
    try {
        const [overview, detailResult] = await Promise.all([
            getJson("/api/scheduler/accounts", controller.signal),
            ids.length
                ? getJson(`/api/scheduler/accounts?ids=${ids.join(",")}`, controller.signal)
                : Promise.resolve(null),
        ]);
        if (!overview || !accountsOpen.value) return;
        const previous = new Map(accounts.value.map(account => [account.index, account]));
        const details = new Map((detailResult?.accounts || []).map(account => [account.index, account]));
        accounts.value = (overview.accounts || []).map(account => {
            if (details.has(account.index)) return details.get(account.index);
            const old = previous.get(account.index);
            return old?.models ? { ...account, models: old.models } : account;
        });
    } finally {
        if (accountsController === controller) {
            accountsController = null;
            for (const id of ids) loadingAccounts.value.delete(id);
        }
    }
}

async function fetchHiddenModels(force = false) {
    if (hiddenModelsController) {
        if (!force) return;
        hiddenModelsController.abort();
    }
    const controller = new AbortController();
    hiddenModelsController = controller;
    hiddenModelsLoading.value = true;
    try {
        const result = await getJson("/api/scheduler/models/hidden", controller.signal);
        if (result) hiddenModels.value = result.models || [];
    } finally {
        if (hiddenModelsController === controller) {
            hiddenModelsController = null;
            hiddenModelsLoading.value = false;
        }
    }
}

function toggleHiddenModelsPopover() {
    hiddenModelsOpen.value = !hiddenModelsOpen.value;
    if (hiddenModelsOpen.value) fetchHiddenModels(true).catch(setError);
}

function toggleContexts() {
    contextsOpen.value = !contextsOpen.value;
    if (contextsOpen.value) fetchContexts(true).catch(setError);
    else {
        contextsController?.abort();
        contexts.value = [];
    }
}

function toggleAccounts() {
    accountsOpen.value = !accountsOpen.value;
    if (accountsOpen.value) fetchAccounts(true).catch(setError);
    else {
        accountsController?.abort();
        accounts.value = [];
        expandedAccounts.value = new Set();
        loadingAccounts.value.clear();
    }
}

function toggleAccountManual(index) {
    const next = new Set(expandedAccounts.value);
    if (next.has(index)) {
        next.delete(index);
        loadingAccounts.value.delete(index);
    } else {
        if (next.size >= 20) {
            error.value = props.t("schedulerAccountExpandLimit");
            return;
        }
        next.add(index);
        loadingAccounts.value.add(index);
    }
    expandedAccounts.value = next;
    if (next.has(index)) {
        fetchAccounts(true).catch(failure => {
            loadingAccounts.value.delete(index);
            if (failure.name !== "AbortError") setError(failure);
        });
    }
}

function setError(failure) {
    if (failure.name === "AbortError") return;
    error.value = failure.message;
}

watch(
    () => props.data,
    () => {
        if (contextsOpen.value) fetchContexts().catch(setError);
        if (accountsOpen.value) fetchAccounts().catch(setError);
    }
);

onBeforeUnmount(() => {
    contextsController?.abort();
    accountsController?.abort();
    hiddenModelsController?.abort();
});

onMounted(() => fetchHiddenModels().catch(setError));

async function resetAllRateLimits() {
    rateLimitsReset.value = Boolean(await sendReset("/api/scheduler/reset-rate-limits", {}));
}

async function resetAllAccounts() {
    if (!window.confirm(props.t("schedulerResetAllAccountsConfirm"))) return;
    const result = await sendReset("/api/scheduler/reset-all", {});
    if (!result) return;
    allAccountsResetMessage.value =
        result.reset_account_count || result.reset_model_count
            ? props.t("schedulerResetAllAccountsSuccess", {
                  accounts: result.reset_account_count,
                  models: result.reset_model_count,
              })
            : props.t("schedulerResetAllAccountsNoChanges");
}

async function reset(accountId, model) {
    const result = await sendReset("/api/scheduler/reset", { account_id: accountId, model });
    if (!result) return;
    await fetchAccounts(true);
}

async function disableAccount(accountId) {
    if (!window.confirm(props.t("schedulerDisableAccountConfirm"))) return;
    const result = await sendReset("/api/scheduler/disable", { account_id: accountId });
    if (!result) return;
    accountActionMessage.value = props.t(
        result.changed ? "schedulerDisableAccountSuccess" : "schedulerDisableAccountNoChanges"
    );
    await fetchAccounts(true);
}

async function hideModel(model) {
    if (!window.confirm(props.t("schedulerHideModelConfirm", { model }))) return;
    await setModelVisibility(model, true);
}

async function setModelVisibility(model, hidden) {
    rateLimitsReset.value = false;
    allAccountsResetMessage.value = "";
    modelVisibilityMessage.value = "";
    operatingModel.value = model;
    error.value = "";
    try {
        const response = await fetch(`/api/scheduler/models/${hidden ? "hide" : "show"}`, {
            body: JSON.stringify({ model }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(result.error || result.message || `${response.status} ${response.statusText}`);
        modelVisibilityMessage.value = props.t(hidden ? "schedulerHideModelSuccess" : "schedulerShowModelSuccess", {
            model: result.model,
        });
        await Promise.all([fetchHiddenModels(true), accountsOpen.value ? fetchAccounts(true) : Promise.resolve()]);
        emit("refresh");
        return result;
    } catch (failure) {
        setError(failure);
        return false;
    } finally {
        operatingModel.value = "";
    }
}

async function sendReset(url, body) {
    rateLimitsReset.value = false;
    allAccountsResetMessage.value = "";
    busy.value = true;
    error.value = "";
    try {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(result.error || result.message || `${response.status} ${response.statusText}`);
        emit("refresh");
        return result;
    } catch (failure) {
        setError(failure);
        return false;
    } finally {
        busy.value = false;
    }
}
</script>

<style scoped>
.scheduler-status {
    margin-bottom: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 20px 24px;
    box-shadow: none;
    color: var(--text-primary);
}

/* 1. Header */
.scheduler-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
}

.header-main-title {
    display: flex;
    align-items: center;
    gap: 10px;
}

.status-pulse-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--color-success);
    box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);
}

.header-main-title h3 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary);
}

.header-sub {
    margin: 4px 0 0;
    font-size: 0.8rem;
    color: var(--text-muted);
}

.header-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}

.metric-meter-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--bg-body);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    font-size: 0.75rem;
}

.meter-label {
    color: var(--text-muted);
}

.meter-val {
    font-weight: 700;
    color: var(--text-primary);
}

.mini-progress-track {
    width: 48px;
    height: 6px;
    background: var(--border-color);
    border-radius: 999px;
    overflow: hidden;
}

.mini-progress-fill {
    height: 100%;
    background: var(--color-primary);
    border-radius: 999px;
    transition: width 0.3s ease;
}

.health-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 600;
}

.health-chip-ok {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #047857;
}

.health-chip-warn {
    background: #fffbeb;
    border: 1px solid #fde68a;
    color: #b45309;
}

.chip-icon {
    width: 14px;
    height: 14px;
}

/* 2. Quota Section */
.quota-section {
    padding: 16px;
    margin: 16px 0;
    border: 1px solid #dbeafe;
    border-radius: 12px;
    background: var(--color-primary-soft);
}

.quota-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 12px;
}

.quota-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    color: #1e3a8a;
}

.quota-icon {
    width: 16px;
    height: 16px;
    color: var(--color-primary);
}

.date-badge {
    padding: 2px 8px;
    border-radius: 4px;
    background: #dbeafe;
    color: #1e40af;
    font-size: 0.7rem;
    font-family: monospace;
    font-weight: 600;
}

.quota-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
}

.quota-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
}

.quota-card {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.quota-card-alert {
    border-color: #fde68a;
    background: #fffdf5;
}

.quota-card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
}

.model-info {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
}

.model-type-tag {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
}

.tag-pro {
    background: #f3e8ff;
    color: #7e22ce;
}

.tag-flash {
    background: #e0f2fe;
    color: #0369a1;
}

.tag-default {
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
}

.quota-model-name {
    font-family: monospace;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text-primary);
    word-break: break-all;
}

.quota-card-val {
    text-align: right;
}

.quota-number {
    font-family: monospace;
    font-size: 1.25rem;
    font-weight: 800;
    color: var(--text-primary);
}

.quota-unit {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-left: 2px;
}

.quota-warning-text {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--color-warning);
}

.quota-percent-text {
    font-size: 0.75rem;
    color: var(--text-muted);
}

.quota-progress-track {
    width: 100%;
    height: 6px;
    background: var(--bg-list-item-hover);
    border-radius: 999px;
    overflow: hidden;
}

.quota-progress-bar {
    height: 100%;
    border-radius: 999px;
    transition: width 0.3s ease;
}

.bar-normal {
    background: var(--color-primary);
}

.bar-alert {
    background: #f59e0b;
}

.quota-card-footer {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: var(--text-muted);
    border-top: 1px solid var(--bg-body);
    padding-top: 6px;
}

/* 3. Action Toolbar */
.scheduler-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
}

.action-buttons-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    position: relative;
}

.btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid transparent;
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-primary {
    background: var(--color-primary);
    color: var(--bg-card);
}

.btn-primary:hover:not(:disabled) {
    background: #1d4ed8;
}

.btn-default {
    background: var(--bg-card);
    border-color: #cbd5e1;
    color: #334155;
}

.btn-default:hover:not(:disabled) {
    background: var(--bg-body);
    border-color: #94a3b8;
}

.btn-dashed {
    background: var(--bg-card);
    border: 1px dashed #cbd5e1;
    color: var(--text-secondary);
}

.btn-dashed:hover:not(:disabled),
.btn-dashed.active {
    border-color: #3b82f6;
    color: var(--color-primary);
}

.btn-sm {
    padding: 4px 10px;
    font-size: 0.72rem;
}

.btn-primary-soft {
    background: #eff6ff;
    border-color: #bfdbfe;
    color: #1d4ed8;
}

.btn-primary-soft:hover:not(:disabled) {
    background: #dbeafe;
}

.btn-icon {
    width: 14px;
    height: 14px;
}

.btn-table-action {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.15s;
}

.btn-table-action:hover:not(:disabled) {
    color: #ef4444;
    background: #fef2f2;
}

.btn-text-action {
    background: transparent;
    border: none;
    color: var(--color-primary);
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
}

.btn-text-action:hover:not(:disabled) {
    text-decoration: underline;
}

.error-metrics-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75rem;
    color: var(--text-muted);
}

.error-metrics-strip b {
    color: var(--text-primary);
    font-family: monospace;
}

/* Popover for hidden models */
.popover-wrapper {
    position: relative;
}

.hidden-models-popover {
    position: absolute;
    left: 0;
    top: calc(100% + 8px);
    width: 320px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 14px;
    box-shadow:
        0 10px 25px -5px rgba(0, 0, 0, 0.1),
        0 8px 10px -6px rgba(0, 0, 0, 0.1);
    z-index: 50;
}

.popover-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
}

.popover-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-primary);
}

.popover-close-btn {
    background: transparent;
    border: none;
    font-size: 1.1rem;
    line-height: 1;
    color: #94a3b8;
    cursor: pointer;
}

.popover-close-btn:hover {
    color: #334155;
}

.popover-tip {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin: 0 0 10px;
    line-height: 1.4;
}

.popover-list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 180px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.popover-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    background: var(--bg-body);
    border: 1px solid var(--bg-list-item-hover);
    border-radius: 6px;
}

.popover-model-name {
    font-family: monospace;
    font-size: 0.72rem;
    color: #334155;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Alert Boxes */
.alert-box {
    padding: 8px 14px;
    margin: 10px 0;
    border-radius: 8px;
    font-size: 0.78rem;
}

.alert-success {
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    color: #065f46;
}

.alert-info {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    color: #1e40af;
}

.alert-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #991b1b;
}

/* 4. Collapsible Card Structure (Context Pool & Accounts Drilldown) */
.collapsible-card {
    border: 1px solid var(--border-color);
    border-radius: 12px;
    background: var(--bg-body);
    overflow: hidden;
    margin: 14px 0;
    transition: border-color 0.2s;
}

.collapsible-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
}

.collapsible-header:hover {
    background: var(--bg-list-item-hover);
}

.header-left {
    display: flex;
    align-items: center;
    gap: 8px;
}

.header-left strong {
    font-size: 0.85rem;
    color: var(--text-primary);
}

.chevron-icon {
    width: 16px;
    height: 16px;
    color: #94a3b8;
    transition: transform 0.2s ease;
}

.chevron-icon.rotated {
    transform: rotate(180deg);
}

.capacity-pill {
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--border-color);
    color: var(--text-secondary);
}

.header-pills {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.status-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
}

.pill-ready {
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
    border: 1px solid #cbd5e1;
}

.pill-busy {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #a7f3d0;
}

.pill-draining {
    background: #fff7ed;
    color: #c2410c;
    border: 1px solid #fed7aa;
}

.pill-closing {
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
    border: 1px solid #cbd5e1;
}

.pill-init {
    background: #fffbeb;
    color: #b45309;
    border: 1px solid #fde68a;
}

.pill-reconnecting {
    background: #fff7ed;
    color: #c2410c;
    border: 1px solid #fed7aa;
}

.pill-error {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
}

.pill-purple {
    background: #f5f3ff;
    color: #6d28d9;
    border: 1px solid #ddd6fe;
}

.pill-slate {
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
    border: 1px solid #cbd5e1;
}

.dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
}

.dot-ready {
    background: #94a3b8;
}

.dot-busy {
    background: var(--color-success);
}

.dot-draining,
.slot-draining {
    background: #f97316;
}

.dot-closing,
.slot-closing,
.slot-ready {
    background: #94a3b8;
}

.dot-init {
    background: #f59e0b;
}

.dot-reconnecting {
    background: #f97316;
}

.dot-error {
    background: #ef4444;
}

.toggle-text {
    font-size: 0.75rem;
    color: var(--color-primary);
    margin-left: 6px;
    font-weight: 600;
}

.collapsible-body {
    padding: 14px 16px;
    border-top: 1px solid var(--border-color);
    background: var(--bg-card);
}

/* Context Pool Progress Slot */
.context-slot-bar-wrap {
    padding: 0 16px 8px;
}

.context-slot-bar {
    width: 100%;
    height: 6px;
    background: var(--border-color);
    border-radius: 999px;
    display: flex;
    overflow: hidden;
}

.slot-fill {
    height: 100%;
}

.slot-busy {
    background: var(--color-success);
}

.slot-init {
    background: #f59e0b;
}

.slot-reconnecting {
    background: #f97316;
}

.slot-unavailable {
    background: #ef4444;
}

.context-view-switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
}

.view-switch-info {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.view-switch-tip {
    font-size: 0.72rem;
    color: var(--text-muted);
}

.context-ratio-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-family: monospace;
}

.btn-inline-toggle {
    border: none;
    background: transparent;
    color: var(--color-primary);
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    transition: background 0.15s;
}

.btn-inline-toggle:hover {
    background: #eff6ff;
}

.switch-button-group {
    display: flex;
    background: var(--bg-list-item-hover);
    border-radius: 6px;
    padding: 2px;
}

.switch-btn {
    border: none;
    background: transparent;
    padding: 3px 10px;
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--text-muted);
    border-radius: 4px;
    cursor: pointer;
}

.switch-btn.active {
    background: var(--bg-card);
    color: var(--text-primary);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.context-matrix-wrapper {
    display: flex;
    flex-direction: column;
}

.context-matrix-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
}

.node-card {
    border: 1px solid var(--border-color);
    background: var(--bg-card);
    border-radius: 8px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.node-unavailable {
    border-color: #fecaca;
    background: #fef2f2;
}

.node-draining {
    border-color: #fed7aa;
    background: #fff7ed;
}

.node-closing {
    border-color: #cbd5e1;
    background: var(--bg-body);
}

.node-busy,
.node-ready {
    border-color: #d1fae5;
}

.node-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.node-id {
    font-size: 0.75rem;
    font-weight: 700;
}

.node-state-tag {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
}

.node-draining .node-state-tag {
    background: #ffedd5;
    color: #9a3412;
}

.node-busy .node-state-tag,
.node-ready .node-state-tag {
    background: #d1fae5;
    color: #065f46;
}

.node-unavailable .node-state-tag {
    background: #fee2e2;
    color: #991b1b;
}

.node-body {
    min-height: 18px;
}

.node-error-text {
    font-size: 0.75rem;
    color: #b91c1c;
    font-family: monospace;
}

.node-sub-text {
    font-size: 0.75rem;
    color: var(--text-muted);
}

.node-footer {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #94a3b8;
    border-top: 1px solid rgba(0, 0, 0, 0.04);
    padding-top: 4px;
}

.node-card.node-expand-toggle {
    border: 2px dashed #cbd5e1;
    background: var(--bg-body);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 80px;
    transition: all 0.2s ease;
}

.node-card.node-expand-toggle:hover {
    border-color: #3b82f6;
    background: #eff6ff;
}

.expand-toggle-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    text-align: center;
}

.expand-icon {
    width: 16px;
    height: 16px;
    color: #3b82f6;
}

.expand-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary);
}

.node-card.node-expand-toggle:hover .expand-title {
    color: #1d4ed8;
}

.expand-action {
    font-size: 0.7rem;
    color: var(--color-primary);
    font-weight: 500;
}

.matrix-collapse-bar {
    margin-top: 10px;
    display: flex;
    justify-content: center;
}

/* 5. Modern Tables */
.modern-table-wrap {
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow-x: auto;
    background: var(--bg-card);
}

.model-summary-wrap {
    margin: 16px 0;
}

.modern-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
    text-align: left;
}

.modern-table th {
    background: var(--bg-body);
    color: var(--text-secondary);
    font-weight: 600;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-color);
    white-space: nowrap;
}

.modern-table td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--bg-list-item-hover);
    color: var(--text-primary);
}

.modern-table tbody tr:hover {
    background: var(--bg-body);
}

.modern-table tbody tr:last-child td {
    border-bottom: none;
}

.model-cell {
    display: flex;
    align-items: center;
    gap: 8px;
}

.model-name {
    font-weight: 700;
    color: var(--text-primary);
}

.number-badge-429 {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    padding: 2px 8px;
    border-radius: 999px;
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
    font-size: 0.75rem;
    font-weight: 700;
    font-family: monospace;
}

/* 6. Accounts Toolbar & List */
.accounts-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-body);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    margin-bottom: 12px;
}

.filter-tabs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.filter-tab {
    border: 1px solid #cbd5e1;
    background: var(--bg-card);
    color: var(--text-secondary);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
}

.filter-tab:hover {
    background: var(--bg-list-item-hover);
}

.filter-tab.active {
    background: #eff6ff;
    color: #1d4ed8;
    border-color: #93c5fd;
}

.filter-tab.tab-429.active {
    background: #fef2f2;
    color: #b91c1c;
    border-color: #fca5a5;
}

.filter-tab.tab-403.active {
    background: #f5f3ff;
    color: #6d28d9;
    border-color: #c4b5fd;
}

.filter-tab.tab-persistent-403.active {
    background: #fff7ed;
    color: #c2410c;
    border-color: #fb923c;
}

.filter-tab.tab-disabled.active {
    background: var(--bg-list-item-hover);
    color: #334155;
    border-color: #94a3b8;
}

.filter-tab.tab-healthy.active {
    background: #ecfdf5;
    color: #047857;
    border-color: #6ee7b7;
}

.search-input-wrap {
    position: relative;
    min-width: 220px;
}

.search-icon {
    position: absolute;
    left: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    color: #94a3b8;
}

.search-input {
    width: 100%;
    padding: 5px 8px 5px 28px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font-size: 0.75rem;
    background: var(--bg-card);
    color: var(--text-primary);
    outline: none;
}

.search-input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15);
}

.accounts-card-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 600px;
    overflow-y: auto;
    padding-right: 4px;
}

.account-row-card {
    flex-shrink: 0;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-card);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
    overflow: hidden;
    transition: all 0.15s;
}

.account-row-card.border-429 {
    border-color: #fecaca;
}

.account-row-card.border-403 {
    border-color: #ddd6fe;
}

.account-row-card.border-disabled {
    border-color: #cbd5e1;
    background: #fafafa;
}

.account-card-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s;
}

.account-card-header:hover {
    background: var(--bg-body);
}

.acc-header-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.acc-chevron {
    width: 14px;
    height: 14px;
    color: #94a3b8;
    transition: transform 0.2s ease;
}

.acc-chevron.rotated {
    transform: rotate(90deg);
}

.acc-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.dot-healthy {
    background: var(--color-success);
}

.dot-429 {
    background: #ef4444;
}

.dot-403 {
    background: #8b5cf6;
}

.dot-disabled {
    background: var(--text-muted);
}

.dot-unhealthy {
    background: #f59e0b;
}

.acc-index {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-primary);
}

.acc-key {
    font-size: 0.78rem;
    color: var(--text-primary);
}

.acc-badge {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
}

.badge-healthy {
    background: #ecfdf5;
    color: #047857;
    border: 1px solid #a7f3d0;
}

.badge-429 {
    background: #fef2f2;
    color: #b91c1c;
    border: 1px solid #fecaca;
}

.badge-403 {
    background: #f5f3ff;
    color: #6d28d9;
    border: 1px solid #ddd6fe;
}

.badge-persistent-403,
.pill-persistent-403 {
    background: #fff7ed;
    color: #9a3412;
    border: 1px solid #fb923c;
}

.badge-disabled {
    background: var(--bg-list-item-hover);
    color: var(--text-secondary);
    border: 1px solid #cbd5e1;
}

.acc-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
}

.acc-inflight-text {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-right: 4px;
}

.account-card-body {
    padding: 10px 14px;
    border-top: 1px solid var(--bg-list-item-hover);
    background: var(--bg-body);
}

.model-slots-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.model-slot-row {
    padding: 8px 10px;
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.model-slot-row.slot-alert {
    border-color: #fecaca;
}

.slot-row-main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.slot-info {
    display: flex;
    align-items: center;
    gap: 6px;
}

.slot-model-name {
    font-size: 0.75rem;
    color: var(--text-primary);
}

.slot-status-badge {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 4px;
}

.slot-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.72rem;
    color: var(--text-muted);
}

.slot-error-box {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: #fef2f2;
    border: 1px solid #fee2e2;
    border-radius: 4px;
    font-size: 0.7rem;
}

.error-tag {
    color: var(--color-error);
    flex-shrink: 0;
}

.error-msg {
    color: #7f1d1d;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.btn-expand-json {
    background: transparent;
    border: none;
    color: var(--color-error);
    font-size: 0.75rem;
    font-weight: 700;
    cursor: pointer;
    flex-shrink: 0;
    margin-left: auto;
}

.json-code-view {
    background: var(--text-primary);
    color: #34d399;
    padding: 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    max-height: 140px;
    overflow: auto;
    margin: 4px 0 0;
}

/* Helpers */
.font-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.text-warning {
    color: var(--color-warning);
}

.text-error {
    color: var(--color-error);
}

.text-slate-400 {
    color: #94a3b8;
}

.text-slate-500 {
    color: var(--text-muted);
}

.text-slate-600 {
    color: var(--text-secondary);
}

.text-slate-700 {
    color: #334155;
}

.text-center {
    text-align: center;
}

.text-right {
    text-align: right;
}

.line-through {
    text-decoration: line-through;
}

.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scheduler-empty {
    color: #94a3b8;
    font-size: 0.78rem;
    text-align: center;
    padding: 12px 0;
}
</style>
