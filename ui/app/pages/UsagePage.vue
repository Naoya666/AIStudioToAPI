<!--
 * Usage view extracted from StatusPage.vue; API and cursor semantics preserved.
 * Author: Ellinav, iBenzene, bbbugg
-->
<template>
    <div class="view-container">
        <PageHeader :title="t('usageStats')" :description="t('adminUsageDescription')">
            <template #actions>
                <div class="page-meta">
                    <input
                        ref="usageStatsImportInput"
                        type="file"
                        style="display: none"
                        accept=".jsonl"
                        @change="handleUsageStatsImport"
                    />
                    <button
                        class="meta-chip stats-download-button"
                        type="button"
                        :title="t('importUsageStats')"
                        :aria-label="t('importUsageStats')"
                        :disabled="isUsageStatsTransferBusy"
                        @click="triggerUsageStatsImport"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="17 8 12 3 7 8"></polyline>
                            <line x1="12" y1="3" x2="12" y2="15"></line>
                        </svg>
                    </button>
                    <button
                        class="meta-chip stats-download-button"
                        type="button"
                        :title="t('exportUsageStats')"
                        :aria-label="t('exportUsageStats')"
                        :disabled="isUsageStatsTransferBusy"
                        @click="downloadUsageStats"
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                    </button>
                    <span class="meta-chip">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            style="margin-right: 6px; opacity: 0.7"
                        >
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span style="opacity: 0.8; margin-right: 4px">{{ t("startedAt") }}:</span>
                        <span style="font-weight: 600; font-family: monospace">{{
                            formatDateTime(statsState.startedAt)
                        }}</span>
                    </span>
                    <span class="meta-chip">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            style="margin-right: 6px; opacity: 0.7"
                        >
                            <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
                        </svg>
                        <span style="opacity: 0.8; margin-right: 4px">{{ t("uptime") }}:</span>
                        <span style="font-weight: 600; font-family: monospace">{{
                            formatStatsUptime(statsState.startedAt, statsState.summary.uptimeSeconds)
                        }}</span>
                    </span>
                </div>
            </template></PageHeader
        >

        <PageState
            v-if="usageError && !usageLoaded"
            :message="t('adminRefreshFailed')"
            :error="true"
            :retry-label="t('adminRetry')"
            @retry="refresh"
        />
        <PageState v-else-if="!usageLoaded" :message="t('loading')" :loading="true" />
        <template v-if="usageLoaded">
            <section
                class="status-card stats-filters-card"
                :class="{ 'is-collapsed-mobile': isStatsFiltersMobile && statsFiltersCollapsed }"
            >
                <div
                    class="stats-filters-header"
                    :class="{ 'is-collapsible': isStatsFiltersMobile }"
                    :role="isStatsFiltersMobile ? 'button' : null"
                    :tabindex="isStatsFiltersMobile ? 0 : null"
                    :aria-expanded="isStatsFiltersMobile ? String(!statsFiltersCollapsed) : null"
                    @click="toggleStatsFilters"
                    @keydown="handleStatsFiltersHeaderKeydown"
                >
                    <div class="stats-filters-copy">
                        <h3 class="card-title">{{ t("usageFilters") }}</h3>
                    </div>
                    <div v-if="!isStatsFiltersMobile" class="stats-filters-actions">
                        <el-select
                            v-model="timeRange"
                            popper-class="stats-filter-select-dropdown"
                            class="time-range-select stats-time-range-select"
                        >
                            <el-option :label="t('timeRangeAll')" value="all" />
                            <el-option :label="t('timeRange1h')" value="1h" />
                            <el-option :label="t('timeRange6h')" value="6h" />
                            <el-option :label="t('timeRange24h')" value="24h" />
                            <el-option :label="t('timeRange7d')" value="7d" />
                            <el-option :label="t('timeRange30d')" value="30d" />
                            <el-option :label="t('timeRangeCustom')" value="custom" />
                        </el-select>
                        <button
                            class="record-filter-reset"
                            :class="{ 'is-active': hasActiveStatsFilters }"
                            :disabled="!hasActiveStatsFilters"
                            @click.stop="resetRecordFilters"
                        >
                            {{ t("resetFilters") }}
                        </button>
                    </div>
                    <span class="stats-filters-toggle-indicator" :class="{ 'is-collapsed': statsFiltersCollapsed }">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                        >
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </span>
                </div>
                <div v-show="!isStatsFiltersMobile || !statsFiltersCollapsed" class="stats-filters-body">
                    <div v-if="isStatsFiltersMobile" class="stats-filters-actions">
                        <el-select
                            v-model="timeRange"
                            popper-class="stats-filter-select-dropdown"
                            class="time-range-select stats-time-range-select"
                        >
                            <el-option :label="t('timeRangeAll')" value="all" />
                            <el-option :label="t('timeRange1h')" value="1h" />
                            <el-option :label="t('timeRange6h')" value="6h" />
                            <el-option :label="t('timeRange24h')" value="24h" />
                            <el-option :label="t('timeRange7d')" value="7d" />
                            <el-option :label="t('timeRange30d')" value="30d" />
                            <el-option :label="t('timeRangeCustom')" value="custom" />
                        </el-select>
                        <button
                            class="record-filter-reset"
                            :class="{ 'is-active': hasActiveStatsFilters }"
                            :disabled="!hasActiveStatsFilters"
                            @click="resetRecordFilters"
                        >
                            {{ t("resetFilters") }}
                        </button>
                    </div>
                    <div v-if="timeRange === 'custom'" class="stats-custom-range">
                        <span class="stats-custom-range-label">{{ t("customTimeRange") }}</span>
                        <span>{{ t("recordsTimeBasis", { timezone: localTimezone }) }}</span>
                        <el-date-picker
                            v-model="customTimeRange"
                            type="datetimerange"
                            class="stats-custom-range-picker"
                            popper-class="stats-filter-select-dropdown stats-date-range-dropdown"
                            :placement="isStatsFiltersMobile ? 'bottom-start' : 'bottom'"
                            :teleported="!isStatsFiltersMobile"
                            :clearable="false"
                            :default-time="DATE_PICKER_DEFAULT_TIME"
                            :editable="false"
                            :range-separator="'~'"
                            :start-placeholder="t('customTimeRangeStart')"
                            :end-placeholder="t('customTimeRangeEnd')"
                        />
                    </div>
                    <div class="records-filters stats-record-filters">
                        <el-select
                            v-model="recordFilters.apiFormat"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('apiFormat')"
                            class="record-filter-select record-filter-select-custom"
                            @change="handleFilterChange('apiFormat')"
                            @visible-change="v => !v && (filterSearchQuery.apiFormat = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.apiFormat.length === 0 ||
                                            (recordFilters.apiFormat.length === 1 && recordFilters.apiFormat[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("apiFormat", t("apiFormat")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.apiFormat"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.apiFormat }"
                                            @click.stop="filterSearchQuery.apiFormat = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.apiFormats"
                                :key="item"
                                :label="translateLabel(item)"
                                :value="item"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.streamMode"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('streamingMode')"
                            class="record-filter-select record-filter-select-custom"
                            @change="handleFilterChange('streamMode')"
                            @visible-change="v => !v && (filterSearchQuery.streamMode = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.streamMode.length === 0 ||
                                            (recordFilters.streamMode.length === 1 &&
                                                recordFilters.streamMode[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("streamMode", t("streamingMode")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.streamMode"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.streamMode }"
                                            @click.stop="filterSearchQuery.streamMode = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.streamModes"
                                :key="item"
                                :label="translateLabel(item)"
                                :value="item"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.model"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestModel')"
                            class="record-filter-select record-filter-select-wide record-filter-select-custom"
                            @change="handleFilterChange('model')"
                            @visible-change="v => !v && (filterSearchQuery.model = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.model.length === 0 ||
                                            (recordFilters.model.length === 1 && recordFilters.model[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("model", t("requestModel")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.model"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.model }"
                                            @click.stop="filterSearchQuery.model = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.models"
                                :key="item"
                                :label="item === EMPTY_FILTER_VALUE ? t('emptyValue') : item"
                                :value="item"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.outcome"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestOutcome')"
                            class="record-filter-select record-filter-select-custom"
                            @change="handleFilterChange('outcome')"
                            @visible-change="v => !v && (filterSearchQuery.outcome = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.outcome.length === 0 ||
                                            (recordFilters.outcome.length === 1 && recordFilters.outcome[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("outcome", t("requestOutcome")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.outcome"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.outcome }"
                                            @click.stop="filterSearchQuery.outcome = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.outcomes"
                                :key="item"
                                :label="translateLabel(item)"
                                :value="item"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.statusCode"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestStatus')"
                            class="record-filter-select record-filter-select-custom"
                            @change="handleFilterChange('statusCode')"
                            @visible-change="v => !v && (filterSearchQuery.statusCode = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.statusCode.length === 0 ||
                                            (recordFilters.statusCode.length === 1 &&
                                                recordFilters.statusCode[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("statusCode", t("requestStatus")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.statusCode"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.statusCode }"
                                            @click.stop="filterSearchQuery.statusCode = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.statusCodes"
                                :key="item"
                                :label="item === EMPTY_FILTER_VALUE ? t('emptyValue') : String(item)"
                                :value="item === EMPTY_FILTER_VALUE ? item : String(item)"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.finalAccount"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestAccount')"
                            class="record-filter-select record-filter-select-wide record-filter-select-custom"
                            @change="handleFilterChange('finalAccount')"
                            @visible-change="v => !v && (filterSearchQuery.finalAccount = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.finalAccount.length === 0 ||
                                            (recordFilters.finalAccount.length === 1 &&
                                                recordFilters.finalAccount[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("finalAccount", t("requestAccount")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.finalAccount"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.finalAccount }"
                                            @click.stop="filterSearchQuery.finalAccount = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.finalAccounts"
                                :key="item.value"
                                :label="item.label"
                                :value="item.value"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.clientIp"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestIp')"
                            class="record-filter-select record-filter-select-custom"
                            @change="handleFilterChange('clientIp')"
                            @visible-change="v => !v && (filterSearchQuery.clientIp = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.clientIp.length === 0 ||
                                            (recordFilters.clientIp.length === 1 && recordFilters.clientIp[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("clientIp", t("requestIp")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.clientIp"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.clientIp }"
                                            @click.stop="filterSearchQuery.clientIp = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.clientIps"
                                :key="item"
                                :label="item === EMPTY_FILTER_VALUE ? t('emptyValue') : item"
                                :value="item"
                            />
                        </el-select>
                        <el-select
                            v-model="recordFilters.attemptCount"
                            multiple
                            popper-class="stats-filter-select-dropdown"
                            :placeholder="t('requestAttempts')"
                            class="record-filter-select record-filter-select-narrow record-filter-select-custom"
                            @change="handleFilterChange('attemptCount')"
                            @visible-change="v => !v && (filterSearchQuery.attemptCount = '')"
                        >
                            <template #prefix>
                                <span
                                    class="custom-label-text"
                                    :class="{
                                        'is-placeholder-label':
                                            recordFilters.attemptCount.length === 0 ||
                                            (recordFilters.attemptCount.length === 1 &&
                                                recordFilters.attemptCount[0] === ''),
                                    }"
                                >
                                    {{ getFilterLabel("attemptCount", t("requestAttempts")) }}
                                </span>
                            </template>
                            <el-option disabled class="stats-filter-search-option">
                                <el-input
                                    v-model="filterSearchQuery.attemptCount"
                                    :placeholder="t('searchPlaceholder')"
                                    @click.stop
                                >
                                    <template #suffix>
                                        <el-icon
                                            class="stats-search-clear-btn"
                                            :class="{ 'is-visible': filterSearchQuery.attemptCount }"
                                            @click.stop="filterSearchQuery.attemptCount = ''"
                                        >
                                            <CircleClose />
                                        </el-icon>
                                    </template>
                                </el-input>
                            </el-option>
                            <el-option :label="t('timeRangeAll')" value="" />
                            <el-option
                                v-for="item in recordFilterOptions.attemptCounts"
                                :key="item"
                                :label="item === EMPTY_FILTER_VALUE ? t('emptyValue') : String(item)"
                                :value="item === EMPTY_FILTER_VALUE ? item : String(item)"
                            />
                        </el-select>
                    </div>
                </div>
            </section>

            <div class="stats-grid-v2">
                <MetricCard :label="t('requestRecords')" :value="filteredSummary.totalRequests" />
                <MetricCard :label="t('successRate')" :value="filteredSummary.successRate" unit="%" />
                <MetricCard :label="t('avgDuration')" :value="formatDuration(filteredSummary.avgDurationMs)" />
                <MetricCard :label="t('activeRequests')" :value="filteredSummary.activeRequests" />
                <MetricCard :label="t('uniqueAccountPairs')" :value="filteredSummary.uniqueAccountPairs" />
                <MetricCard :label="t('failed')" :value="filteredSummary.failedRequests" :error="true" />
            </div>
            <div class="stats-dashboard-grid">
                <section class="status-card summary-card-visual">
                    <div class="card-header-v2">
                        <h3 class="card-title-usage">{{ t("requestSummary") }}</h3>
                        <div class="summary-total-badge">{{ filteredSummary.totalRequests }} {{ t("total") }}</div>
                    </div>

                    <!-- Visual Progress Bar -->
                    <div class="progress-stacked-root">
                        <div class="progress-info-labels">
                            <span class="label-success">{{ t("success") }}: {{ filteredSummary.successCount }}</span>
                            <span class="label-error">{{ t("failed") }}: {{ filteredSummary.errorCount }}</span>
                            <span class="label-warn">{{ t("aborted") }}: {{ filteredSummary.abortedCount }}</span>
                        </div>
                        <div class="progress-stacked-bar">
                            <div
                                class="bar-segment is-success"
                                :style="{
                                    width:
                                        filteredSummary.totalRequests > 0
                                            ? (filteredSummary.successCount / filteredSummary.totalRequests) * 100 + '%'
                                            : '0%',
                                }"
                                :title="t('success')"
                            ></div>
                            <div
                                class="bar-segment is-error"
                                :style="{
                                    width:
                                        filteredSummary.totalRequests > 0
                                            ? (filteredSummary.errorCount / filteredSummary.totalRequests) * 100 + '%'
                                            : '0%',
                                }"
                                :title="t('failed')"
                            ></div>
                            <div
                                class="bar-segment is-warning"
                                :style="{
                                    width:
                                        filteredSummary.totalRequests > 0
                                            ? (filteredSummary.abortedCount / filteredSummary.totalRequests) * 100 + '%'
                                            : '0%',
                                }"
                                :title="t('aborted')"
                            ></div>
                        </div>
                    </div>

                    <div class="breakdown-grid-v2">
                        <div class="breakdown-block-v2">
                            <h4>{{ t("apiFormat") }}</h4>
                            <div class="breakdown-list-v2">
                                <div
                                    v-for="item in filteredSummary.formatBreakdown"
                                    :key="`format-${item.key}`"
                                    class="modern-chip"
                                >
                                    <span class="chip-dot"></span>
                                    <span class="chip-label">{{ translateLabel(item.key) }}</span>
                                    <span class="chip-count">{{ item.count }}</span>
                                </div>
                            </div>
                        </div>
                        <div class="breakdown-block-v2">
                            <h4>{{ t("streamingMode") }}</h4>
                            <div class="breakdown-list-v2">
                                <div
                                    v-for="item in filteredSummary.streamModeBreakdown"
                                    :key="`streamMode-${item.key}`"
                                    class="modern-chip mode-chip"
                                >
                                    <span class="chip-label">{{ translateLabel(item.key) }}</span>
                                    <span class="chip-count">{{ item.count }}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            <div class="full-width-section">
                <section class="status-card wide-card">
                    <div class="card-header-v2">
                        <h3 class="card-title-usage">{{ t("accountUsageBreakdown") }}</h3>
                    </div>
                    <div v-if="filteredAccounts.length === 0" class="empty-state">
                        {{ t("noUsageStats") }}
                    </div>
                    <div v-else class="table-scroll-wrapper">
                        <table class="data-table fixed-header-table">
                            <thead>
                                <tr>
                                    <th>{{ t("account") }}</th>
                                    <th>{{ t("total") }}</th>
                                    <th>{{ t("success") }}</th>
                                    <th>{{ t("failed") }}</th>
                                    <th>{{ t("aborted") }}</th>
                                    <th>{{ t("successRate") }}</th>
                                    <th>{{ t("avgDuration") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="item in filteredAccounts" :key="item.accountKey">
                                    <td class="account-cell">
                                        {{ formatAccount(item.authIndex, item.accountName) }}
                                    </td>
                                    <td>{{ item.totalRequests }}</td>
                                    <td class="status-ok">{{ item.successCount }}</td>
                                    <td class="status-error">{{ item.errorCount }}</td>
                                    <td class="status-warning">{{ item.abortedCount }}</td>
                                    <td>{{ item.successRate }}%</td>
                                    <td>{{ formatDuration(item.avgDurationMs) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>

                <section class="status-card wide-card">
                    <div class="card-header-v2">
                        <h3 class="card-title-usage">{{ t("modelUsageBreakdown") }}</h3>
                    </div>
                    <div v-if="filteredModels.length === 0" class="empty-state">
                        {{ t("noUsageStats") }}
                    </div>
                    <div v-else class="table-scroll-wrapper">
                        <table class="data-table fixed-header-table">
                            <thead>
                                <tr>
                                    <th>{{ t("requestModel") }}</th>
                                    <th>{{ t("total") }}</th>
                                    <th>{{ t("success") }}</th>
                                    <th>{{ t("failed") }}</th>
                                    <th>{{ t("aborted") }}</th>
                                    <th>{{ t("successRate") }}</th>
                                    <th>{{ t("avgDuration") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="item in filteredModels" :key="item.modelKey">
                                    <td class="account-cell">
                                        {{ item.modelKey === EMPTY_FILTER_VALUE ? t("emptyValue") : item.modelKey }}
                                    </td>
                                    <td>{{ item.totalRequests }}</td>
                                    <td class="status-ok">{{ item.successCount }}</td>
                                    <td class="status-error">{{ item.errorCount }}</td>
                                    <td class="status-warning">{{ item.abortedCount }}</td>
                                    <td>{{ item.successRate }}%</td>
                                    <td>{{ formatDuration(item.avgDurationMs) }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>

            <div class="full-width-section">
                <section class="status-card storage-retention-card">
                    <p :class="{ 'storage-error': storageError }">{{ storageSummary }}</p>
                    <el-button link type="primary" @click="openLogSettings">{{ t("openLogSettings") }}</el-button>
                </section>
            </div>

            <div class="full-width-section">
                <section class="status-card records-card">
                    <div class="card-header-v2">
                        <h3 class="card-title-usage">{{ t("requestRecords") }}</h3>
                        <div class="records-mode-actions">
                            <span v-if="isHistoricalQuery">{{ t("recordsHistoryPaused") }}</span>
                            <el-button v-if="isHistoricalQuery" link type="primary" @click="timeRange = 'all'">{{
                                t("recordsReturnLive")
                            }}</el-button>
                            <span class="records-order">{{ t("recentToOldest") }}</span>
                        </div>
                    </div>
                    <PageState v-if="historyLoading" :loading="true" :message="t('loading')" />
                    <PageState
                        v-else-if="historyError"
                        :error="true"
                        :message="t('recordsHistoryError')"
                        :retry-label="t('adminRetry')"
                        @retry="loadHistoricalRecords"
                    />
                    <div v-else-if="filteredRecords.length === 0" class="empty-state">
                        {{ t("noRequestRecords") }}
                    </div>
                    <div v-else ref="recordsTableWrapper" class="table-scroll-wrapper records-scroll-wrapper">
                        <table class="data-table fixed-header-table">
                            <thead>
                                <tr>
                                    <th>{{ t("requestTime") }}</th>
                                    <th>{{ t("requestId") }}</th>
                                    <th>{{ t("apiFormat") }}</th>
                                    <th>{{ t("streamingMode") }}</th>
                                    <th>{{ t("requestModel") }}</th>
                                    <th>{{ t("requestOutcome") }}</th>
                                    <th>{{ t("requestStatus") }}</th>
                                    <th>{{ t("requestDuration") }}</th>
                                    <th>{{ t("requestAccount") }}</th>
                                    <th>{{ t("requestAttempts") }}</th>
                                    <th>{{ t("requestIp") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="record in paginatedRecords" :key="record.sequence">
                                    <td class="sticky-time-col">{{ formatDateTime(record.startedAt) }}</td>
                                    <td class="mono">
                                        <el-popover trigger="click" placement="top" :width="360">
                                            <template #reference>
                                                <button
                                                    type="button"
                                                    class="record-detail-button"
                                                    :aria-label="t('requestIdDetail')"
                                                >
                                                    {{ shortenRequestId(record.requestId) }}
                                                </button>
                                            </template>
                                            <div class="request-id-detail">{{ record.requestId }}</div>
                                            <el-button link type="primary" @click="copyRequestId(record.requestId)">{{
                                                t("copy")
                                            }}</el-button>
                                        </el-popover>
                                    </td>
                                    <td>{{ translateLabel(record.apiFormat) }}</td>
                                    <td>{{ translateLabel(record.streamMode) }}</td>
                                    <td>{{ record.model || "-" }}</td>
                                    <td>
                                        <span
                                            class="outcome-badge"
                                            :class="`is-${record.outcome}`"
                                            :style="canShowErrorDetail(record) ? 'cursor: pointer' : ''"
                                            :title="canShowErrorDetail(record) ? t('clickToViewError') : ''"
                                            @click="showErrorDetail(record)"
                                        >
                                            {{ translateLabel(record.outcome) }}
                                        </span>
                                    </td>
                                    <td>
                                        <button
                                            v-if="canShowErrorDetail(record)"
                                            type="button"
                                            class="record-detail-button"
                                            :title="t('clickToViewError')"
                                            @click="showErrorDetail(record)"
                                        >
                                            {{ record.statusCode ?? "-" }}
                                        </button>
                                        <span v-else>{{ record.statusCode ?? "-" }}</span>
                                    </td>
                                    <td>{{ formatDuration(record.durationMs) }}</td>
                                    <td>{{ formatAccount(record.finalAuthIndex, record.finalAccountName) }}</td>
                                    <td class="attempts-cell">
                                        <span
                                            class="attempts-count"
                                            :class="{ 'is-clickable': record.attemptCount > 1 }"
                                            :title="record.attemptCount > 1 ? t('clickToViewAttempts') : ''"
                                            @click="record.attemptCount > 1 && showAttemptsDetail(record)"
                                            >{{ record.attemptCount }}</span
                                        >
                                    </td>
                                    <td class="mono truncate-cell">
                                        <el-tooltip
                                            :content="record.clientIp || '-'"
                                            placement="top"
                                            effect="dark"
                                            :hide-after="0"
                                            :show-after="150"
                                            :disabled="!record.clientIp"
                                        >
                                            <span class="request-ip-text">
                                                {{ record.clientIp || "-" }}
                                            </span>
                                        </el-tooltip>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div v-if="filteredRecords.length > 0" class="records-pagination">
                        <div class="records-pagination-summary">
                            <span>{{ t("paginationRange", recordsPaginationRange) }}</span>
                            <label class="records-pagination-size">
                                <span>{{ t("paginationPageSize") }}</span>
                                <select
                                    class="records-pagination-select"
                                    :value="recordsPageSize"
                                    @change="handleRecordsPageSizeChange"
                                >
                                    <option v-for="size in RECORDS_PAGE_SIZE_OPTIONS" :key="size" :value="size">
                                        {{ size }}
                                    </option>
                                </select>
                            </label>
                        </div>
                        <div class="records-pagination-controls">
                            <button
                                class="records-pagination-btn"
                                type="button"
                                :disabled="recordsCurrentPage === 1"
                                @click="setRecordsPage(1)"
                            >
                                {{ t("paginationFirst") }}
                            </button>
                            <button
                                class="records-pagination-btn"
                                type="button"
                                :disabled="recordsCurrentPage === 1"
                                @click="setRecordsPage(recordsCurrentPage - 1)"
                            >
                                {{ t("paginationPrevious") }}
                            </button>
                            <div class="records-pagination-pages">
                                <template v-for="item in recordsPaginationItems" :key="item.key">
                                    <span
                                        v-if="item.type === 'ellipsis'"
                                        class="records-pagination-ellipsis"
                                        aria-hidden="true"
                                    >
                                        ...
                                    </span>
                                    <button
                                        v-else
                                        class="records-pagination-btn records-pagination-page"
                                        :class="{ 'is-active': item.page === recordsCurrentPage }"
                                        type="button"
                                        :aria-current="item.page === recordsCurrentPage ? 'page' : undefined"
                                        @click="setRecordsPage(item.page)"
                                    >
                                        {{ item.page }}
                                    </button>
                                </template>
                            </div>
                            <button
                                class="records-pagination-btn"
                                type="button"
                                :disabled="recordsCurrentPage === recordsTotalPages"
                                @click="setRecordsPage(recordsCurrentPage + 1)"
                            >
                                {{ t("paginationNext") }}
                            </button>
                            <button
                                class="records-pagination-btn"
                                type="button"
                                :disabled="recordsCurrentPage === recordsTotalPages"
                                @click="setRecordsPage(recordsTotalPages)"
                            >
                                {{ t("paginationLast") }}
                            </button>
                            <label class="records-pagination-jump">
                                <span>{{ t("paginationJumpTo") }}</span>
                                <input
                                    v-model="recordsPageJumpInput"
                                    class="records-pagination-input"
                                    type="number"
                                    inputmode="numeric"
                                    min="1"
                                    :max="recordsTotalPages"
                                    @keydown.enter.prevent="submitRecordsPageJump"
                                />
                                <button
                                    class="records-pagination-btn records-pagination-go"
                                    type="button"
                                    @click="submitRecordsPageJump"
                                >
                                    {{ t("paginationGo") }}
                                </button>
                            </label>
                        </div>
                    </div>
                </section>
            </div>
        </template>
    </div>
</template>
<script setup>
import { computed, h, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox, ElNotification } from "element-plus";
import { CircleClose } from "@element-plus/icons-vue";
import PageState from "../components/common/PageState.vue";
import MetricCard from "../components/common/MetricCard.vue";
import PageHeader from "../components/common/PageHeader.vue";
import { useI18n } from "../composables/useI18n";
import { formatDownloadTimestamp } from "../utils/downloadTimestamp";
import escapeHtml from "../utils/escapeHtml";
const { t } = useI18n();
const emit = defineEmits(["open-settings"]);
const openLogSettings = () => emit("open-settings");
const usageStatsImportInput = ref(null);
const usageLoaded = ref(false),
    usageError = ref(false);
const isDownloadingUsageStats = ref(false);
const isImportingUsageStats = ref(false);
const isUsageStatsTransferBusy = computed(() => isDownloadingUsageStats.value || isImportingUsageStats.value);
const storageState = reactive({ enabled: false });
const storageLoaded = ref(false);
const storageError = ref(false);
let storageFetchedAt = 0;

const statsState = reactive({
    accounts: [],
    models: [],
    records: [],
    startedAt: null,
    summary: {
        abortedCount: 0,
        activeRequests: 0,
        avgDurationMs: 0,
        errorCount: 0,
        formatBreakdown: [],
        requestCategoryBreakdown: [],
        streamModeBreakdown: [],
        successCount: 0,
        successRate: 0,
        totalRequests: 0,
        uniqueAccountPairs: 0,
        uptimeSeconds: 0,
    },
});

// Time range filter: 'all' | '1h' | '6h' | '24h' | '7d' | '30d' | 'custom'
const timeRange = ref("all");
const customTimeRange = ref([]);
const recordFilters = reactive({
    apiFormat: [""],
    attemptCount: [""],
    clientIp: [""],
    finalAccount: [""],
    model: [""],
    outcome: [""],
    statusCode: [""],
    streamMode: [""],
});

// Search keywords for internal selection searchboxes
const filterSearchQuery = reactive({
    apiFormat: "",
    attemptCount: "",
    clientIp: "",
    finalAccount: "",
    model: "",
    outcome: "",
    statusCode: "",
    streamMode: "",
});
const recordsTableWrapper = ref(null);
const recordsCurrentPage = ref(1);
const recordsPageSize = ref(10);
const recordsPageJumpInput = ref("");
const RECORDS_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

const STATS_FILTERS_MOBILE_MEDIA_QUERY = "(max-width: 767px)";
const isStatsFiltersMobile = ref(false);
const statsFiltersCollapsed = ref(false);
let statsFiltersMobileMediaQuery = null;

const syncStatsFiltersViewport = mediaQueryList => {
    const isMobile = mediaQueryList.matches;
    const wasMobile = isStatsFiltersMobile.value;

    isStatsFiltersMobile.value = isMobile;

    if (isMobile && !wasMobile) {
        statsFiltersCollapsed.value = true;
    } else if (!isMobile) {
        statsFiltersCollapsed.value = false;
    }
};

const toggleStatsFilters = () => {
    if (!isStatsFiltersMobile.value) return;
    statsFiltersCollapsed.value = !statsFiltersCollapsed.value;
};

const handleStatsFiltersHeaderKeydown = event => {
    if (!isStatsFiltersMobile.value) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggleStatsFilters();
};

const TIME_RANGE_MS = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    all: 0,
};
const DEFAULT_CUSTOM_TIME_RANGE = "24h";
const DATE_PICKER_DEFAULT_TIME = [new Date(2000, 0, 1, 0, 0, 0), new Date(2000, 0, 1, 23, 59, 59)];

const buildRelativeTimeRange = rangeKey => {
    const duration = TIME_RANGE_MS[rangeKey];
    if (!duration) return null;
    const end = new Date();
    return [new Date(end.getTime() - duration), end];
};

const isValidCustomTimeRange = range =>
    Array.isArray(range) &&
    range.length === 2 &&
    range.every(item => item instanceof Date && !Number.isNaN(item.getTime()));

const normalizedCustomTimeRange = computed(() => {
    if (!isValidCustomTimeRange(customTimeRange.value)) return null;
    const [start, end] = customTimeRange.value;
    return start.getTime() <= end.getTime() ? [start, end] : [end, start];
});

const isHistoricalQuery = computed(() => timeRange.value === "custom" && !!normalizedCustomTimeRange.value);
const historicalRecords = ref([]);
const historyLoading = ref(false);
const historyError = ref(false);
let historyController = null;
const loadHistoricalRecords = async () => {
    historyController?.abort();
    historicalRecords.value = [];
    historyError.value = false;
    if (!isHistoricalQuery.value) {
        historyLoading.value = false;
        return;
    }
    const controller = new AbortController();
    historyController = controller;
    historyLoading.value = true;
    const [start, end] = normalizedCustomTimeRange.value;
    const params = new URLSearchParams({ from: start.toISOString(), limit: "100", to: end.toISOString() });
    const records = [];
    try {
        let revision = null;
        do {
            const response = await fetch(`/api/usage-stats/records?${params}`, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.reset || (revision !== null && revision !== data.dataset_revision)) {
                throw new Error("Usage dataset changed during historical query");
            }
            revision = data.dataset_revision;
            records.push(...(data.records || []));
            if (!data.has_more) break;
            if (!data.next_cursor) throw new Error("Missing historical records cursor");
            params.set("cursor", data.next_cursor);
        } while (!controller.signal.aborted);
        if (!controller.signal.aborted) {
            historicalRecords.value = records.sort(
                (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.sequence - a.sequence
            );
        }
    } catch (error) {
        if (!controller.signal.aborted) historyError.value = true;
    } finally {
        if (historyController === controller) historyLoading.value = false;
    }
};

const EMPTY_FILTER_VALUE = "__EMPTY__";
const isEmptyFilterField = value =>
    value === null || value === undefined || (typeof value === "string" && !value.trim());
const isFilterArrayActive = filterArray =>
    Array.isArray(filterArray) && !(filterArray.length === 0 || (filterArray.length === 1 && filterArray[0] === ""));

const formatAccountValue = (authIndex, accountName) => `${authIndex ?? "unknown"}::${accountName ?? ""}`;
const getAccountFilterValue = (authIndex, accountName) => {
    if (authIndex === null || authIndex === undefined) {
        return isEmptyFilterField(accountName) ? EMPTY_FILTER_VALUE : formatAccountValue(authIndex, accountName);
    }
    return formatAccountValue(authIndex, accountName);
};
const getAccountStatsKey = (authIndex, accountName) => {
    if (authIndex === null || authIndex === undefined) {
        return isEmptyFilterField(accountName) ? "unassigned" : `unassigned:${accountName}`;
    }
    return `${authIndex}:${isEmptyFilterField(accountName) ? "N/A" : accountName}`;
};

const timeFilteredRecords = computed(() => {
    if (timeRange.value === "all") return statsState.records;
    if (isHistoricalQuery.value) return historicalRecords.value;
    const items = TIME_RANGE_MS[timeRange.value];
    if (!items) return statsState.records;
    const cutoff = Date.now() - items;
    return statsState.records.filter(r => {
        const ts = r.startedAt ? new Date(r.startedAt).getTime() : 0;
        return ts >= cutoff;
    });
});

const recordFilterOptions = computed(() => {
    // Stage 1: Get all valid combinations based on internal cascading logic
    const baseOptions = {
        apiFormats: new Set(),
        attemptCounts: new Set(),
        clientIps: new Set(),
        finalAccounts: new Map(), // value -> label
        models: new Set(),
        outcomes: new Set(),
        statusCodes: new Set(),
        streamModes: new Set(),
    };

    const records = timeFilteredRecords.value;
    const filters = recordFilters;

    records.forEach(record => {
        if (isRecordMatched(record, filters, "apiFormat"))
            baseOptions.apiFormats.add(isEmptyFilterField(record.apiFormat) ? EMPTY_FILTER_VALUE : record.apiFormat);
        if (isRecordMatched(record, filters, "streamMode"))
            baseOptions.streamModes.add(isEmptyFilterField(record.streamMode) ? EMPTY_FILTER_VALUE : record.streamMode);
        if (isRecordMatched(record, filters, "model"))
            baseOptions.models.add(isEmptyFilterField(record.model) ? EMPTY_FILTER_VALUE : record.model);
        if (isRecordMatched(record, filters, "outcome"))
            baseOptions.outcomes.add(isEmptyFilterField(record.outcome) ? EMPTY_FILTER_VALUE : record.outcome);
        if (isRecordMatched(record, filters, "statusCode"))
            baseOptions.statusCodes.add(
                record.statusCode !== null && record.statusCode !== undefined ? record.statusCode : EMPTY_FILTER_VALUE
            );
        if (isRecordMatched(record, filters, "clientIp"))
            baseOptions.clientIps.add(isEmptyFilterField(record.clientIp) ? EMPTY_FILTER_VALUE : record.clientIp);
        if (isRecordMatched(record, filters, "attemptCount"))
            baseOptions.attemptCounts.add(
                record.attemptCount !== null && record.attemptCount !== undefined
                    ? record.attemptCount
                    : EMPTY_FILTER_VALUE
            );
        if (isRecordMatched(record, filters, "finalAccount")) {
            const val = getAccountFilterValue(record.finalAuthIndex, record.finalAccountName);
            if (!baseOptions.finalAccounts.has(val)) {
                baseOptions.finalAccounts.set(
                    val,
                    val === EMPTY_FILTER_VALUE
                        ? t("emptyValue")
                        : formatAccount(record.finalAuthIndex, record.finalAccountName)
                );
            }
        }
    });

    // Stage 2: Helper to sort and apply internal search keywords from the top search bars
    const applySearchAndSort = (items, query, getLabel = null, isNumeric = false) => {
        let list = Array.from(items);

        // Filter by keyword
        if (query) {
            const q = query.toLowerCase();
            list = list.filter(item => {
                const label = getLabel ? getLabel(item) : String(item);
                return label.toLowerCase().includes(q);
            });
        }

        // Sort
        return list.sort((a, b) => {
            if (a === EMPTY_FILTER_VALUE) return -1;
            if (b === EMPTY_FILTER_VALUE) return 1;
            if (isNumeric) return Number(a) - Number(b);
            const labelA = getLabel ? getLabel(a) : String(a);
            const labelB = getLabel ? getLabel(b) : String(b);
            return labelA.localeCompare(labelB);
        });
    };

    return {
        apiFormats: applySearchAndSort(baseOptions.apiFormats, filterSearchQuery.apiFormat, translateLabel),
        attemptCounts: applySearchAndSort(
            baseOptions.attemptCounts,
            filterSearchQuery.attemptCount,
            item => (item === EMPTY_FILTER_VALUE ? t("emptyValue") : String(item)),
            true
        ),
        clientIps: applySearchAndSort(baseOptions.clientIps, filterSearchQuery.clientIp, item =>
            item === EMPTY_FILTER_VALUE ? t("emptyValue") : item
        ),
        finalAccounts: applySearchAndSort(
            Array.from(baseOptions.finalAccounts.keys()),
            filterSearchQuery.finalAccount,
            val => baseOptions.finalAccounts.get(val)
        ).map(val => ({
            label: baseOptions.finalAccounts.get(val),
            value: val,
        })),
        models: applySearchAndSort(baseOptions.models, filterSearchQuery.model, item =>
            item === EMPTY_FILTER_VALUE ? t("emptyValue") : item
        ),
        outcomes: applySearchAndSort(baseOptions.outcomes, filterSearchQuery.outcome, translateLabel),
        statusCodes: applySearchAndSort(
            baseOptions.statusCodes,
            filterSearchQuery.statusCode,
            item => (item === EMPTY_FILTER_VALUE ? t("emptyValue") : String(item)),
            true
        ),
        streamModes: applySearchAndSort(baseOptions.streamModes, filterSearchQuery.streamMode, translateLabel),
    };
});

const hasActiveStatsFilters = computed(
    () => timeRange.value !== "all" || Object.values(recordFilters).some(value => isFilterArrayActive(value))
);

// Computed: records filtered by time range + record filters (records are newest-first)
// Helper to check if a record matches current filters, optionally excluding one field for cascading filters
const isRecordMatched = (record, filters, excludeField = null) => {
    const checkMatch = (fieldValue, filterArray) => {
        // If filters are empty or only contains "All" (""), pass everything
        if (!filterArray || filterArray.length === 0 || filterArray.includes("")) return true;

        // Handle multiple selections
        const normalizedActualValue = isEmptyFilterField(fieldValue) ? EMPTY_FILTER_VALUE : fieldValue;

        // Check if the actual value matches any of the selected filter values
        return filterArray.some(v => String(v) === String(normalizedActualValue));
    };

    if (excludeField !== "apiFormat" && !checkMatch(record.apiFormat, filters.apiFormat)) return false;
    if (excludeField !== "streamMode" && !checkMatch(record.streamMode, filters.streamMode)) return false;
    if (excludeField !== "model" && !checkMatch(record.model, filters.model)) return false;
    if (excludeField !== "outcome" && !checkMatch(record.outcome, filters.outcome)) return false;
    if (excludeField !== "statusCode" && !checkMatch(record.statusCode, filters.statusCode)) return false;
    if (excludeField !== "clientIp" && !checkMatch(record.clientIp, filters.clientIp)) return false;
    if (excludeField !== "attemptCount" && !checkMatch(record.attemptCount, filters.attemptCount)) return false;

    if (
        excludeField !== "finalAccount" &&
        filters.finalAccount &&
        filters.finalAccount.length > 0 &&
        !filters.finalAccount.includes("")
    ) {
        const accVal = getAccountFilterValue(record.finalAuthIndex, record.finalAccountName);
        if (!filters.finalAccount.includes(accVal)) return false;
    }

    return true;
};

const filteredRecords = computed(() => {
    return timeFilteredRecords.value.filter(record => isRecordMatched(record, recordFilters));
});

const recordsTotalPages = computed(() => Math.max(1, Math.ceil(filteredRecords.value.length / recordsPageSize.value)));

const clampRecordsPage = page => {
    const normalizedPage = Number(page);
    if (!Number.isFinite(normalizedPage)) return 1;
    return Math.min(Math.max(Math.trunc(normalizedPage), 1), recordsTotalPages.value);
};

const setRecordsPage = page => {
    recordsCurrentPage.value = clampRecordsPage(page);
    recordsPageJumpInput.value = "";
};

const paginatedRecords = computed(() => {
    const startIndex = (recordsCurrentPage.value - 1) * recordsPageSize.value;
    return filteredRecords.value.slice(startIndex, startIndex + recordsPageSize.value);
});

const recordsPaginationRange = computed(() => {
    const total = filteredRecords.value.length;
    if (!total) return { end: 0, start: 0, total: 0 };

    const start = (recordsCurrentPage.value - 1) * recordsPageSize.value + 1;
    const end = Math.min(start + paginatedRecords.value.length - 1, total);
    return { end, start, total };
});

const buildRecordsPaginationItems = (currentPage, totalPages, siblingCount = 1, boundaryCount = 1) => {
    if (totalPages <= 0) return [];

    const visiblePages = new Set();

    for (let offset = 0; offset < boundaryCount; offset += 1) {
        visiblePages.add(offset + 1);
        visiblePages.add(totalPages - offset);
    }

    for (let page = currentPage - siblingCount; page <= currentPage + siblingCount; page += 1) {
        visiblePages.add(page);
    }

    const sortedPages = Array.from(visiblePages)
        .filter(page => page >= 1 && page <= totalPages)
        .sort((a, b) => a - b);

    const items = [];
    let previousPage = 0;

    sortedPages.forEach(page => {
        if (previousPage) {
            if (page - previousPage === 2) {
                items.push({ key: `page-${previousPage + 1}`, page: previousPage + 1, type: "page" });
            } else if (page - previousPage > 2) {
                items.push({ key: `ellipsis-${previousPage}-${page}`, type: "ellipsis" });
            }
        }

        items.push({ key: `page-${page}`, page, type: "page" });
        previousPage = page;
    });

    return items;
};

const recordsPaginationItems = computed(() =>
    buildRecordsPaginationItems(recordsCurrentPage.value, recordsTotalPages.value)
);

const recordsPaginationResetKey = computed(() =>
    [
        timeRange.value,
        normalizedCustomTimeRange.value ? normalizedCustomTimeRange.value.map(item => item.getTime()).join("|") : "",
        recordFilters.apiFormat.join("|"),
        recordFilters.attemptCount.join("|"),
        recordFilters.clientIp.join("|"),
        recordFilters.finalAccount.join("|"),
        recordFilters.model.join("|"),
        recordFilters.outcome.join("|"),
        recordFilters.statusCode.join("|"),
        recordFilters.streamMode.join("|"),
    ].join("::")
);

// Computed: summary recalculated from filtered records
const filteredSummary = computed(() => {
    if (!hasActiveStatsFilters.value) {
        return {
            ...statsState.summary,
            failedRequests: statsState.summary.errorCount,
            streamModeBreakdown: statsState.summary.streamModeBreakdown || [],
        };
    }
    const records = filteredRecords.value;
    if (!records.length) {
        return {
            abortedCount: 0,
            activeRequests: statsState.summary.activeRequests,
            avgDurationMs: 0,
            errorCount: 0,
            failedRequests: 0,
            formatBreakdown: [],
            requestCategoryBreakdown: [],
            streamModeBreakdown: [],
            successCount: 0,
            successRate: 0,
            totalRequests: 0,
            uniqueAccountPairs: 0,
        };
    }
    const totalRequests = records.length;
    const successCount = records.filter(r => r.outcome === "success").length;
    const errorCount = records.filter(r => r.outcome === "error").length;
    const abortedCount = records.filter(r => r.outcome === "aborted").length;
    const failedRequests = errorCount;
    const totalDurationMs = records.reduce((sum, r) => sum + (r.durationMs || 0), 0);
    const avgDurationMs = totalRequests > 0 ? Math.round(totalDurationMs / totalRequests) : 0;
    const successRate = totalRequests > 0 ? Number(((successCount / totalRequests) * 100).toFixed(1)) : 0;

    // Build per-format and per-category breakdowns from filtered records
    const formatCounts = {};
    const categoryCounts = {};
    const streamModeCounts = {};
    records.forEach(r => {
        const fmt = isEmptyFilterField(r.apiFormat) ? EMPTY_FILTER_VALUE : r.apiFormat;
        formatCounts[fmt] = (formatCounts[fmt] || 0) + 1;
        const cat = r.requestCategory || "unknown";
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
        const sm = isEmptyFilterField(r.streamMode) ? EMPTY_FILTER_VALUE : r.streamMode;
        streamModeCounts[sm] = (streamModeCounts[sm] || 0) + 1;
    });
    const formatBreakdown = Object.entries(formatCounts)
        .map(([key, count]) => ({ count, key }))
        .sort((a, b) => b.count - a.count);
    const requestCategoryBreakdown = Object.entries(categoryCounts)
        .map(([key, count]) => ({ count, key }))
        .sort((a, b) => b.count - a.count);
    const streamModeBreakdown = Object.entries(streamModeCounts)
        .map(([key, count]) => ({ count, key }))
        .sort((a, b) => b.count - a.count);

    // Unique account pairs from filtered records, aligned with backend accountKey semantics
    const uniqueAccounts = new Set(
        records.map(r => r.accountKey || getAccountStatsKey(r.finalAuthIndex, r.finalAccountName))
    );

    return {
        abortedCount,
        activeRequests: statsState.summary.activeRequests,
        avgDurationMs,
        errorCount,
        failedRequests,
        formatBreakdown,
        requestCategoryBreakdown,
        streamModeBreakdown,
        successCount,
        successRate,
        totalRequests,
        uniqueAccountPairs: uniqueAccounts.size,
    };
});

// Computed: per-account stats recalculated from filtered records
const filteredAccounts = computed(() => {
    if (!hasActiveStatsFilters.value) return statsState.accounts;
    const records = filteredRecords.value;
    if (!records.length) return [];
    const accountMap = {};
    records.forEach(r => {
        const key = r.accountKey || getAccountStatsKey(r.finalAuthIndex, r.finalAccountName);
        if (!accountMap[key]) {
            accountMap[key] = {
                abortedCount: 0,
                accountKey: key,
                accountName: r.finalAccountName,
                authIndex: r.finalAuthIndex,
                errorCount: 0,
                modelCounts: {},
                successCount: 0,
                totalDurationMs: 0,
                totalRequests: 0,
            };
        }
        const acc = accountMap[key];
        acc.totalRequests += 1;
        acc.totalDurationMs += r.durationMs || 0;
        if (r.outcome === "success") acc.successCount += 1;
        else if (r.outcome === "aborted") acc.abortedCount += 1;
        else acc.errorCount += 1;

        const mk = isEmptyFilterField(r.model) ? EMPTY_FILTER_VALUE : r.model;
        if (!acc.modelCounts[mk]) {
            acc.modelCounts[mk] = { error: 0, total: 0 };
        }
        acc.modelCounts[mk].total += 1;
        if (r.outcome === "error") {
            acc.modelCounts[mk].error += 1;
        }
    });

    return Object.values(accountMap)
        .map(acc => ({
            ...acc,
            avgDurationMs: acc.totalRequests > 0 ? Math.round(acc.totalDurationMs / acc.totalRequests) : 0,
            modelCounts: Object.entries(acc.modelCounts)
                .map(([key, stats]) => ({
                    count: stats.total,
                    error: stats.error,
                    key,
                }))
                .sort((a, b) => b.count - a.count),
            successRate: acc.totalRequests > 0 ? Number(((acc.successCount / acc.totalRequests) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.totalRequests - a.totalRequests);
});

const filteredModels = computed(() => {
    if (!hasActiveStatsFilters.value) return statsState.models;
    const records = filteredRecords.value;
    if (!records.length) return [];

    const modelMap = {};
    records.forEach(r => {
        const modelKey = isEmptyFilterField(r.model) ? EMPTY_FILTER_VALUE : r.model;
        if (!modelMap[modelKey]) {
            modelMap[modelKey] = {
                abortedCount: 0,
                accountCounts: {},
                errorCount: 0,
                modelKey,
                successCount: 0,
                totalDurationMs: 0,
                totalRequests: 0,
            };
        }

        const model = modelMap[modelKey];
        model.totalRequests += 1;
        model.totalDurationMs += r.durationMs || 0;
        if (r.outcome === "success") model.successCount += 1;
        else if (r.outcome === "aborted") model.abortedCount += 1;
        else model.errorCount += 1;

        const accountKey = r.accountKey || getAccountStatsKey(r.finalAuthIndex, r.finalAccountName);
        if (!model.accountCounts[accountKey]) {
            model.accountCounts[accountKey] = {
                accountName: r.finalAccountName,
                authIndex: r.finalAuthIndex,
                error: 0,
                total: 0,
            };
        }

        model.accountCounts[accountKey].total += 1;
        if (r.outcome === "error") {
            model.accountCounts[accountKey].error += 1;
        }
    });

    return Object.values(modelMap)
        .map(model => ({
            ...model,
            accountCounts: Object.entries(model.accountCounts)
                .map(([key, stats]) => ({
                    accountName: stats.accountName,
                    authIndex: stats.authIndex,
                    count: stats.total,
                    error: stats.error,
                    key,
                }))
                .sort((a, b) => b.count - a.count),
            avgDurationMs: model.totalRequests > 0 ? Math.round(model.totalDurationMs / model.totalRequests) : 0,
            successRate:
                model.totalRequests > 0 ? Number(((model.successCount / model.totalRequests) * 100).toFixed(1)) : 0,
        }))
        .sort((a, b) => b.totalRequests - a.totalRequests);
});

const translateLabel = value => {
    if (!value) return "-";
    if (value === EMPTY_FILTER_VALUE) return t("emptyValue");
    // Map backend identifiers to user-facing i18n keys
    const keyMap = {
        count_tokens: "countTokens",
        early: "earlyStream",
        fake: "fakeStream",
        non: "nonStream",
        real: "realStream",
        response_api: "responseApi",
    };
    const keyToTranslate = keyMap[value] || (value === "error" ? "failed" : value);
    const translated = t(keyToTranslate);
    return translated === keyToTranslate ? value : translated;
};

const formatDateTime = value => {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
};

const formatDuration = value => {
    const duration = Number(value);
    if (!Number.isFinite(duration)) return "-";
    if (duration < 1000) return `${duration} ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(1)} s`;
    return `${(duration / 60000).toFixed(1)} min`;
};

const formatUptime = seconds => {
    const total = Number(seconds);
    if (!Number.isFinite(total)) return "-";
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(" ");
};

const formatStatsUptime = (startedAt, seconds) => {
    if (!startedAt) return "-";
    return formatUptime(seconds);
};

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const storageSummary = computed(() => {
    if (storageError.value) return t("storageLoadFailed");
    if (!storageLoaded.value) return t("loading");
    if (!storageState.enabled) return t("usageStatsDisabled");
    if (storageState.retention_mode === "forever") return t("retentionSummaryForever");
    return t("retentionSummary", { days: storageState.retention_days, minutes: storageState.cleanup_interval_minutes });
});
const fetchStorageState = async signal => {
    if (Date.now() - storageFetchedAt < 30000) return;
    try {
        const res = await fetch("/api/usage-stats/storage", { signal });
        if (res.status === 304) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        Object.keys(storageState).forEach(key => delete storageState[key]);
        Object.assign(storageState, data);
        storageLoaded.value = true;
        storageError.value = false;
        storageFetchedAt = Date.now();
    } catch (error) {
        if (error.name === "AbortError") throw error;
        storageError.value = true;
    }
};

const formatAccount = (authIndex, accountName) => {
    if (authIndex === null || authIndex === undefined) {
        return accountName || "-";
    }
    return `#${authIndex} ${accountName || "N/A"}`;
};
let latestUsageSequence = null;
let usageDatasetRevision = null;
let recordsGeneration = 0;
const fetchUsageStats = async (signal, includeRecords = true) => {
    const summaryPromise = fetch("/api/usage-stats/summary", { signal });
    let recordsPromise = null;
    const wasHistorical = isHistoricalQuery.value;
    const generation = recordsGeneration;
    if (includeRecords && !wasHistorical) {
        const after =
            latestUsageSequence === null
                ? ""
                : `&after_sequence=${latestUsageSequence}&dataset_revision=${usageDatasetRevision}`;
        recordsPromise = fetch(`/api/usage-stats/records?limit=100${after}`, { signal });
    }
    const [summaryRes, recordsRes] = await Promise.all([summaryPromise, recordsPromise, fetchStorageState(signal)]);
    const res = summaryRes;
    if (res.redirected) {
        window.location.href = res.url;
        return;
    }
    if (res.status === 401) {
        window.location.href = "/login";
        return;
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    if (recordsRes && !recordsRes.ok) throw new Error(`HTTP ${recordsRes.status}`);
    const data = await res.json();
    const recordsData = recordsRes ? await recordsRes.json() : null;
    statsState.accounts = data.accounts || [];
    statsState.models = data.models || [];
    if (recordsData && !isHistoricalQuery.value && !wasHistorical && generation === recordsGeneration) {
        if (usageDatasetRevision !== recordsData.dataset_revision || latestUsageSequence === null) {
            statsState.records = recordsData.records || [];
        } else if (recordsData.records?.length) {
            const existing = new Set(statsState.records.map(record => record.sequence));
            statsState.records = [
                ...recordsData.records.filter(record => !existing.has(record.sequence)),
                ...statsState.records,
            ];
        }
        usageDatasetRevision = recordsData.dataset_revision;
        latestUsageSequence = recordsData.latest_sequence ?? latestUsageSequence;
    }
    statsState.startedAt = data.startedAt || null;
    statsState.summary = {
        ...statsState.summary,
        ...(data.summary || {}),
    };
};

const shortenRequestId = value => {
    if (!value) return "-";
    return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
};
const copyRequestId = async value => {
    try {
        await navigator.clipboard.writeText(value);
        ElMessage.success(t("copySuccess"));
    } catch {
        ElMessage.error(t("copyFailed"));
    }
};

const showErrorDetail = record => {
    if (!canShowErrorDetail(record)) return;
    ElMessageBox.alert(record.errorMessage || t("errorUnknown"), t("errorDetailTitle"), {
        closeOnClickModal: true,
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "error",
    });
};

const canShowErrorDetail = record =>
    !!record && (record.outcome === "error" || record.outcome === "aborted") && !!record.errorMessage;

const showAttemptsDetail = record => {
    if (!record || !record.attempts || record.attempts.length === 0) return;
    const rows = record.attempts.map((item, index) => {
        const colonIdx = (item.accountKey || "").indexOf(":");
        const authIndex = colonIdx === -1 ? null : Number((item.accountKey || "").slice(0, colonIdx));
        const accountName = colonIdx === -1 ? item.accountKey || "" : (item.accountKey || "").slice(colonIdx + 1);
        return h(
            "div",
            {
                style: "display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 14px;",
            },
            [
                h(
                    "span",
                    {
                        style: "display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; border-radius: 50%; background: #409eff; color: #fff; font-size: 12px; font-weight: 700; flex-shrink: 0;",
                    },
                    String(index + 1)
                ),
                h("span", { style: "color: #606266;" }, `#${authIndex} ${accountName}`),
            ]
        );
    });

    const content = h("div", { style: "padding: 4px 0;" }, rows);

    ElMessageBox({
        closeOnClickModal: true,
        confirmButtonText: t("ok"),
        lockScroll: false,
        message: content,
        title: t("attemptsPathTitle"),
    });
};

const resetRecordFilters = () => {
    timeRange.value = "all";
    customTimeRange.value = [];
    recordFilters.apiFormat = [""];
    recordFilters.attemptCount = [""];
    recordFilters.clientIp = [""];
    recordFilters.finalAccount = [""];
    recordFilters.model = [""];
    recordFilters.outcome = [""];
    recordFilters.statusCode = [""];
    recordFilters.streamMode = [""];
};

watch(
    timeRange,
    (newValue, oldValue) => {
        if (newValue !== "custom") return;
        if (normalizedCustomTimeRange.value) return;
        customTimeRange.value =
            buildRelativeTimeRange(oldValue) || buildRelativeTimeRange(DEFAULT_CUSTOM_TIME_RANGE) || [];
    },
    { flush: "sync" }
);

watch(
    () => (isHistoricalQuery.value ? normalizedCustomTimeRange.value.map(item => item.toISOString()).join("|") : ""),
    async (range, previous) => {
        recordsGeneration++;
        await loadHistoricalRecords();
        if (!range && previous) {
            latestUsageSequence = null;
            usageDatasetRevision = null;
            try {
                await fetchUsageStats();
            } catch (error) {
                if (error.name !== "AbortError") usageError.value = true;
            }
        }
    }
);

watch(
    [() => filteredRecords.value.length, recordsPageSize],
    () => {
        const nextPage = clampRecordsPage(recordsCurrentPage.value);
        if (nextPage !== recordsCurrentPage.value) {
            recordsCurrentPage.value = nextPage;
        }
    },
    { flush: "sync" }
);

watch(recordsPaginationResetKey, () => {
    recordsCurrentPage.value = 1;
    recordsPageJumpInput.value = "";
});

watch(
    recordsCurrentPage,
    async () => {
        await nextTick();
        if (recordsTableWrapper.value) {
            recordsTableWrapper.value.scrollTop = 0;
        }
    },
    { flush: "post" }
);

const handleRecordsPageSizeChange = event => {
    const nextSize = Number(event?.target?.value);
    if (!Number.isFinite(nextSize) || nextSize <= 0) return;

    const firstVisibleIndex = (recordsCurrentPage.value - 1) * recordsPageSize.value;
    recordsPageSize.value = nextSize;
    recordsCurrentPage.value = Math.floor(firstVisibleIndex / nextSize) + 1;
    recordsPageJumpInput.value = "";
};

const submitRecordsPageJump = () => {
    if (!recordsPageJumpInput.value) return;
    setRecordsPage(recordsPageJumpInput.value);
};

const getFilterLabel = (field, placeholder) => {
    const selected = recordFilters[field];

    // If empty or only "All" is selected, return the placeholder text
    if (selected.length === 0 || (selected.length === 1 && selected[0] === "")) {
        return placeholder;
    }

    if (selected.length === 1) {
        const val = selected[0];
        // Special case for finalAccount which is an array of objects
        if (field === "finalAccount") {
            const found = recordFilterOptions.value.finalAccounts.find(opt => opt.value === val);
            return found ? found.label : val;
        }

        // Use translateLabel for specific fields that need i18n
        if (["apiFormat", "streamMode", "outcome"].includes(field)) {
            return translateLabel(val);
        }

        // Others are simple strings or numbers
        return val === EMPTY_FILTER_VALUE ? t("emptyValue") : String(val);
    }
    return t("selectedCount", { count: selected.length });
};

const handleFilterChange = field => {
    const selected = recordFilters[field];

    if (selected.length === 0) {
        // If nothing is selected, default back to "All"
        recordFilters[field] = [""];
    } else if (selected.length > 1) {
        // If "All" was previously selected and a specific item is added, remove "All"
        const hasAll = selected.includes("");
        const lastSelected = selected[selected.length - 1];

        if (lastSelected === "") {
            // If "All" was just clicked, clear everything else
            recordFilters[field] = [""];
        } else if (hasAll) {
            // If specific items were clicked while "All" was selected, remove "All"
            recordFilters[field] = selected.filter(v => v !== "");
        }
    }
};

const readFileAsText = file =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error(t("fileReadFailed")));
        reader.readAsText(file);
    });

const triggerUsageStatsImport = () => {
    if (isUsageStatsTransferBusy.value) return;

    ElMessageBox.confirm(t("usageStatsImportConfirm"), t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => usageStatsImportInput.value?.click())
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const handleUsageStatsImport = async event => {
    const [file] = Array.from(event.target.files || []);
    event.target.value = "";
    if (!file) return;
    if (isUsageStatsTransferBusy.value) return;

    if (!file.name.toLowerCase().endsWith(".jsonl")) {
        ElMessage.error(t("usageStatsImportJsonlOnly"));
        return;
    }

    isImportingUsageStats.value = true;
    try {
        const content = await readFileAsText(file);
        const res = await fetch("/api/usage-stats/import", {
            body: JSON.stringify({ content, filename: file.name }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });

        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showUsageStatsImportNotification({
                message: t(data.message || "usageStatsImportFailed", { error: data.error || `HTTP ${res.status}` }),
                title: t("usageStatsImportResult"),
                type: "error",
            });
            return;
        }

        showUsageStatsImportNotification({
            message: t("usageStatsImportSuccess", data),
            title: t("usageStatsImportResult"),
            type: "success",
        });
        await fetchUsageStats();
    } catch (error) {
        showUsageStatsImportNotification({
            message: t("usageStatsImportFailed", { error: error.message }),
            title: t("usageStatsImportResult"),
            type: "error",
        });
    } finally {
        isImportingUsageStats.value = false;
    }
};

const showUsageStatsImportNotification = ({ message, title, type }) => {
    ElNotification({
        dangerouslyUseHTMLString: true,
        duration: 0,
        message: `<div style="max-height: 50vh; overflow-y: auto; word-break: break-word;">${escapeHtml(message)}</div>`,
        position: "top-right",
        title,
        type,
    });
};

// Download persisted usage stats JSONL
const downloadUsageStats = async () => {
    if (isUsageStatsTransferBusy.value) return;
    isDownloadingUsageStats.value = true;

    try {
        const res = await fetch("/api/usage-stats/download?check=1");
        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (!res.ok) {
            let message = "usageStatsDownloadFailed";
            try {
                const data = await res.json();
                message = data.message || message;
                ElMessage.error(t(message, { error: data.error || `HTTP ${res.status}` }));
                return;
            } catch {
                // Ignore non-JSON error responses.
            }
            ElMessage.error(t(message, { error: `HTTP ${res.status}` }));
            return;
        }

        const filename = `AIStudioToAPI_usage-stats_${formatDownloadTimestamp()}.jsonl`;
        const a = document.createElement("a");
        a.href = "/api/usage-stats/download";
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    } catch (error) {
        ElMessage.error(t("usageStatsDownloadFailed", { error: error.message }));
    } finally {
        isDownloadingUsageStats.value = false;
    }
};

// The workspace owns the polling loop and AbortController; usage owns filters and records.
const refresh = async signal => {
    if (!(signal instanceof AbortSignal)) signal = undefined;
    try {
        await fetchUsageStats(signal, recordsCurrentPage.value === 1);
        usageLoaded.value = true;
        usageError.value = false;
    } catch (error) {
        if (error.name !== "AbortError") usageError.value = true;
        throw error;
    }
};
defineExpose({
    invalidateStorage: () => {
        storageFetchedAt = 0;
    },
    refresh,
});
onMounted(() => {
    statsFiltersMobileMediaQuery = window.matchMedia(STATS_FILTERS_MOBILE_MEDIA_QUERY);
    syncStatsFiltersViewport(statsFiltersMobileMediaQuery);
    statsFiltersMobileMediaQuery.addEventListener("change", syncStatsFiltersViewport);
});
onBeforeUnmount(() => {
    historyController?.abort();
    if (statsFiltersMobileMediaQuery) {
        statsFiltersMobileMediaQuery.removeEventListener("change", syncStatsFiltersViewport);
    }
});
</script>
<style lang="less" scoped>
@import "../styles/variables.less";

.record-detail-button {
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-primary);
    font: inherit;
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
}
.request-id-detail {
    overflow-wrap: anywhere;
    font-family: monospace;
    margin-bottom: 8px;
}
.records-mode-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}
.card-title {
    font-size: 16px;
    margin: 0;
}
.status-card {
    background: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 20px;
    min-width: 0;
}
.storage-retention-grid {
    display: grid;
    grid-template-columns: minmax(100px, 140px) minmax(0, 1fr);
    gap: 12px 20px;
}
.storage-retention-grid strong {
    overflow-wrap: anywhere;
}
.storage-retention-note {
    color: var(--text-secondary);
    font-size: 12px;
    margin-top: 12px;
}
.storage-error,
.status-error {
    color: var(--color-error);
}
.status-ok {
    color: var(--color-success);
}
.status-warning {
    color: var(--color-warning);
}
@media (max-width: 767px) {
    .status-card {
        padding: 16px;
    }
    .storage-retention-grid {
        grid-template-columns: 1fr;
    }
}
/* Stats View Styles */
.stats-grid-v2 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.card-header-v2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 15px;
    border-bottom: 1px solid @border-light;
}

.summary-card-visual {
    padding: 24px;
    background: @background-white;
    border-radius: @border-radius-lg;

    .summary-total-badge {
        background: var(--bg-light);
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.85rem;
        color: @text-secondary;
        border: 1px solid var(--border-light);
    }
}

.progress-stacked-root {
    margin-bottom: 30px;

    .progress-info-labels {
        display: flex;
        gap: 24px;
        margin-bottom: 12px;
        font-size: 0.85rem;
        font-weight: 600;

        span {
            position: relative;
            padding-left: 14px;
            display: flex;
            align-items: center;

            &::before {
                content: "";
                position: absolute;
                left: 0;
                width: 8px;
                height: 8px;
                border-radius: 50%;
            }
        }

        .label-success::before {
            background: var(--color-success);
            box-shadow: none;
        }
        .label-error::before {
            background: var(--color-error);
            box-shadow: none;
        }
        .label-warn::before {
            background: var(--color-warning);
            box-shadow: none;
        }
    }

    .progress-stacked-bar {
        display: flex;
        height: 12px;
        background: var(--bg-light);
        border-radius: 10px;
        overflow: hidden;
        border: 1px solid var(--border-light);
    }

    .bar-segment {
        height: 100%;
        transition: width 1s ease-out;

        &.is-success {
            background: @success-color;
        }
        &.is-error {
            background: @error-color;
        }
        &.is-warning {
            background: @warning-color;
        }
    }
}

.breakdown-grid-v2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 30px;

    @media (max-width: 600px) {
        grid-template-columns: 1fr;
        gap: 20px;
    }
}

.breakdown-block-v2 {
    h4 {
        font-size: 0.85rem;
        color: @text-secondary;
        margin: 0 0 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
}

.breakdown-list-v2 {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.modern-chip {
    display: flex;
    align-items: center;
    padding: 10px 14px;
    background: var(--bg-light);
    border: 1px solid var(--border-light);
    border-radius: 10px;
    font-size: 0.9rem;
    color: @text-primary;
    transition: all 0.2s;

    &:hover {
        border-color: @primary-color;
        background: var(--bg-card);
    }

    .chip-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: @primary-color;
        margin-right: 12px;
        box-shadow: 0 0 6px rgba(var(--color-primary-rgb), 0.4);
    }

    .chip-label {
        font-weight: 500;
        flex: 1;
    }

    .chip-count {
        background: var(--bg-card);
        padding: 2px 8px;
        border-radius: 6px;
        font-size: 0.8rem;
        font-weight: 700;
        color: @text-secondary;
        border: 1px solid var(--border-light);
    }

    &.mode-chip {
        background: transparent;
        border-style: dashed;

        .chip-label {
            color: @text-secondary;
        }
    }
}

.meta-chip {
    display: inline-flex;
    align-items: center;
    padding: 6px 14px;
    border-radius: 8px;
    background: @background-white;
    border: 1px solid @border-light;
    color: @text-secondary;
    font-size: 0.82rem;
    transition: all 0.2s;

    &:hover {
        border-color: @primary-color;
        color: @primary-color;
    }
}

.stats-download-button {
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    cursor: pointer;
    font-family: inherit;

    &:disabled {
        cursor: wait;
        opacity: 0.65;
    }
}

.time-range-select {
    width: 130px;

    :deep(.el-select__wrapper) {
        background: @background-white;
        border: 1px solid @border-light;
        box-shadow: none !important;
        border-radius: 8px !important;
        padding: 5px 12px;
        min-height: 35px;
        transition: all @transition-fast;

        &:hover {
            border-color: @primary-color;
        }

        &.is-focused {
            border-color: @primary-color;
        }
    }

    :deep(.el-select__placeholder) {
        color: @text-secondary;
        font-size: 0.82rem;
    }

    :deep(.el-select__selected-item) {
        color: @text-secondary !important;
        font-size: 0.82rem !important;
    }
}

.page-description {
    color: @text-secondary;
    margin: 0;
}

.wide-card {
    min-width: 0;
    margin-bottom: 24px;
}

.summary-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.mono {
    font-family: @font-family-mono;
}

.data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;

    th,
    td {
        text-align: left;
        padding: 12px 10px;
        border-bottom: 1px solid @border-light;
        vertical-align: top;
    }

    th {
        color: @text-secondary;
        font-weight: 600;
        background: rgba(0, 0, 0, 0.02);
        position: sticky;
        top: 0;
        z-index: 1;
    }

    tbody tr:hover {
        background: rgba(var(--color-primary-rgb), 0.06);
    }
}

.empty-state {
    color: @text-secondary;
    text-align: center;
    padding: 24px 0;
}

.breakdown-block {
    margin-top: 20px;

    h4 {
        font-size: 0.85rem;
        color: @text-secondary;
        margin: 0 0 10px;
    }
}

.breakdown-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
}

.usage-tag-compact {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0;
    border-radius: 6px;
    background: var(--bg-tag-default, rgba(0, 0, 0, 0.03));
    border: 1px solid @border-light;
    font-size: 0.82rem;
    overflow: hidden;
    height: 24px;
    z-index: 1;
    transition: all 0.2s;

    &:hover {
        border-color: @primary-color;
        box-shadow: 0 2px 6px rgba(var(--color-primary-rgb), 0.1);
    }

    &::before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        width: var(--progress, 0%);
        background: linear-gradient(
            to right,
            rgba(var(--color-error-rgb), var(--usage-tag-error-alpha)) 0%,
            rgba(var(--color-error-rgb), var(--usage-tag-error-alpha)) var(--error-progress, 0%),
            rgba(var(--color-success-rgb), var(--usage-tag-success-alpha)) var(--error-progress, 0%),
            rgba(var(--color-success-rgb), var(--usage-tag-success-alpha)) 100%
        );
        z-index: -1;
        transition: width 0.6s cubic-bezier(0.1, 0, 0.2, 1);
    }

    .tag-label {
        padding: 0 8px;
        color: @text-primary;
        font-weight: 500;
        white-space: nowrap;
    }

    .tag-count {
        background: rgba(0, 0, 0, 0.04);
        height: 100%;
        display: flex;
        align-items: center;
        padding: 0 6px;
        color: @text-secondary;
        font-weight: 700;
        font-family: @font-family-mono;
        font-size: 0.75rem;
        border-left: 1px solid @border-light;
        gap: 4px;
    }

    .tag-error-count {
        color: @error-color;
        font-weight: 900;
    }
}

.usage-tag-more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 24px;
    padding: 0 8px;
    border-radius: 6px;
    background: var(--bg-hover);
    color: @primary-color;
    font-size: 0.75rem;
    font-weight: 700;
    cursor: help;
    border: 1px dashed rgba(var(--color-primary-rgb), 0.4);
    transition: all 0.2s;

    &:hover {
        background: rgba(var(--color-primary-rgb), 0.1);
        border-style: solid;
        transform: scale(1.05);
    }
}

.tooltip-model-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 4px;
    max-height: 300px;
    overflow-y: auto;
}

.tooltip-model-item {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    font-size: 0.8rem;
    padding: 2px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);

    &:last-child {
        border-bottom: none;
    }

    .model-name-tip {
        color: rgba(255, 255, 255, 0.7);
    }

    .model-count-tip {
        color: #fff;
        font-weight: 700;
        font-family: @font-family-mono;
    }
}

.records-card {
    margin-bottom: 0;
}

.stats-filters-card {
    margin-bottom: 24px;
    background: @background-white;
    border: 1px solid @border-light;
    border-radius: 10px;
    padding: 24px;

    .card-title {
        margin: 0;
        border-bottom: none;
        padding-bottom: 0;
    }
}

.stats-filters-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-bottom: 15px;
    border-bottom: 1px solid @border-light;
}

.stats-filters-body {
    margin-top: 16px;
}

.stats-filters-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.stats-filters-toggle-indicator {
    display: none;
    align-items: center;
    justify-content: center;
    color: @text-secondary;
    transition:
        transform @transition-fast,
        color @transition-fast;

    &.is-collapsed {
        transform: rotate(-90deg);
    }
}

.stats-filters-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    flex-wrap: wrap;
}

.stats-time-range-select {
    width: 144px;
}

.stats-custom-range {
    margin: 16px 0 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    flex-wrap: wrap;
}

.stats-custom-range-label {
    color: @text-secondary;
    font-size: 0.85rem;
    white-space: nowrap;
}

.stats-custom-range-picker {
    width: min(100%, 360px);
}

.stats-record-filters {
    margin: 16px 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
}

.records-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
}

.records-order {
    color: @text-secondary;
    font-size: 0.85rem;
}

.records-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin: 16px 0;
}

.records-shell {
    max-height: 60vh;
}

.records-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-top: 20px;
    padding: 12px 16px;
    background: rgba(var(--color-primary-rgb), 0.02);
    border-radius: @border-radius-lg;
    border: 1px solid @border-light;
}

.records-pagination-summary,
.records-pagination-controls,
.records-pagination-pages,
.records-pagination-size,
.records-pagination-jump {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.records-pagination-summary,
.records-pagination-size span,
.records-pagination-jump span {
    color: @text-secondary;
    font-size: 0.85rem;
    font-weight: 500;
}

.records-pagination-btn,
.records-pagination-select,
.records-pagination-input {
    height: 32px;
    line-height: 30px;
    border: 1px solid @border-color;
    border-radius: @border-radius-md;
    background: @background-white;
    color: @text-secondary;
    font-size: 0.85rem;
    transition: all @transition-fast;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    vertical-align: middle;

    &:hover:not(:disabled) {
        border-color: @primary-color;
        color: @primary-color;
        box-shadow: 0 3px 8px rgba(var(--color-primary-rgb), 0.15);
    }

    &:active:not(:disabled) {
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }

    &:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        background: @background-light;
        border-color: @border-light;
        box-shadow: none;
    }
}

.records-pagination-btn {
    padding: 0 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;

    &.is-active {
        color: @text-on-primary;
        border-color: @primary-color;
        background: @primary-color;
        box-shadow: 0 2px 6px rgba(var(--color-primary-rgb), 0.35);

        &:hover {
            color: @text-on-primary;
            background: @primary-hover-color;
            border-color: @primary-hover-color;
        }
    }
}

.records-pagination-page {
    min-width: 32px;
    padding: 0;
}

.records-pagination-ellipsis {
    min-width: 20px;
    text-align: center;
    color: @text-secondary;
    font-size: 0.85rem;
    letter-spacing: 1px;
    line-height: 32px;
}

.records-pagination-select,
.records-pagination-input {
    padding: 0 8px;
    outline: none;
    border-color: @border-light;

    &:focus {
        border-color: @primary-color;
        box-shadow: 0 0 0 3px rgba(var(--color-primary-rgb), 0.12);
    }
}

.records-pagination-select {
    min-width: 70px;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 24px;
    line-height: 1;
}

.records-pagination-input {
    width: 50px;
    text-align: center;
    padding: 0;

    &::-webkit-inner-spin-button,
    &::-webkit-outer-spin-button {
        opacity: 0.1;
    }
}

.records-pagination-go {
    min-width: 50px;
    background: transparent;
    border-color: @border-light;

    &:hover:not(:disabled) {
        background: rgba(var(--color-primary-rgb), 0.05);
    }
}

.record-filter-select-custom {
    :deep(.el-select__wrapper) {
        cursor: pointer;
        height: 36px !important;
        overflow: hidden;
    }

    // Completely negate the height impact of tags
    :deep(.el-select__selection) {
        padding: 0 !important;
        margin: 0 !important;
        height: 100% !important;

        .el-tag {
            display: none !important;
        }
    }

    // Adjust placeholder and prefix positioning
    :deep(.el-select__placeholder) {
        display: none !important; // Hide native placeholder
    }

    // Custom label text style
    .custom-label-text {
        position: absolute;
        left: 12px; // Default alignment for Element Plus
        top: 50%;
        transform: translateY(-50%);
        color: var(--el-text-color-primary);
        font-weight: 400;
        max-width: calc(100% - 40px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        pointer-events: none;
        z-index: 1;

        &.is-placeholder-label {
            color: var(--el-text-color-placeholder);
        }
    }
}

// Custom search option at the top of select dropdowns
.stats-filter-search-option {
    position: sticky;
    top: 0;
    z-index: 10;
    background: @background-white;
    padding: 8px 12px !important;
    height: auto !important;
    border-bottom: 1px solid @border-light;
    cursor: default !important;
    opacity: 1 !important; // Override disabled opacity

    &.is-disabled {
        background-color: @background-white !important;
        cursor: default !important;
        color: inherit !important;
    }

    :deep(.el-input) {
        .el-input__wrapper {
            box-shadow: 0 0 0 1px @border-light inset !important;
            border-radius: 6px;
            padding: 0 8px;
            height: 32px;
            background-color: @background-white;
            transition: all @transition-fast;
            width: 100%;
            box-sizing: border-box;

            &.is-focus {
                box-shadow: 0 0 0 1px @primary-color inset !important;
            }
        }

        .el-input__inner {
            padding-right: 24px !important; // Fixed reservation
        }
    }
}

// Fixed-layout clear button to prevent resizing
.stats-search-clear-btn {
    font-size: 14px;
    color: var(--el-text-color-placeholder);
    cursor: pointer;
    transition: all @transition-fast;
    visibility: hidden; // Keep space but hide
    pointer-events: none;
    margin-right: 2px;

    &.is-visible {
        visibility: visible;
        pointer-events: auto;

        &:hover {
            color: @primary-color;
        }
    }
}

.record-filter-select {
    width: 132px;

    :deep(.el-select__wrapper) {
        background: @background-white;
        border: 1px solid @border-light;
        box-shadow: none !important;
        border-radius: 8px !important;
        min-height: 36px;
        transition: all @transition-fast;

        &:hover {
            border-color: @primary-color;
        }

        &.is-focused {
            border-color: @primary-color;
        }
    }
}

.record-filter-select-wide {
    width: 180px;
}

.record-filter-select-narrow {
    width: 110px;
}

.record-filter-reset {
    height: 36px;
    padding: 0 14px;
    border-radius: 8px;
    border: 1px solid @border-light;
    background: @background-white;
    color: @text-secondary;
    cursor: pointer;
    transition: all @transition-fast;

    &:hover {
        color: @primary-color;
        border-color: @primary-color;
    }

    &.is-active {
        color: @primary-color;
        border-color: rgba(var(--color-primary-rgb), 0.35);
        background: rgba(var(--color-primary-rgb), 0.08);
    }

    &:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        color: @text-secondary;
        border-color: @border-light;
        background: @background-white;
    }
}

:global(.el-popper.stats-filter-select-dropdown) {
    max-width: calc(100vw - 24px);
}

:global(.el-popper.stats-filter-select-dropdown .el-scrollbar__wrap) {
    overflow-x: auto !important;
}

:global(.el-popper.stats-filter-select-dropdown .el-select-dropdown__list) {
    min-width: max-content;
}

:global(.el-popper.stats-filter-select-dropdown .el-select-dropdown__item),
:global(.el-popper.stats-filter-select-dropdown .stats-filter-search-option) {
    white-space: nowrap;
}

:global(.el-popper.stats-date-range-dropdown) {
    max-width: calc(100vw - 24px);
}

/* Stats page header: allow meta chips to wrap below title on narrow screens */
.stats-page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
}

.page-header-main {
    flex: 1;
    min-width: 0;
}

.page-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

/* Scrollable table wrapper */
.table-scroll-wrapper {
    overflow-x: auto;
    border: 1px solid @border-light;
    border-radius: @border-radius-md;
    -webkit-overflow-scrolling: touch;
    max-height: 60vh;

    &::-webkit-scrollbar {
        width: 6px;
        height: 6px;
    }

    &::-webkit-scrollbar-track {
        background: transparent;
    }

    &::-webkit-scrollbar-thumb {
        background: @border-color;
        border-radius: 3px;

        &:hover {
            background: @text-secondary;
        }
    }

    &::-webkit-scrollbar-corner {
        background: transparent;
    }
}

.records-scroll-wrapper {
    max-height: none !important;
}

.fixed-header-table {
    width: max-content;
    min-width: 100%;

    th,
    td {
        white-space: nowrap;
    }

    tbody td {
        vertical-align: middle;
    }

    /* Solid background for generic th to prevent scroll-under contents from showing through */
    th {
        position: sticky;
        top: 0;
        z-index: 10;
        background: @background-light;
        /* Use box-shadow for bottom border to prevent sticky border-collapse disappearance */
        box-shadow: inset 0 -1px 0 @border-light;
    }

    th:first-child,
    td:first-child {
        position: sticky;
        left: 0;
        z-index: 5;
    }

    td:first-child {
        background: @background-white;
        box-shadow: inset -1px 0 0 @border-light;
    }

    th:first-child {
        z-index: 11;
        background: @background-light;
        /* Intersecting cell gets combined left and bottom shadows */
        box-shadow: inset -1px -1px 0 @border-light;
    }

    /* Opaque hover background for sticky cell to avoid scrolled content bleed-through */
    tbody tr:hover td:first-child,
    tbody tr:hover .account-cell {
        background:
            linear-gradient(rgba(var(--color-primary-rgb), 0.06), rgba(var(--color-primary-rgb), 0.06)),
            @background-white;
    }
}

/* Account column: allow wrapping for long email addresses */
.account-cell {
    white-space: normal !important;
    word-break: break-all;
    max-width: 240px;
    vertical-align: middle;
}

/* truncate cells for very long text (e.g. paths, IDs) */
.truncate-cell {
    max-width: 250px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.request-ip-text {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
}

/* Time column in request records: sticky + fixed width */
.sticky-time-col {
    max-width: 180px;
    white-space: normal !important;
}

.outcome-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 72px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;

    &.is-success {
        color: @success-color;
        background: rgba(var(--color-success-rgb), 0.12);
    }

    &.is-error {
        color: @error-color;
        background: rgba(var(--color-error-rgb), 0.12);
    }

    &.is-aborted {
        color: @warning-color;
        background: rgba(var(--color-warning-rgb), 0.12);
    }
}

.attempts-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 32px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    background: var(--bg-hover);

    &.is-clickable {
        cursor: pointer;
        color: var(--color-primary);
        background: rgba(var(--color-primary-rgb), 0.1);

        &:hover {
            background: rgba(var(--color-primary-rgb), 0.2);
        }
    }
}

@media (max-width: 768px) {
    :global(.el-popper.stats-date-range-dropdown) {
        width: calc(100vw - 24px) !important;
        max-width: calc(100vw - 24px) !important;
        max-height: min(78vh, 560px);
        overflow: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-x pan-y;
    }

    :global(.el-popper.stats-date-range-dropdown .el-picker-panel) {
        min-width: 620px;
    }

    :global(.el-popper.stats-date-range-dropdown .el-picker-panel__body-wrapper) {
        overflow: visible;
    }

    .stats-page-header {
        flex-direction: column;
        align-items: flex-start;
    }

    .page-meta {
        width: 100%;
        justify-content: flex-start;
    }

    .stats-dashboard-grid {
        grid-template-columns: 1fr;
    }

    .stats-grid-v2 {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
    }

    .table-scroll-wrapper {
        max-height: 45vh;
    }

    .record-filter-select,
    .record-filter-select-wide,
    .record-filter-select-narrow,
    .record-filter-reset,
    .stats-time-range-select,
    .stats-custom-range-picker {
        width: 100%;
    }

    .stats-filters-actions {
        width: 100%;
    }

    .stats-custom-range {
        align-items: stretch;
        justify-content: flex-start;
    }

    .stats-custom-range-label {
        width: 100%;
    }

    .stats-filters-header {
        &.is-collapsible {
            cursor: pointer;
            user-select: none;

            &:focus-visible {
                outline: 2px solid rgba(var(--color-primary-rgb), 0.28);
                outline-offset: 4px;
            }
        }
    }

    .stats-filters-toggle-indicator {
        display: inline-flex;
    }

    .stats-filters-card {
        &.is-collapsed-mobile {
            .stats-filters-header {
                padding-bottom: 0;
                border-bottom: none;
            }
        }
    }

    .account-cell {
        max-width: 150px;
    }

    .sticky-time-col {
        max-width: 150px;
    }
}

@media (max-width: 599px) {
    .stats-grid-v2 {
        grid-template-columns: 1fr 1fr;
    }

    .stats-dashboard-grid {
        gap: 16px;
    }

    .page-meta {
        gap: 6px;
    }

    .meta-chip {
        font-size: 0.8rem;
        padding: 6px 10px;
    }

    .time-range-select {
        :deep(.el-select__wrapper) {
            font-size: 14px; // Prevent select text from shrinking at narrow widths
        }

        :deep(.el-select__placeholder),
        :deep(.el-select__selected-item) {
            font-size: 0.82rem;
        }
    }

    .stats-filters-card {
        padding: 18px;
    }

    .account-cell {
        max-width: 100px;
    }

    .sticky-time-col {
        max-width: 90px;
    }
}
</style>
