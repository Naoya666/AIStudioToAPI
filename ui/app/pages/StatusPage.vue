<!--
 * File: ui/app/pages/StatusPage.vue
 * Description: Status page component for displaying system status and logs
 *
 * Author: Ellinav, iBenzene, bbbugg
-->

<template>
    <AppShell
        :active-tab="activeTab"
        :t="t"
        @navigate="switchTab"
        @language="handleLanguageChange(state.currentLang === 'en' ? 'zh' : 'en')"
        @logout="handleLogout"
    >
        <PageState
            v-if="refreshError"
            class="refresh-error"
            :message="t('adminRefreshFailed')"
            :error="true"
            :retry-label="t('adminRetry')"
            @retry="updateContent"
        />
        <!-- HOME VIEW -->
        <div v-if="activeTab === 'home'" class="view-container">
            <PageHeader :title="t('adminOverview')" :description="t('adminOverviewDescription')" />

            <p v-if="!schedulingMode" class="storage-retention-note">{{ t(modeNotice) }}</p>
            <p v-if="isModelAware && (schedulerError || !schedulerData)" role="status" class="storage-retention-note">
                {{ t(schedulerError ? "schedulerLoadFailed" : "loading") }}
            </p>
            <SchedulerStatus
                v-if="isModelAware && schedulerData"
                :data="schedulerData"
                :t="t"
                @refresh="updateContent"
            />

            <div class="dashboard-grid">
                <!-- Service Status Card -->
                <div class="status-card">
                    <h3 class="card-title">
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
                            style="margin-right: 8px; vertical-align: text-bottom"
                        >
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                        </svg>
                        {{ t("serviceStatus") }}
                        <span
                            class="dot"
                            :class="state.serviceConnected ? 'status-running' : 'status-error'"
                            style="display: inline-block; vertical-align: middle; margin-left: 8px"
                        ></span>
                    </h3>
                    <div class="status-list">
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M20 8h-2"></path>
                                    <path d="M20 18h-2"></path>
                                    <rect x="2" y="4" width="20" height="8" rx="2" ry="2"></rect>
                                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                                    <line x1="6" y1="8" x2="6.01" y2="8"></line>
                                    <line x1="6" y1="18" x2="6.01" y2="18"></line>
                                </svg>
                                {{ t("serviceConnection") }}
                            </span>
                            <span class="value status-text-bold" :class="serviceConnectedClass">{{
                                serviceConnectedText
                            }}</span>
                        </div>
                        <div v-if="state.serviceConnected" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                                </svg>
                                {{ t("browserConnection") }}
                            </span>
                            <span class="value status-text-bold" :class="browserConnectedClass">{{
                                browserConnectedText
                            }}</span>
                        </div>
                    </div>
                </div>

                <!-- Account Status Card -->
                <div v-if="state.serviceConnected" class="status-card">
                    <h3 class="card-title">
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
                            style="margin-right: 8px; vertical-align: text-bottom"
                        >
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                            <circle cx="12" cy="7" r="4"></circle>
                        </svg>
                        {{ t("accountStatus") }}
                    </h3>
                    <div class="status-list">
                        <div v-if="isLegacy" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="8.5" cy="7" r="4"></circle>
                                    <polyline points="17 11 19 13 23 9"></polyline>
                                </svg>
                                {{ t("currentAccount") }}
                            </span>
                            <span class="value account-value">
                                <span class="account-name" :class="currentAccountNameClass">
                                    #{{ state.currentAuthIndex }} {{ currentAccountName }}
                                </span>
                            </span>
                        </div>
                        <div v-if="isLegacy" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <line x1="18" y1="20" x2="18" y2="10"></line>
                                    <line x1="12" y1="20" x2="12" y2="4"></line>
                                    <line x1="6" y1="20" x2="6" y2="14"></line>
                                </svg>
                                <span>
                                    {{ t("usageCount") }}
                                    <EnvVarTooltip env-var="SWITCH_ON_USES" doc-section="proxy-config" />
                                </span>
                            </span>
                            <span class="value">{{ state.usageCount }}</span>
                        </div>
                        <div v-if="isLegacy" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path
                                        d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
                                    ></path>
                                    <line x1="12" y1="9" x2="12" y2="13"></line>
                                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                                </svg>
                                <span>
                                    {{ t("consecutiveFailures") }}
                                    <EnvVarTooltip env-var="FAILURE_THRESHOLD" doc-section="proxy-config" />
                                </span>
                            </span>
                            <span class="value">{{ state.failureCount }}</span>
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                                    <polyline points="2 17 12 22 22 17"></polyline>
                                    <polyline points="2 12 12 17 22 12"></polyline>
                                </svg>
                                {{ t("totalScanned") }}
                            </span>
                            <span class="value">{{ totalScannedCount }}</span>
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                                </svg>
                                {{ t("dedupedAvailable") }}
                            </span>
                            <span class="value">{{ dedupedAvailableCount }}</span>
                        </div>
                        <div v-if="schedulingMode" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect>
                                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                                </svg>
                                <span>
                                    {{ t(isModelAware ? "browserContexts" : "activeContexts") }}
                                    <EnvVarTooltip
                                        :env-var="isModelAware ? 'MAX_BROWSER_WORKERS' : 'MAX_CONTEXTS'"
                                        doc-section="proxy-config"
                                    />
                                </span>
                            </span>
                            <span class="value">{{ activeContextsDisplay }}</span>
                        </div>
                    </div>
                </div>

                <!-- Proxy Settings Status Card -->
                <div v-if="state.serviceConnected" class="status-card">
                    <h3 class="card-title">
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
                            style="margin-right: 8px; vertical-align: text-bottom"
                        >
                            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"></path>
                        </svg>
                        {{ t("proxySettingsStatus") }}
                    </h3>
                    <div class="status-list">
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                                </svg>
                                <span>
                                    {{ t("streamingMode") }}
                                    <span
                                        style="
                                            font-size: 0.8em;
                                            color: var(--text-secondary);
                                            font-weight: normal;
                                            margin-left: 4px;
                                        "
                                        >({{ t("onlyAppliesWhenStreamingEnabled") }})</span
                                    >
                                    <EnvVarTooltip env-var="STREAMING_MODE" doc-section="other-config" />
                                </span>
                            </span>
                            <span
                                class="value status-text-bold"
                                :class="state.streamingMode === 'real' ? 'status-ok' : 'status-error'"
                                >{{ translateLabel(state.streamingMode) }}</span
                            >
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M15.5 13a3.5 3.5 0 0 0 -3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8"></path>
                                    <path d="M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1 -7 0v-1.8"></path>
                                    <path d="M17.5 16a3.5 3.5 0 0 0 0 -7h-.5"></path>
                                    <path d="M19 9.3v-2.8a3.5 3.5 0 0 0 -7 0"></path>
                                    <path d="M6.5 16a3.5 3.5 0 0 1 0 -7h.5"></path>
                                    <path d="M5 9.3v-2.8a3.5 3.5 0 0 1 7 0v10"></path>
                                </svg>
                                <span>
                                    {{ t("forceThinking") }}
                                    <EnvVarTooltip env-var="FORCE_THINKING" doc-section="other-config" />
                                </span>
                            </span>
                            <span
                                class="value status-text-bold"
                                :class="state.forceThinkingEnabled ? 'status-ok' : 'status-error'"
                                >{{ state.forceThinkingEnabled ? t("enabled") : t("disabled") }}</span
                            >
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="2" y1="12" x2="22" y2="12"></line>
                                    <path
                                        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
                                    ></path>
                                </svg>
                                <span>
                                    {{ t("forceWebSearch") }}
                                    <EnvVarTooltip env-var="FORCE_WEB_SEARCH" doc-section="other-config" />
                                </span>
                            </span>
                            <span
                                class="value status-text-bold"
                                :class="state.forceWebSearchEnabled ? 'status-ok' : 'status-error'"
                                >{{ state.forceWebSearchEnabled ? t("enabled") : t("disabled") }}</span
                            >
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                                </svg>
                                <span>
                                    {{ t("forceUrlContext") }}
                                    <EnvVarTooltip env-var="FORCE_URL_CONTEXT" doc-section="other-config" />
                                </span>
                            </span>
                            <span
                                class="value status-text-bold"
                                :class="state.forceUrlContextEnabled ? 'status-ok' : 'status-error'"
                                >{{ state.forceUrlContextEnabled ? t("enabled") : t("disabled") }}</span
                            >
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <polyline points="16 18 22 12 16 6"></polyline>
                                    <polyline points="8 6 2 12 8 18"></polyline>
                                </svg>
                                <span>
                                    {{ t("forceCodeExecution") }}
                                    <EnvVarTooltip env-var="FORCE_CODE_EXECUTION" doc-section="other-config" />
                                </span>
                            </span>
                            <span
                                class="value status-text-bold"
                                :class="state.forceCodeExecutionEnabled ? 'status-ok' : 'status-error'"
                                >{{ state.forceCodeExecutionEnabled ? t("enabled") : t("disabled") }}</span
                            >
                        </div>
                        <div v-if="schedulingMode" class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
                                    <path d="M21 3v5h-5"></path>
                                </svg>
                                <span>
                                    {{ t(isModelAware ? "maxRetriesPerRequest" : "maxRetries") }}
                                    <span
                                        v-if="isLegacy"
                                        style="
                                            font-size: 0.8em;
                                            color: var(--text-secondary);
                                            font-weight: normal;
                                            margin-left: 4px;
                                        "
                                        >({{ t("onlyAppliesWhenFakeStreaming") }})</span
                                    >
                                    <EnvVarTooltip
                                        :env-var="isModelAware ? 'MAX_RETRIES_PER_REQUEST' : 'MAX_RETRIES'"
                                        doc-section="proxy-config"
                                    />
                                </span>
                            </span>
                            <span class="value">{{ retriesDisplay }}</span>
                        </div>
                        <div class="status-item">
                            <span class="label">
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
                                    style="margin-right: 6px; vertical-align: middle"
                                >
                                    <path
                                        d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
                                    ></path>
                                </svg>
                                <span>
                                    {{ t("apiKey") }}
                                    <EnvVarTooltip env-var="API_KEYS" doc-section="app-config" />
                                </span>
                            </span>
                            <span class="value status-text-bold">{{ apiKeySourceText }}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Account Management Section (Full Width) -->
        </div>
        <div v-if="activeTab === 'accounts'" class="view-container">
            <p v-if="!schedulingMode" class="storage-retention-note">{{ t(modeNotice) }}</p>
            <AccountsPage
                ref="accountsPage"
                :scheduling-mode="schedulingMode"
                :current-auth-index="state.currentAuthIndex"
                :account-details="state.accountDetails"
                :is-busy="isBusy"
                :legacy-actions="{
                    uploadAuth: triggerFileUpload,
                    deduplicate: deduplicateAuth,
                    ...(isLegacy ? { switchAccount: switchAccountByIndex } : {}),
                }"
            />
            <input
                ref="fileInput"
                type="file"
                style="display: none"
                accept=".json,.zip"
                multiple
                @change="handleFileUpload"
            />
        </div>

        <!-- SETTINGS VIEW -->
        <div v-if="activeTab === 'settings'" class="view-container settings-view">
            <PageHeader :title="t('settings')" :description="t('adminSettingsDescription')" />

            <div id="settings-logs"><UnifiedConfiguration /></div>
            <div class="status-card">
                <span>{{ t("currentVersion") }}：{{ appVersion }}</span>
                <el-button @click="copyText(appVersion)">{{ t("copy") }}</el-button>
                <a href="https://github.com/Naoya666/AIStudioToAPI" target="_blank">{{ t("viewRelease") }}</a>
            </div>
            <div class="status-card">
                <label>{{ t("language") }}</label>
                <el-select v-model="state.currentLang" @change="handleLanguageChange">
                    <el-option label="中文" value="zh" />
                    <el-option label="English" value="en" />
                </el-select>
            </div>
        </div>

        <UsagePage v-show="activeTab === 'stats'" ref="usagePage" @open-settings="openLogSettings" />
        <div v-if="activeTab === 'proxy-pool'" class="view-container">
            <ProxyPoolPanel />
        </div>

        <LogsPage
            v-if="activeTab === 'logs'"
            v-model:follow="followLogs"
            :logs="state.logs"
            :count="state.logCount"
            :scroll-top="state.logScrollTop"
            :t="t"
            @scroll="state.logScrollTop = $event"
            @copy="copyText"
            @download="downloadCurrentLogs"
        />
    </AppShell>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from "vue";
import UsagePage from "./UsagePage.vue";
import { formatDownloadTimestamp } from "../utils/downloadTimestamp";
import LogsPage from "./LogsPage.vue";
import AppShell from "../layouts/AppShell.vue";
import PageHeader from "../components/common/PageHeader.vue";
import PageState from "../components/common/PageState.vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox, ElNotification } from "element-plus";
import JSZip from "jszip";
import escapeHtml from "../utils/escapeHtml";
import I18n from "../utils/i18n";
import { useTheme } from "../utils/useTheme";
import EnvVarTooltip from "../components/EnvVarTooltip.vue";

import SchedulerStatus from "../components/SchedulerStatus.vue";
import ProxyPoolPanel from "../components/proxy/ProxyPoolPanel.vue";
import AccountsPage from "./AccountsPage.vue";
import UnifiedConfiguration from "../components/UnifiedConfiguration.vue";

const schedulerData = ref(null);
const schedulerError = ref(false);
const modeNotice = ref("loading");
const router = useRouter();
const fileInput = ref(null);
const accountsPage = ref(null);
const usagePage = ref(null);
const route = useRoute();
const tabPaths = {
    accounts: "/accounts",
    home: "/",
    logs: "/logs",
    "proxy-pool": "/proxy-pool",
    settings: "/settings",
    stats: "/usage",
};
const activeTab = computed(() => Object.keys(tabPaths).find(tab => tabPaths[tab] === route.path) || "home");
const refreshError = ref(false);
const followLogs = ref(true);
watch(activeTab, (tab, previous) => {
    if (previous === "logs")
        state.logScrollTop = document.getElementById("log-container")?.scrollTop || state.logScrollTop;
    if (tab === "stats") usagePage.value?.invalidateStorage();
    immediateRefreshRequested = true;
    pollController?.abort();
    scheduleUpdate(0);
    if (tab === "logs")
        nextTick(() => {
            const el = document.getElementById("log-container");
            if (el) el.scrollTop = followLogs.value ? el.scrollHeight : state.logScrollTop;
        });
});
// Create reactive version counter
const langVersion = ref(0);

// Translation function that tracks language changes
const t = (key, options) => {
    langVersion.value; // Access to track changes
    return I18n.t(key, options);
};

// Legacy overview labels use the same localized values as usage records.
const translateLabel = value => {
    if (!value) return "-";
    if (value === "__EMPTY__") return t("emptyValue");
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

const POLL_INTERVAL_MS = 5000;
let pollInFlight = false;
let pollController = null;
let immediateRefreshRequested = false;
const scheduleUpdate = delay => {
    if (!isActive) return;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(runPollingRound, Math.max(0, delay));
};
const runPollingRound = async () => {
    if (!isActive || pollInFlight || document.hidden) return scheduleUpdate(POLL_INTERVAL_MS);
    pollInFlight = true;
    const startedAt = Date.now();
    pollController = new AbortController();
    try {
        await updateContent(pollController.signal);
    } catch (err) {
        if (err.name !== "AbortError") console.error("Error fetching data:", err.message || err);
    } finally {
        pollInFlight = false;
        pollController = null;
        const delay = immediateRefreshRequested ? 0 : POLL_INTERVAL_MS - (Date.now() - startedAt);
        immediateRefreshRequested = false;
        scheduleUpdate(delay);
    }
};

const getApiErrorMessage = data => {
    if (data?.message) {
        return t(data.message, data);
    }

    if (data?.error) {
        return typeof data.error === "string" ? data.error : data.error.message;
    }

    return t("unknownError");
};

const openLogSettings = async () => {
    await router.push("/settings#settings-logs");
    await nextTick();
    document.getElementById("settings-logs")?.scrollIntoView({ block: "start" });
};
const switchTab = tabName => router.push(tabPaths[tabName] || "/");

useTheme();

const state = reactive({
    accountDetails: [],
    activeContextsCount: 0,
    apiKeySource: "",
    browserConnected: false,
    checkUpdateEnabled: true,
    currentAuthIndex: -1,
    currentLang: I18n.getLang(),
    debugModeEnabled: false,
    enableAuthUpdateEnabled: true,
    failureCount: 0,
    floatingActionsExpanded: false,
    forceCodeExecutionEnabled: false,
    forceThinkingEnabled: false,
    forceUrlContextEnabled: false,
    forceWebSearchEnabled: false,
    hasUpdate: false,
    isSwitchingAccount: false,
    isSystemBusy: false,
    isUpdating: false,
    latestVersion: null,
    logCount: 0,
    logMaxCount: 100,
    logs: t("loading"),
    logScrollTop: 0,
    maxContexts: 1,
    maxRetries: 3,
    releaseUrl: null,
    safetySettingsThreshold: "OFF",
    schedulerMaxBrowserWorkers: null,
    schedulerMaxRetriesPerRequest: null,
    schedulingMode: null,
    selectedAccounts: new Set(), // Selected account indices
    serviceConnected: false,
    streamingMode: "real",
    // theme: handled by useTheme
    usageCount: 0,
});

const browserConnectedClass = computed(() => {
    if (state.isSystemBusy) {
        return "status-warning";
    }
    return state.browserConnected ? "status-ok" : "status-error";
});

const browserConnectedText = computed(() => {
    if (state.isSystemBusy) {
        return t("connecting");
    }
    return state.browserConnected ? t("running") : t("disconnected");
});

// Total scanned accounts count
const totalScannedCount = computed(() => state.accountDetails.length);

// Deduped available accounts count (excluding duplicates and invalid)
const dedupedAvailableCount = computed(() => {
    return state.accountDetails.filter(acc => !acc.isDuplicate && !acc.isInvalid).length;
});

const schedulingMode = computed(() => state.schedulingMode);
const isLegacy = computed(() => schedulingMode.value === "legacy");
const isModelAware = computed(() => schedulingMode.value === "model-aware");
const retriesDisplay = computed(() => {
    if (isLegacy.value) return state.maxRetries;
    const retries = state.schedulerMaxRetriesPerRequest;
    return Number.isInteger(retries) && retries >= 0 ? t("retryAttempts", { attempts: retries + 1, retries }) : "—";
});

// Active contexts display (e.g., "1 / 3" or "1 / ∞")
const activeContextsDisplay = computed(() => {
    const active = state.activeContextsCount;
    const max = isModelAware.value ? state.schedulerMaxBrowserWorkers : state.maxContexts;
    if (isModelAware.value) return `${active} / ${Number.isInteger(max) && max > 0 ? max : "—"}`;
    return max === 0 ? `${active} / ∞` : `${active} / ${max}`;
});

const isBusy = computed(() => state.isSwitchingAccount || state.isSystemBusy);

const currentAccountName = computed(() => {
    if (state.currentAuthIndex < 0) {
        return t("noActiveAccount");
    }
    const account = state.accountDetails.find(acc => acc.index === state.currentAuthIndex);
    return account ? getAccountDisplayName(account) : t("noActiveAccount");
});

const currentAccountNameClass = computed(() => {
    if (state.currentAuthIndex < 0) {
        return "status-error";
    }
    const account = state.accountDetails.find(acc => acc.index === state.currentAuthIndex);
    return account ? "" : "status-error";
});

const serviceConnectedClass = computed(() => (state.serviceConnected ? "status-ok" : "status-error"));

const serviceConnectedText = computed(() => (state.serviceConnected ? t("running") : t("disconnected")));

const apiKeySourceText = computed(() => {
    const key = state.apiKeySource ? state.apiKeySource.toLowerCase() : "";
    const translated = key ? t(key) : "";
    return translated === key ? state.apiKeySource : translated || state.apiKeySource;
});

// App version from build-time injection
const appVersion = computed(() => {
    const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
    // Add 'v' prefix only if version starts with a number (e.g. 1.0.0 -> v1.0.0)
    if (/^\d/.test(version)) {
        return `v${version}`;
    }
    // Capitalize 'preview'
    if (version.startsWith("preview")) {
        return version.charAt(0).toUpperCase() + version.slice(1);
    }
    // Keep raw string for others (e.g. main, dev)
    return version;
});

// Get display name for account with i18n support
function getAccountDisplayName(account) {
    if (account.isInvalid) {
        return t("jsonFormatError");
    }
    const name = account.name || t("unnamedAccount");
    if (account.isDuplicate && account.canonicalIndex !== null && account.canonicalIndex !== undefined) {
        return `${name} (${t("duplicateAuthHint", { index: account.canonicalIndex })})`;
    }
    return name;
}

const deduplicateAuth = () => {
    ElMessageBox.confirm(t("accountDedupConfirm"), t("warningTitle"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(async () => {
            const notification = ElNotification({
                duration: 0,
                message: t("operationInProgress"),
                title: t("warningTitle"),
                type: "warning",
            });
            state.isSwitchingAccount = true;
            try {
                let res = await fetch("/api/accounts/deduplicate", { method: "POST" });
                let data = await res.json();
                if (data.conflicts?.length) {
                    const credentialChoices = {};
                    for (const conflict of data.conflicts) {
                        const indices = conflict.candidates.map(account => account.authIndex);
                        const tierNames = { free: "Free", pro: "Pro", ultra: "Ultra 5x", ultra20: "Ultra 20x" };
                        const descriptions = conflict.candidates.map(
                            account =>
                                `#${account.authIndex}: ${tierNames[account.manualTier] || t("accountTierUnset")}`
                        );
                        const { value } = await ElMessageBox.prompt(
                            `${conflict.email}: ${t("accountCredentialConflict")} [${descriptions.join(", ")}]`,
                            t("accountManagement"),
                            {
                                inputPlaceholder: t("accountCredentialChooseIndex"),
                                inputValidator: value =>
                                    indices.includes(Number(value)) || t("accountCredentialChooseIndex"),
                            }
                        );
                        const chosen = conflict.candidates.find(account => account.authIndex === Number(value));
                        credentialChoices[conflict.email] = {
                            accountId: chosen.accountId,
                            versions: Object.fromEntries(
                                conflict.candidates.map(account => [account.accountId, account.credentialVersion])
                            ),
                        };
                    }
                    res = await fetch("/api/accounts/deduplicate", {
                        body: JSON.stringify({ credentialChoices }),
                        headers: { "Content-Type": "application/json" },
                        method: "POST",
                    });
                    data = await res.json();
                }

                const removedIndicesText = Array.isArray(data.removedIndices)
                    ? `[${data.removedIndices.join(", ")}]`
                    : "[]";
                const failedText = Array.isArray(data.failed) ? JSON.stringify(data.failed) : "";

                const message = t(data.message, {
                    ...data,
                    failed: failedText,
                    removedIndices: removedIndicesText,
                });

                if (res.ok) {
                    ElMessage.success(message);
                } else {
                    ElMessage.error(message);
                }
            } catch (err) {
                ElMessage.error(t("accountDedupFailed", { error: err.message || err }));
            } finally {
                state.isSwitchingAccount = false;
                notification.close();
                await accountsPage.value?.refresh();
                updateContent();
            }
        })
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

// Handle change specifically for Select component which might trigger logic differently

const handleLanguageChange = lang => {
    I18n.setLang(lang);
    state.currentLang = lang;
    langVersion.value++;
    localStorage.setItem("language", lang);
};

const handleLogout = () => {
    ElMessageBox.confirm(t("logoutConfirm"), {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(() => {
            fetch("/logout", {
                headers: { "Content-Type": "application/json" },
                method: "POST",
            })
                .then(res => res.json())
                .then(data => {
                    const message = t(data.message);
                    if (data.message === "logoutSuccess") {
                        ElMessage.success(message);
                        setTimeout(() => {
                            window.location.href = "/login";
                        }, 500);
                    } else {
                        ElMessage.error(message);
                    }
                })
                .catch(err => {
                    console.error("Logout error:", err);
                    ElMessage.error(t("logoutError"));
                });
        })
        .catch(() => {});
};

// Switch account by index
const switchAccountByIndex = targetIndex => {
    if (!isLegacy.value) return;
    if (state.currentAuthIndex === targetIndex) {
        ElMessage.warning(t("alreadyCurrentAccount"));
        return;
    }

    const targetAccount = state.accountDetails.find(acc => acc.index === targetIndex);
    const accountSuffix = targetAccount ? ` (${getAccountDisplayName(targetAccount)})` : "";

    ElMessageBox.confirm(`${t("confirmSwitch")} #${targetIndex}${accountSuffix}?`, {
        cancelButtonText: t("cancel"),
        confirmButtonText: t("ok"),
        lockScroll: false,
        type: "warning",
    })
        .then(async () => {
            const notification = ElNotification({
                duration: 0,
                message: t("switchingAccountNotice"),
                title: t("warningTitle"),
                type: "warning",
            });
            state.isSwitchingAccount = true;
            try {
                const res = await fetch("/api/accounts/current", {
                    body: JSON.stringify({ targetIndex }),
                    headers: { "Content-Type": "application/json" },
                    method: "PUT",
                });
                const data = await res.json();
                const message = t(data.message, data);
                if (res.ok) {
                    ElMessage.success(message);
                } else {
                    ElMessage.error(message);
                }
            } catch (err) {
                ElMessage.error(t("settingFailed", { message: err.message || err }));
            } finally {
                state.isSwitchingAccount = false;
                notification.close();
                updateContent();
            }
        })
        .catch(e => {
            if (e !== "cancel") {
                console.error(e);
            }
        });
};

const copyText = async text => {
    try {
        await navigator.clipboard.writeText(text);
        ElMessage.success(t("copySuccess"));
    } catch (err) {
        ElMessage.error(t("copyFailed"));
        console.error("Failed to copy:", err);
    }
};

const updateStatus = data => {
    state.serviceConnected = true;
    const mode = data.status.schedulingMode;
    if (mode === "legacy" || mode === "model-aware") {
        if (state.schedulingMode !== mode) {
            schedulerData.value = null;
            schedulerError.value = false;
        }
        state.schedulingMode = mode;
        state.schedulerMaxBrowserWorkers =
            mode === "model-aware" ? (data.status.schedulerMaxBrowserWorkers ?? null) : null;
        state.schedulerMaxRetriesPerRequest =
            mode === "model-aware" ? (data.status.schedulerMaxRetriesPerRequest ?? null) : null;
    } else {
        modeNotice.value = "schedulingModeUnavailable";
    }

    const isEnabled = val => {
        if (val === true) return true;
        if (val === 1) return true;
        if (String(val).toLowerCase() === "true") return true;
        return false;
    };

    state.isUpdating = true;
    state.checkUpdateEnabled = isEnabled(data.status.checkUpdate);
    state.streamingMode = data.status.streamingMode;
    state.enableAuthUpdateEnabled = isEnabled(data.status.enableAuthUpdate);
    state.forceThinkingEnabled = isEnabled(data.status.forceThinking);
    state.forceCodeExecutionEnabled = isEnabled(data.status.forceCodeExecution);
    state.forceWebSearchEnabled = isEnabled(data.status.forceWebSearch);
    state.forceUrlContextEnabled = isEnabled(data.status.forceUrlContext);
    state.debugModeEnabled = isEnabled(data.status.debugMode);
    state.currentAuthIndex = data.status.currentAuthIndex;
    state.accountDetails = data.status.accountDetails || [];
    state.activeContextsCount = data.status.activeContextsCount || 0;
    state.maxContexts = data.status.maxContexts ?? 1;
    state.maxRetries = data.status.maxRetries ?? 3;
    state.safetySettingsThreshold = data.status.safetySettingsThreshold || "OFF";

    const validIndices = new Set(state.accountDetails.map(acc => acc.index));
    for (const idx of state.selectedAccounts) {
        if (!validIndices.has(idx)) {
            state.selectedAccounts.delete(idx);
        }
    }
    state.browserConnected = data.status.browserConnected;
    state.apiKeySource = data.status.apiKeySource;
    state.usageCount = data.status.usageCount;
    state.failureCount = data.status.failureCount;
    state.logCount = data.logCount || 0;
    state.logMaxCount = data.status.logMaxCount || 100;
    if (Object.hasOwn(data, "logs")) state.logs = data.logs || "";
    state.isSystemBusy = data.status.isSystemBusy;

    nextTick(() => {
        state.isUpdating = false;
    });
};

let updateTimer = null;
let isActive = true;
let logCursor = null;

const fetchIncrementalLogs = async signal => {
    const query = logCursor === null ? "" : `?after=${logCursor}`;
    const response = await fetch(`/api/logs${query}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const incoming = data.lines || [];
    if (data.reset) state.logs = incoming.join("\n");
    else if (incoming.length) state.logs = [state.logs, ...incoming].filter(Boolean).join("\n");
    if (state.logs) state.logs = state.logs.split("\n").slice(-state.logMaxCount).join("\n");
    logCursor = data.cursor;
    state.logCount = state.logs ? state.logs.split("\n").length : 0;
};

const updateContent = async signal => {
    if (!(signal instanceof AbortSignal)) signal = undefined;
    const dot = document.querySelector(".dot");
    try {
        const res = await fetch("/api/status/core", { signal });
        if (res.redirected) {
            window.location.href = res.url;
            return;
        }
        if (res.status === 401) {
            window.location.href = "/login";
            return;
        }
        if (res.status !== 304) {
            if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
            updateStatus(await res.json());
        }

        refreshError.value = false;
        if (dot) {
            if (state.serviceConnected) dot.classList.add("status-running");
            else dot.classList.remove("status-running");
        }
        if (activeTab.value === "home" && isModelAware.value) {
            try {
                const response = await fetch("/api/dashboard/realtime", { signal });
                if (response.status === 304) return;
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const dashboard = await response.json();
                if (
                    !dashboard.scheduler ||
                    dashboard.scheduler.enabled === false ||
                    !Array.isArray(dashboard.scheduler.models) ||
                    !dashboard.scheduler.contexts_summary
                )
                    throw new Error("Scheduler data unavailable");
                schedulerData.value = dashboard.scheduler;
                schedulerError.value = false;
            } catch (error) {
                if (error.name === "AbortError") throw error;
                schedulerError.value = true;
            }
        } else if (activeTab.value === "stats") {
            await usagePage.value?.refresh(signal);
        } else if (activeTab.value === "logs") {
            await fetchIncrementalLogs(signal);
        }
    } catch (err) {
        if (err.name === "AbortError") throw err;
        console.error("Error fetching status:", err.message || err);
        refreshError.value = true;
        state.serviceConnected = false;
        modeNotice.value = "schedulingModeLoadFailed";
    }
};

const triggerFileUpload = () => {
    if (fileInput.value) {
        fileInput.value.click();
    }
};

const handleFileUpload = async event => {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    // Reset input so same files can be selected again
    event.target.value = "";

    // Show notification immediately
    const notification = ElNotification({
        duration: 0,
        message: t("operationInProgress"),
        title: t("warningTitle"),
        type: "warning",
    });

    // Set busy flag to disable UI during upload and rebalance
    state.isSwitchingAccount = true;

    try {
        // Helper function to read file as ArrayBuffer (for zip)
        const readFileAsArrayBuffer = file =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = () => reject(new Error(t("fileReadFailed")));
                reader.readAsArrayBuffer(file);
            });

        // Helper function to read file as text (for json)
        const readFileAsText = file =>
            new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve({ content: e.target.result, name: file.name });
                reader.onerror = () => reject(new Error(t("fileReadFailed")));
                reader.readAsText(file);
            });

        // Helper function to upload a single file
        const uploadFile = async fileData => {
            let parsed;
            try {
                parsed = JSON.parse(fileData.content);
            } catch (err) {
                return { error: t("invalidJson"), filename: fileData.name, success: false };
            }

            try {
                const res = await fetch("/api/files", {
                    body: JSON.stringify({ content: parsed }),
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                });

                if (res.ok) {
                    const data = await res.json();
                    return { filename: data.filename || fileData.name, success: true };
                }

                let errorMsg;
                try {
                    const data = await res.json();
                    errorMsg = getApiErrorMessage(data);
                } catch (e) {
                    // Response is not JSON or cannot be parsed, fallback to status text or unknown error
                    if (res.statusText) {
                        errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
                    } else {
                        errorMsg = `HTTP Error ${res.status}`;
                    }
                }
                return { error: errorMsg, filename: fileData.name, success: false };
            } catch (err) {
                // Network or other fetch errors
                return { error: err.message || t("networkError"), filename: fileData.name, success: false };
            }
        };

        // Collect all JSON files to upload (including extracted from zip)
        const jsonFilesToUpload = [];
        const extractErrors = [];

        for (const file of files) {
            const lowerName = file.name.toLowerCase();

            if (lowerName.endsWith(".zip")) {
                // Extract JSON files from zip
                try {
                    let arrayBuffer;
                    try {
                        arrayBuffer = await readFileAsArrayBuffer(file);
                    } catch (readErr) {
                        extractErrors.push({ local: file.name, reason: readErr.message || t("fileReadFailed") });
                        continue; // Skip zip processing if read failed
                    }

                    const zip = await JSZip.loadAsync(arrayBuffer);
                    const zipEntries = Object.keys(zip.files);

                    let foundJsonInZip = false;
                    for (const entryName of zipEntries) {
                        const entry = zip.files[entryName];
                        // Skip directories and non-json files
                        if (entry.dir || !entryName.toLowerCase().endsWith(".json")) continue;

                        foundJsonInZip = true;
                        try {
                            const content = await entry.async("string");
                            // Use format: zipName/entryName for display
                            const displayName = `${file.name}/${entryName}`;
                            jsonFilesToUpload.push({ content, name: displayName });
                        } catch (err) {
                            extractErrors.push({
                                local: `${file.name}/${entryName}`,
                                reason: t("zipExtractFailed"), // Prefer localized generic error for extraction issues
                            });
                        }
                    }

                    if (!foundJsonInZip) {
                        extractErrors.push({ local: file.name, reason: t("zipNoJsonFiles") });
                    }
                } catch (err) {
                    // Catch any other errors during zip processing (e.g. invalid zip format)
                    extractErrors.push({ local: file.name, reason: t("zipExtractFailed") });
                }
            } else if (lowerName.endsWith(".json")) {
                // Regular JSON file
                try {
                    const fileData = await readFileAsText(file);
                    jsonFilesToUpload.push(fileData);
                } catch (err) {
                    extractErrors.push({ local: file.name, reason: err.message || t("fileReadFailed") });
                }
            }
        }

        // Check if we have anything to process
        if (jsonFilesToUpload.length === 0 && extractErrors.length === 0) {
            ElMessage.warning(t("noSupportedFiles"));
            return;
        }

        // Upload all collected JSON files
        const successFiles = [];
        const failedFiles = [...extractErrors];

        // Use batch upload API if multiple files, otherwise use single file upload
        if (jsonFilesToUpload.length > 1) {
            // Batch upload
            const parsedFiles = [];
            const parseErrors = [];

            // Parse all files first
            for (const fileData of jsonFilesToUpload) {
                try {
                    const parsed = JSON.parse(fileData.content);
                    parsedFiles.push({ content: parsed, name: fileData.name });
                } catch (err) {
                    parseErrors.push({ local: fileData.name, reason: t("invalidJson") });
                }
            }

            failedFiles.push(...parseErrors);

            // Upload all valid files in one batch
            if (parsedFiles.length > 0) {
                try {
                    const res = await fetch("/api/files/batch", {
                        body: JSON.stringify({ files: parsedFiles.map(f => f.content) }),
                        headers: { "Content-Type": "application/json" },
                        method: "POST",
                    });

                    if (res.ok || res.status === 207) {
                        const data = await res.json();
                        // Process results array with proper index mapping
                        if (data.results && Array.isArray(data.results)) {
                            for (const result of data.results) {
                                const originalFile = parsedFiles[result.index];
                                if (result.success) {
                                    successFiles.push({
                                        local: originalFile?.name || `file-${result.index}`,
                                        saved: result.filename || originalFile?.name || `file-${result.index}`,
                                    });
                                } else {
                                    failedFiles.push({
                                        local: originalFile?.name || `file-${result.index}`,
                                        reason: result.error || t("unknownError"),
                                    });
                                }
                            }
                        }
                    } else {
                        // Batch upload failed completely
                        let errorMsg;
                        try {
                            const data = await res.json();
                            errorMsg = getApiErrorMessage(data);
                        } catch (e) {
                            if (res.statusText) {
                                errorMsg = `HTTP Error ${res.status}: ${res.statusText}`;
                            } else {
                                errorMsg = `HTTP Error ${res.status}`;
                            }
                        }
                        // Mark all parsed files as failed
                        for (const fileData of parsedFiles) {
                            failedFiles.push({ local: fileData.name, reason: errorMsg });
                        }
                    }
                } catch (error) {
                    // Network or other error - mark all parsed files as failed
                    // (parseErrors are already in failedFiles)
                    for (const fileData of parsedFiles) {
                        failedFiles.push({ local: fileData.name, reason: error.message || t("networkError") });
                    }
                }
            }
        } else {
            // Single file upload (use existing logic)
            for (const fileData of jsonFilesToUpload) {
                const result = await uploadFile(fileData);
                if (result.success) {
                    successFiles.push({ local: fileData.name, saved: result.filename });
                } else {
                    failedFiles.push({ local: fileData.name, reason: result.error });
                }
            }
        }

        // Build notification message with file details (scrollable container)
        let messageHtml = '<div style="max-height: 50vh; overflow-y: auto;">';

        if (successFiles.length > 0) {
            messageHtml += `<div style="margin-bottom: 8px;"><strong style="color: var(--el-color-success);">${t("fileUploadBatchSuccess")} (${successFiles.length}):</strong></div>`;
            messageHtml += '<ul style="margin: 0 0 12px 16px; padding: 0;">';
            for (const f of successFiles) {
                messageHtml += `<li style="word-break: break-all;">${escapeHtml(f.local)} → ${escapeHtml(f.saved)}</li>`;
            }
            messageHtml += "</ul>";
        }

        if (failedFiles.length > 0) {
            messageHtml += `<div style="margin-bottom: 8px;"><strong style="color: var(--el-color-danger);">${t("fileUploadBatchFailed")} (${failedFiles.length}):</strong></div>`;
            messageHtml += '<ul style="margin: 0 0 0 16px; padding: 0;">';
            for (const f of failedFiles) {
                messageHtml += `<li style="word-break: break-all;">${escapeHtml(f.local)}: ${escapeHtml(f.reason)}</li>`;
            }
            messageHtml += "</ul>";
        }

        messageHtml += "</div>";

        // Determine notification type
        let notifyType = "success";
        if (failedFiles.length > 0 && successFiles.length === 0) {
            notifyType = "error";
        } else if (failedFiles.length > 0) {
            notifyType = "warning";
        }

        // Build title with counts
        const totalProcessed = successFiles.length + failedFiles.length;
        let notifyTitle;
        if (totalProcessed === 1) {
            notifyTitle = t("fileUploadComplete");
        } else {
            notifyTitle = `${t("fileUploadBatchResult")} (✓${successFiles.length} ✗${failedFiles.length})`;
        }

        // Show result notification (keep open)
        ElNotification({
            dangerouslyUseHTMLString: true,
            duration: 0,
            message: messageHtml,
            position: "top-right",
            title: notifyTitle,
            type: notifyType,
        });

        updateContent();
    } finally {
        // Always close notification and reset busy flag
        notification.close();
        state.isSwitchingAccount = false;
        await accountsPage.value?.refresh();
    }
};

// Download current logs
const downloadCurrentLogs = () => {
    if (!state.logs) return;

    const blob = new Blob([state.logs], { type: "text/plain" });
    const filename = `AIStudioToAPI_${formatDownloadTimestamp()}_${state.logCount}.log`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

// Check for updates once on page load
const checkForUpdates = async () => {
    try {
        const res = await fetch("/api/version/check");
        if (res.ok) {
            const data = await res.json();
            state.hasUpdate = data.hasUpdate;
            state.latestVersion = data.latest;
            state.releaseUrl = data.releaseUrl;
        }
    } catch (err) {
        // Silently fail - version check is not critical
        console.warn("Failed to check for updates:", err.message);
    }
};

const handleVisibilityChange = () => {
    if (!document.hidden) {
        immediateRefreshRequested = true;
        pollController?.abort();
        scheduleUpdate(0);
    }
};

// Theme handling is now managed by useTheme composable

let unsubscribeLanguage;
onMounted(() => {
    // Listen for language changes
    unsubscribeLanguage = I18n.onChange(() => {
        langVersion.value++;
        if (state.logCount === 0) {
            state.logs = t("loading");
        }
    });

    scheduleUpdate(0);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Check for updates once on initial load
    checkForUpdates();

    // Expose copyText function globally for tooltip HTML content
    window.__copyEnvVar = text => copyText(text);
});

onBeforeUnmount(() => {
    unsubscribeLanguage?.();
    isActive = false;
    pollController?.abort();
    if (updateTimer) {
        clearTimeout(updateTimer);
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    // Clean up global function
    delete window.__copyEnvVar;
});

watchEffect(() => {
    document.title = t("statusTitle");
});
</script>

<style lang="less" scoped>
@import "../styles/variables.less";

.refresh-error {
    margin-bottom: 16px;
}
.settings-view {
    max-width: 1040px;
}
.view-container {
    min-width: 0;
}

/* Dashboard Grid */
.dashboard-grid {
    display: grid;
    gap: 24px;
    width: 100%;
}

/* Responsive Grid Columns */
@media (max-width: 599px) {
    .dashboard-grid {
        grid-template-columns: 1fr;
    }
}

@media (min-width: 600px) and (max-width: 1023px) {
    .dashboard-grid {
        grid-template-columns: repeat(2, 1fr);
    }
}

@media (min-width: 1024px) {
    .dashboard-grid {
        grid-template-columns: repeat(3, 1fr);
    }
}

/* Full Width Section for Account Management */
.full-width-section {
    margin-top: 24px;
    width: 100%;
}

.storage-retention-grid {
    display: grid;
    grid-template-columns: minmax(100px, 140px) minmax(0, 1fr);
    gap: 10px 20px;
}

.storage-retention-grid strong {
    overflow-wrap: anywhere;
}

@media (max-width: 599px) {
    .storage-retention-grid {
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
    }
}

.storage-retention-note,
.logs-retention-note {
    color: @text-secondary;
    font-size: 0.86rem;
    margin: 12px 0 0;
}

.storage-error {
    color: #dc2626;
}

/* Common Card Styles */
.status-card {
    background: @background-white;
    border-radius: 10px;
    padding: 24px;
    box-shadow: none;
    border: 1px solid @border-light;
    min-width: 0;
}

.card-title {
    font-size: 0.9rem;
    color: @text-secondary;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    margin-bottom: 20px;
    border-bottom: 1px solid @border-light;
    padding-bottom: 15px;
}

/* Status Items */
.status-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.status-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.95rem;
    min-height: 32px; /* Ensure uniform height even with components */
}

.label {
    color: @text-secondary;
    display: inline-flex;
    align-items: center;

    svg {
        flex-shrink: 0;
        transform: translateY(1px);
    }
}

.value {
    font-weight: 500;
    color: @text-primary;
    font-family: @font-family-mono;
}

.status-text-bold {
    font-weight: 700 !important;
    opacity: 1 !important;
}

.account-value {
    display: flex;
    justify-content: flex-end;
    align-items: flex-start; /* Align to top for multiline names */
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    text-align: right;
}

.account-idx-display {
    white-space: nowrap;
}

.account-name {
    max-width: 450px;
    word-break: break-word;
    white-space: normal;
    min-width: 0;
    text-align: right;
}

@media (min-width: 600px) {
    .account-name {
        max-width: 450px;
    }
}

@media (min-width: 1024px) {
    .account-name {
        max-width: none;
    }
}

.status-ok {
    color: @success-color;
}
.status-warning {
    color: @warning-color;
}
.status-error {
    color: @error-color;
}

.dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: @border-color;

    &.status-running {
        background-color: @success-color;
        box-shadow: 0 0 8px @success-color;
    }

    &.status-error {
        background-color: @error-color;
    }
}

.clickable-version {
    cursor: pointer;
    transition: color 0.3s;
    display: inline-flex;
    align-items: center;

    &:hover {
        color: @primary-color;
    }
}

.clickable-version,
.version-align {
    display: inline-flex;
    align-items: center;
    gap: 0;
}

.clickable-version {
    cursor: pointer;
    transition: color 0.2s;

    &:hover {
        color: @primary-color;

        .copy-icon {
            opacity: 1;
        }
    }
}

.copy-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 4px;
}
</style>
