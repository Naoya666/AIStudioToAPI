<template>
    <section class="accounts-panel">
        <PageHeader :title="t('accountManagement')" :description="t('adminAccountsDescription')"
            ><template #actions
                ><ElButton type="primary" @click="openNew">{{ l("新增账号", "Add account") }}</ElButton></template
            ></PageHeader
        >
        <PageState
            v-if="loadError"
            :error="true"
            :message="t('adminRefreshFailed')"
            :retry-label="t('adminRetry')"
            @retry="refresh"
        />
        <PageState v-else-if="!loaded" :loading="true" :message="t('loading')" />
        <div class="account-toolbar page-actions">
            <ElButton :disabled="isBusy" @click="legacyActions.uploadAuth?.()">{{
                l("上传 Auth", "Upload Auth")
            }}</ElButton>
            <ElButton @click="importVisible = true">{{
                l("账密 / 验证器导入", "Import credentials / authenticator")
            }}</ElButton>
            <ElTooltip
                :content="
                    selected.length
                        ? l('导出选中账号的 CSV', 'Export selected accounts as CSV')
                        : l('导出全部账号的 CSV', 'Export all accounts as CSV')
                "
            >
                <ElButton :disabled="!total" @click="exportCredentials">{{
                    l("账密导出", "Export credentials")
                }}</ElButton>
            </ElTooltip>
            <ElButton @click="router.push('/auth')">{{ l("VNC 人工登录", "Manual VNC login") }}</ElButton>
        </div>
        <template v-if="loaded">
            <ElCard class="queue-card">
                <div class="account-toolbar">
                    <strong>{{ l("登录队列", "Login queue") }}</strong>
                    <ElTooltip
                        :content="
                            l(
                                '控制新增账号自动登录及会话过期后的自动恢复；关闭后可先保存账密和验证器，再手动批量登录。运行中的任务会继续完成。',
                                'Controls new-account login and expired-session recovery. Turn off to save credentials and authenticators before manual batch login. Running tasks continue.'
                            )
                        "
                    >
                        <label class="queue-toggle"
                            >{{ l("全局自动登录", "Automatic login") }}
                            <ElSwitch v-model="autoRecoveryDraft" :disabled="busy" />
                        </label>
                    </ElTooltip>
                    <span
                        >{{ queue.running || 0 }} {{ l("运行", "running") }} / {{ queue.queued || 0 }}
                        {{ l("排队", "queued") }} / {{ queue.retryWait || 0 }} {{ l("退避", "retrying") }} /
                        {{ queue.faultSlots || 0 }} {{ l("故障槽", "fault slots") }}</span
                    >
                    <ElInputNumber v-model="concurrency" :min="1" :max="32" size="small" />
                    <ElButton size="small" @click="saveQueueConfiguration">{{
                        l("保存登录配置", "Save login settings")
                    }}</ElButton>
                    <ElButton size="small" @click="discardQueueDraft">{{
                        l("放弃草稿 / 刷新", "Discard draft / refresh")
                    }}</ElButton>
                    <span v-if="queueConfigConflict">{{
                        l("配置有并发修改，请处理草稿差异", "Settings changed elsewhere")
                    }}</span>
                    <ElButton size="small" @click="configure({ paused: !queue.paused })">{{
                        queue.paused ? l("恢复队列", "Resume queue") : l("暂停队列", "Pause queue")
                    }}</ElButton>
                </div>
                <p
                    v-if="
                        queueConfigBase &&
                        (autoRecoveryDraft !== queueConfigBase.autoRecovery ||
                            concurrency !== queueConfigBase.concurrency)
                    "
                >
                    {{ l("登录配置草稿尚未保存；当前生效自动登录：", "Unsaved login draft; active automatic login: ") }}
                    {{ queue.autoRecovery ? l("开启", "on") : l("关闭", "off") }}；{{
                        l("当前并发：", "active concurrency: ")
                    }}{{ queue.concurrency }}
                </p>
                <small
                    >{{ queue.source }} · {{ l("单次超时", "Attempt timeout") }}
                    {{ queue.attemptTimeout / 1000 }}s</small
                >
                <p v-for="execution in queue.executions || []" :key="execution.taskId">
                    {{ execution.taskId }} · {{ execution.phase }} · {{ Math.round(execution.elapsedMs / 1000) }}s
                    <span v-if="execution.fault">{{ l("执行器清理故障", "Executor cleanup fault") }}</span>
                </p>
            </ElCard>
            <div class="account-toolbar">
                <ElInput
                    v-model="search"
                    :placeholder="l('搜索邮箱 / 账号编号', 'Search email / account index')"
                    clearable
                />
                <ElSelect v-model="filter" clearable :placeholder="l('全部状态', 'All states')">
                    <ElOption
                        v-for="value in [
                            'valid',
                            'not_logged_in',
                            'credentials_missing',
                            'expired',
                            'queued',
                            'running',
                            'retry_wait',
                            'manual_required',
                            'duplicate',
                        ]"
                        :key="value"
                        :value="value"
                        :label="stateLabel(value)"
                    />
                </ElSelect>
                <ElButton :disabled="isBusy" @click="legacyActions.deduplicate?.()">{{
                    l("去重清理", "Clean duplicates")
                }}</ElButton>
            </div>
            <ElCard>
                <strong>{{ l("付费权限检测", "Benefit checks") }}</strong>
                <span>
                    · {{ benefitTasks.filter(task => ["queued", "waiting", "running"].includes(task.status)).length }}
                    {{ l("进行中", "pending") }} / {{ benefitTasks.length }} {{ l("任务", "tasks") }}</span
                >
                <small>
                    ·
                    {{
                        l(
                            "仅查询权益，不生成内容；额度为本地预估。",
                            "Queries benefits only, without generating content. Quotas are local estimates."
                        )
                    }}</small
                >
                <details v-if="benefitTasks.length">
                    <summary>{{ l("逐账号结果与进度", "Per-account results and progress") }}</summary>
                    <p v-for="task in benefitTasks.slice().reverse().slice(0, 100)" :key="task.taskId">
                        {{ task.authIndex === null ? task.accountId : "#" + task.authIndex }} ·
                        {{ benefitState(task.status) }}
                        <span v-if="task.reason"> · {{ task.reason }}</span>
                        <ElButton
                            v-if="['queued', 'waiting', 'running'].includes(task.status)"
                            size="small"
                            @click="cancelBenefits([task.accountId])"
                            >{{ l("取消", "Cancel") }}</ElButton
                        >
                    </p>
                </details>
            </ElCard>
            <div class="account-toolbar batch-toolbar">
                <span
                    >{{ l("已选", "Selected") }} {{ selected.length }}
                    {{ text("accountSelectedAcrossPages", "个（含其他页）", "(including other pages)") }}</span
                >
                <ElButton
                    size="small"
                    :title="l('选择当前筛选结果中的全部账号（含其他页）', 'Select all matching accounts across pages')"
                    :loading="selectingAll"
                    :disabled="selectingAll || !total"
                    @click="selectAll"
                    >{{ text("accountSelectAll", "全选", "Select all") }}</ElButton
                >
                <ElButton size="small" @click="clearSelection">{{
                    text("accountClearSelection", "取消全选", "Clear selection")
                }}</ElButton>
                <template v-if="selected.length">
                    <ElButton
                        size="small"
                        :disabled="!selected.length || cancelling"
                        :loading="cancelling"
                        @click="batchCancelLogin"
                        >{{ text("accountCancelSelectedLogins", "批量取消登录", "Cancel selected logins") }}</ElButton
                    >
                    <ElButton
                        size="small"
                        :disabled="!selected.length || busy || loginSubmitting || cancelling"
                        :loading="loginSubmitting"
                        @click="batchLogin"
                        >{{ l("批量重新登录", "Log in selected") }}</ElButton
                    >
                    <ElButton size="small" :disabled="!selected.length || busy" @click="checkBenefits(selected)">{{
                        l("批量检测付费权限", "Check selected benefits")
                    }}</ElButton>
                    <ElButton
                        size="small"
                        :disabled="!selected.length || busy"
                        @click="cancelBenefits(selected.map(row => row.accountId))"
                        >{{ l("取消选中检测", "Cancel selected checks") }}</ElButton
                    >
                    <ElButton size="small" :disabled="!selected.length || busy" @click="batchRecovery(true)">{{
                        l("启用自动恢复", "Enable auto recovery")
                    }}</ElButton>
                    <ElButton size="small" :disabled="!selected.length || busy" @click="batchRecovery(false)">{{
                        l("取消自动恢复", "Disable auto recovery")
                    }}</ElButton>
                    <ElTooltip
                        :content="
                            l('下载选中账号的 Cookie 和账密 CSV', 'Download selected Cookies and credentials CSV')
                        "
                    >
                        <ElButton size="small" :disabled="!selected.length || busy" @click="downloadBundle">{{
                            l("批量下载", "Download selected")
                        }}</ElButton>
                    </ElTooltip>
                    <ElButton
                        size="small"
                        type="danger"
                        plain
                        :disabled="!selected.length || isBusy || busy"
                        @click="deleteRows(selected)"
                        >{{ l("批量删除", "Delete selected") }}</ElButton
                    >
                </template>
            </div>
            <p v-if="cancelResult" class="cancel-result">
                {{ text("accountLoginCancelled", "取消成功", "Cancelled") }}
                {{ cancelResult.cancelled + cancelResult.stopping - stoppingIds.length }} ·
                {{ text("accountLoginCancelUnnecessary", "无需取消", "No cancellation needed") }}
                {{ cancelResult.unnecessary }} ·
                {{ text("accountLoginStopping", "执行器仍在停止", "Executors stopping") }} {{ stoppingIds.length }} ·
                {{ l("失败", "Failed") }}
                {{ cancelResult.failed }}
            </p>
            <p v-for="result in cancelResult?.results.filter(item => item.error) || []" :key="result.accountId">
                {{ result.accountId }}: {{ result.error }}
            </p>
            <div class="account-mobile-list">
                <label class="mobile-page-selection">
                    <ElCheckbox
                        :model-value="pageSelected"
                        :indeterminate="pagePartial"
                        :disabled="!accounts.length"
                        @change="togglePage"
                        >{{ l("选择本页", "Select this page") }}</ElCheckbox
                    >
                </label>
                <article v-for="row in accounts" :key="row.accountId" class="account-mobile-card">
                    <div class="mobile-account-heading">
                        <ElCheckbox
                            :model-value="isSelected(row)"
                            :aria-label="l('选择账号', 'Select account') + ' ' + (row.email || row.displayName)"
                            @change="value => toggleAccount(row, value)"
                        />
                        <span class="account-name"
                            >{{ row.authIndex === null ? "—" : `#${row.authIndex}` }}
                            {{ row.email || row.displayName }}</span
                        >
                    </div>
                    <div class="account-badges">
                        <ElTag
                            v-if="
                                schedulingMode === 'legacy' &&
                                row.authIndex !== null &&
                                row.authIndex === currentAuthIndex
                            "
                            size="small"
                            >{{ l("当前", "Current") }}</ElTag
                        >
                        <ElTag v-if="row.isDuplicate" size="small" type="warning">{{ l("重复", "Duplicate") }}</ElTag>
                        <ElTag v-if="row.disabled" size="small" type="danger">{{
                            l("人工禁用", "Manually disabled")
                        }}</ElTag>
                    </div>
                    <p><AccountTierBadge :account="row" /></p>
                    <p>
                        {{ l("会话 / 恢复", "Session / recovery") }}：
                        <span :class="['state-text', 'state-' + row.sessionState]">{{
                            stateLabel(row.sessionState)
                        }}</span>
                        /
                        <span :class="['state-text', 'state-' + row.recoveryState]">{{
                            stateLabel(row.recoveryState)
                        }}</span>
                    </p>
                    <small v-if="row.loginStopping">{{
                        text("accountLoginStopping", "执行器仍在停止", "Executors stopping")
                    }}</small>
                    <small v-if="row.lastFailure?.error" class="failure-reason">{{ row.lastFailure.error }}</small>
                    <p class="mobile-credentials">
                        <span>{{ row.hasPassword ? "✓" : "—" }} Password</span
                        ><span>{{ row.hasTotpSecret ? "✓" : "—" }} TOTP</span
                        ><span>{{ row.hasRecoveryEmail ? "✓" : "—" }} {{ l("恢复邮箱", "Recovery email") }}</span>
                    </p>
                    <label class="queue-toggle"
                        >{{ l("自动恢复", "Auto recovery") }}
                        <ElSwitch
                            :model-value="row.autoRecovery"
                            :disabled="busy"
                            @change="value => toggleRecovery(row, value)"
                    /></label>
                    <div class="row-actions">
                        <ElButton size="small" @click="openEdit(row)">{{ l("编辑凭据", "Edit credentials") }}</ElButton>
                        <ElButton
                            size="small"
                            :disabled="['queued', 'waiting', 'running'].includes(row.benefitTask?.status)"
                            @click="checkBenefits([row])"
                            >{{
                                ["queued", "waiting", "running"].includes(row.benefitTask?.status)
                                    ? benefitState(row.benefitTask.status)
                                    : l("检测付费权限", "Check paid benefits")
                            }}</ElButton
                        >
                        <ElButton size="small" @click="login(row)">{{ l("重新登录", "Log in") }}</ElButton>
                        <ElButton
                            v-if="schedulingMode === 'legacy' && row.authIndex !== null"
                            size="small"
                            :disabled="
                                isBusy ||
                                row.disabled ||
                                row.sessionState !== 'valid' ||
                                row.isDuplicate ||
                                row.authIndex === currentAuthIndex
                            "
                            @click="legacyActions.switchAccount?.(row.authIndex)"
                            >{{
                                row.authIndex === currentAuthIndex
                                    ? l("当前账号", "Current")
                                    : accountDetails.find(item => item.index === row.authIndex)?.hasContext
                                      ? l("快速切换", "Quick switch")
                                      : l("切换", "Switch")
                            }}</ElButton
                        >
                        <ElButton v-if="row.authIndex !== null" size="small" @click="downloadCookie(row)">{{
                            l("下载", "Download")
                        }}</ElButton>
                        <ElButton v-if="row.currentTaskId" size="small" @click="cancel(row.currentTaskId)">{{
                            l("取消", "Cancel")
                        }}</ElButton>
                        <ElButton size="small" @click="viewHistory(row)">{{
                            l("任务 / 日志", "Tasks / logs")
                        }}</ElButton>
                        <ElButton
                            size="small"
                            type="danger"
                            plain
                            :disabled="isBusy || busy"
                            @click="deleteRows([row])"
                            >{{ l("删除", "Delete") }}</ElButton
                        >
                    </div>
                </article>
                <p v-if="!accounts.length">{{ l("暂无账号", "No accounts") }}</p>
            </div>
            <div class="account-table-scroll">
                <ElTable
                    ref="accountTable"
                    :data="accounts"
                    row-key="accountId"
                    @selection-change="updatePageSelection"
                >
                    <ElTableColumn type="selection" width="45" reserve-selection />
                    <ElTableColumn :label="l('账号', 'Account')" min-width="210">
                        <template #default="{ row }">
                            <span class="account-name"
                                >{{ row.authIndex === null ? "—" : `#${row.authIndex}` }}
                                {{ row.email || row.displayName }}</span
                            >
                            <div class="account-badges">
                                <ElTag
                                    v-if="
                                        schedulingMode === 'legacy' &&
                                        row.authIndex !== null &&
                                        row.authIndex === currentAuthIndex
                                    "
                                    size="small"
                                    >{{ l("当前", "Current") }}</ElTag
                                >
                                <ElTag v-if="row.isDuplicate" size="small" type="warning">{{
                                    l("重复", "Duplicate")
                                }}</ElTag>
                                <ElTag v-if="row.disabled" size="small" type="danger">{{
                                    l("人工禁用", "Manually disabled")
                                }}</ElTag>
                            </div>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn :label="l('账号层级', 'Account tier')" min-width="160">
                        <template #default="{ row }"><AccountTierBadge :account="row" /></template>
                    </ElTableColumn>
                    <ElTableColumn :label="l('会话 / 恢复', 'Session / recovery')" width="150">
                        <template #default="{ row }">
                            <span :class="['state-text', 'state-' + row.sessionState]">{{
                                stateLabel(row.sessionState)
                            }}</span
                            ><br />
                            <span :class="['state-text', 'state-' + row.recoveryState]">{{
                                stateLabel(row.recoveryState)
                            }}</span>
                            <small v-if="row.loginStopping">{{
                                text("accountLoginStopping", "执行器仍在停止", "Executors stopping")
                            }}</small>
                            <small v-if="row.lastFailure?.error" class="failure-reason">{{
                                row.lastFailure.error
                            }}</small>
                        </template>
                    </ElTableColumn>
                    <ElTableColumn :label="l('凭据', 'Credentials')" width="95">
                        <template #default="{ row }"
                            >{{ row.hasPassword ? "✓" : "—" }} Password<br />{{
                                row.hasTotpSecret ? "✓" : "—"
                            }}
                            TOTP<br />{{ row.hasRecoveryEmail ? "✓" : "—" }}
                            {{ l("恢复邮箱", "Recovery email") }}</template
                        >
                    </ElTableColumn>
                    <ElTableColumn :label="l('自动恢复', 'Auto recovery')" width="95">
                        <template #default="{ row }"
                            ><ElSwitch
                                :model-value="row.autoRecovery"
                                :disabled="busy"
                                @change="value => toggleRecovery(row, value)"
                        /></template>
                    </ElTableColumn>
                    <ElTableColumn :label="l('操作', 'Actions')" min-width="400">
                        <template #default="{ row }">
                            <div class="row-actions">
                                <ElButton size="small" @click="openEdit(row)">{{
                                    l("编辑凭据", "Edit credentials")
                                }}</ElButton>
                                <ElButton
                                    size="small"
                                    :disabled="['queued', 'waiting', 'running'].includes(row.benefitTask?.status)"
                                    @click="checkBenefits([row])"
                                    >{{
                                        ["queued", "waiting", "running"].includes(row.benefitTask?.status)
                                            ? benefitState(row.benefitTask.status)
                                            : l("检测付费权限", "Check paid benefits")
                                    }}</ElButton
                                >
                                <ElButton size="small" @click="login(row)">{{ l("重新登录", "Log in") }}</ElButton>
                                <ElButton
                                    v-if="schedulingMode === 'legacy' && row.authIndex !== null"
                                    size="small"
                                    :disabled="
                                        isBusy ||
                                        row.disabled ||
                                        row.sessionState !== 'valid' ||
                                        row.isDuplicate ||
                                        row.authIndex === currentAuthIndex
                                    "
                                    @click="legacyActions.switchAccount?.(row.authIndex)"
                                    >{{
                                        row.authIndex === currentAuthIndex
                                            ? l("当前账号", "Current")
                                            : accountDetails.find(item => item.index === row.authIndex)?.hasContext
                                              ? l("快速切换", "Quick switch")
                                              : l("切换", "Switch")
                                    }}</ElButton
                                >
                                <ElButton v-if="row.authIndex !== null" size="small" @click="downloadCookie(row)">{{
                                    l("下载", "Download")
                                }}</ElButton>
                                <ElButton v-if="row.currentTaskId" size="small" @click="cancel(row.currentTaskId)">{{
                                    l("取消", "Cancel")
                                }}</ElButton>
                                <ElButton size="small" @click="viewHistory(row)">{{
                                    l("任务 / 日志", "Tasks / logs")
                                }}</ElButton>
                                <ElButton
                                    size="small"
                                    type="danger"
                                    plain
                                    :disabled="isBusy || busy"
                                    @click="deleteRows([row])"
                                    >{{ l("删除", "Delete") }}</ElButton
                                >
                            </div>
                        </template>
                    </ElTableColumn>
                </ElTable>
            </div>
            <ElPagination
                v-model:current-page="page"
                v-model:page-size="pageSize"
                :page-sizes="[20, 50, 100]"
                :total="total"
                :layout="mobile ? 'total, sizes, prev, next' : 'total, sizes, prev, pager, next'"
            />
            <ElDialog
                v-model="editVisible"
                class="account-dialog"
                :width="mobile ? 'calc(100vw - 24px)' : '50%'"
                :title="editing ? l('编辑凭据', 'Edit credentials') : l('新增账号', 'Add account')"
                @closed="clearForm"
            >
                <ElForm label-position="top">
                    <ElFormItem :label="l('手动层级', 'Manual tier')">
                        <ElSelect v-model="form.manualTier">
                            <ElOption
                                :value="''"
                                :label="l('未设置（跟随检测结果）', 'Unset (follow detected benefits)')"
                            />
                            <ElOption v-for="(name, tier) in tierNames" :key="tier" :value="tier" :label="name" />
                        </ElSelect>
                    </ElFormItem>
                    <div v-if="editing" aria-live="polite">
                        <p>
                            {{ l("当前有效层级", "Effective tier") }}:
                            {{ tierNames[form.manualTier || editing.tier?.detectedTier] || l("未知", "Unknown") }}
                        </p>
                        <p
                            v-if="
                                ['pro', 'ultra', 'ultra20'].includes(form.manualTier) &&
                                editing.tier?.detectedTier === 'free'
                            "
                        >
                            ⚠
                            {{
                                l(
                                    "手动设置为付费账号，但最近一次有效检测为 Free，请检查订阅或账号会话。",
                                    "Manually marked as paid, but the latest valid observation is Free. Check the subscription or session."
                                )
                            }}
                        </p>
                        <p>
                            {{ l("原始权益（只读）", "Raw benefits (read-only)") }}:
                            {{
                                editing.benefitObservation?.state === "ready-free"
                                    ? "Free"
                                    : editing.benefitObservation?.rawTier || l("未检测", "Not checked")
                            }}
                        </p>
                        <p>
                            {{ l("来源 / 成功观察时间", "Source / observed at") }}:
                            {{ editing.benefitObservation?.source || "—" }} /
                            {{
                                editing.benefitObservation?.observedAt
                                    ? new Date(editing.benefitObservation.observedAt).toLocaleString()
                                    : "—"
                            }}
                        </p>
                        <p>
                            {{
                                editing.tier?.observationCurrent
                                    ? l("当前会话", "Current session")
                                    : l("无当前会话检测，待复检", "No current session observation; recheck needed")
                            }}
                        </p>
                        <p>
                            {{ l("最近检测", "Last check") }}: {{ benefitState(editing.benefitLastCheck?.status) }} ·
                            {{ editing.benefitLastCheck?.reason || "—" }} ·
                            {{
                                editing.benefitLastCheck?.checkedAt
                                    ? new Date(editing.benefitLastCheck.checkedAt).toLocaleString()
                                    : "—"
                            }}
                        </p>
                    </div>
                    <ElFormItem label="Email"><ElInput v-model="form.email" autocomplete="off" /></ElFormItem>
                    <ElFormItem label="Password"
                        ><ElInput
                            v-model="form.password"
                            type="password"
                            show-password
                            autocomplete="new-password"
                            :placeholder="editing ? l('留空不修改', 'Leave empty to preserve') : ''"
                    /></ElFormItem>
                    <ElFormItem :label="l('恢复邮箱（可选）', 'Recovery email (optional)')"
                        ><ElInput
                            v-model="form.recoveryEmail"
                            autocomplete="off"
                            :placeholder="l('留空不修改', 'Empty preserves existing')"
                    /></ElFormItem>
                    <ElFormItem label="TOTP / otpauth://"
                        ><ElInput
                            v-model="form.totpSecret"
                            type="password"
                            show-password
                            autocomplete="off"
                            :placeholder="l('可选；留空不修改', 'Optional; empty preserves existing')"
                    /></ElFormItem>
                    <ElButton v-if="editing" @click="reveal">{{
                        l("显示已保存凭据", "Reveal saved credentials")
                    }}</ElButton>
                    <template v-if="editing"
                        ><ElCheckbox v-model="form.clearPassword">{{ l("清除密码", "Clear password") }}</ElCheckbox
                        ><ElCheckbox v-model="form.clearRecoveryEmail">{{
                            l("清除恢复邮箱", "Clear recovery email")
                        }}</ElCheckbox
                        ><ElCheckbox v-model="form.clearTotpSecret">{{
                            l("清除验证器密钥", "Clear TOTP secret")
                        }}</ElCheckbox
                        ><ElCheckbox v-model="form.loginNow">{{
                            l("保存后重新登录", "Log in after saving")
                        }}</ElCheckbox></template
                    >
                </ElForm>
                <template #footer
                    ><ElButton type="primary" :loading="busy" @click="save">{{ l("保存", "Save") }}</ElButton></template
                >
            </ElDialog>
            <ElDialog
                v-model="importVisible"
                class="account-dialog account-import-dialog"
                :title="l('导入预览', 'Import preview')"
                :width="mobile ? 'calc(100vw - 24px)' : '85%'"
                @closed="clearImport"
            >
                <div class="import-settings">
                    <ElCheckbox v-model="skipExisting" :disabled="importLocked">{{
                        text("accountImportSkipExisting", "跳过已有账号", "Skip existing accounts")
                    }}</ElCheckbox>
                    <small>{{
                        text(
                            "accountImportSkipExistingHint",
                            "仅导入新账号；已有账号不更新密码、验证器或恢复邮箱。",
                            "Import new accounts only; preserve existing passwords, authenticators and recovery emails."
                        )
                    }}</small>
                </div>
                <ElSelect v-model="importKind" :disabled="importBusy"
                    ><ElOption
                        label="CSV: email,password,recovery_email,totp_secret (兼容 totpSecret)"
                        value="csv" /><ElOption
                        label="Authenticator / otpauth-migration / Base32"
                        value="authenticator"
                /></ElSelect>
                <input type="file" :disabled="importBusy" accept=".csv,.txt" @change="readImportFile" />
                <ElInput
                    v-model="importContent"
                    :disabled="importBusy"
                    type="textarea"
                    :rows="5"
                    :placeholder="l('粘贴 CSV 或验证器链接 / 密钥', 'Paste CSV or authenticator links / secrets')"
                />
                <ElButton :disabled="importBusy" @click="previewImport">{{ l("解析预览", "Preview") }}</ElButton>
                <p v-if="preview && !preview.complete">
                    {{
                        l(
                            "迁移批次缺失，补全后才能提交。",
                            "Migration batches are incomplete. Add missing batches before committing."
                        )
                    }}
                </p>
                <div v-if="preview" class="account-toolbar">
                    <span>{{
                        queue.autoRecovery
                            ? text(
                                  "accountImportAutoLogin",
                                  "新账号导入后将自动登录",
                                  "New accounts will queue for automatic login"
                              )
                            : text("accountImportSaveOnly", "新账号仅创建记录", "New accounts will only be saved")
                    }}</span>
                    <ElCheckbox
                        :model-value="skipState.checked"
                        :indeterminate="skipState.partial"
                        :disabled="importLocked || !actionableRows.length"
                        @change="value => bulkChoice(unprotectedRows, 'skip', value)"
                        >{{ text("accountImportSkipAll", "全部跳过", "Skip all") }}</ElCheckbox
                    >
                    <ElCheckbox
                        :model-value="overwriteState.checked"
                        :indeterminate="overwriteState.partial"
                        :disabled="importLocked || !overwriteRows.length"
                        @change="value => bulkChoice(overwriteRows, 'overwrite', value)"
                        >{{ text("accountImportOverwriteAll", "全部覆盖", "Overwrite all") }}</ElCheckbox
                    >
                </div>
                <div v-if="preview" class="import-mobile-list">
                    <article v-for="row in preview.rows" :key="row.index" class="account-mobile-card">
                        <strong class="account-name">{{
                            row.email || l("未命名导入项", "Unnamed import entry")
                        }}</strong>
                        <p v-if="row.error" class="state-failed">{{ row.error }}</p>
                        <div class="import-mapping">
                            <ElSelect
                                v-if="importKind === 'authenticator'"
                                v-model="choices[row.index].accountId"
                                :disabled="importLocked || !!row.error || row.unchanged"
                                clearable
                                :placeholder="l('选择账号或跳过', 'Select account or skip')"
                                ><ElOption
                                    v-for="account in mappingAccounts"
                                    :key="account.accountId"
                                    :value="account.accountId"
                                    :label="account.email || account.displayName"
                            /></ElSelect>
                            <span v-else-if="!row.accountId">{{
                                text("accountImportNewRecord", "将创建新账号", "New account will be created")
                            }}</span>
                            <span v-else>{{ l("匹配已有账号", "Existing account matched") }}</span>
                        </div>
                        <div class="import-row-actions">
                            <ElCheckbox
                                v-model="choices[row.index].overwrite"
                                :disabled="
                                    importLocked ||
                                    protectedRow(row) ||
                                    !choices[row.index].accountId ||
                                    !!row.error ||
                                    row.unchanged
                                "
                                >{{ l("覆盖", "Overwrite") }}</ElCheckbox
                            >
                            <ElCheckbox
                                :model-value="effectiveSkip(row)"
                                :disabled="importLocked || protectedRow(row) || !!row.error || row.unchanged"
                                @change="value => (choices[row.index].skip = value)"
                                >{{ l("跳过", "Skip") }}</ElCheckbox
                            >
                        </div>
                        <div class="import-row-notes">
                            <span v-if="protectedRow(row)">{{
                                text("accountImportExistingSkipped", "已有账号，已跳过", "Existing account skipped")
                            }}</span>
                            <span v-if="row.hasRecoveryEmail">{{
                                text(
                                    "accountImportRecoveryIncluded",
                                    "本次导入含恢复邮箱",
                                    "Import includes recovery email"
                                )
                            }}</span>
                            <span v-if="row.conflict"
                                >⚠
                                {{
                                    row.recoveryEmailConflict
                                        ? l("恢复邮箱冲突", "Recovery email conflict")
                                        : l("凭据冲突", "Credential conflict")
                                }}</span
                            >
                        </div>
                    </article>
                </div>
                <ElTable v-if="preview" class="import-preview-table" :data="preview.rows">
                    <ElTableColumn prop="email" label="Email" />
                    <ElTableColumn prop="error" :label="l('问题', 'Issue')" />
                    <ElTableColumn :label="l('映射 / 创建', 'Map / create')"
                        ><template #default="{ row }">
                            <ElSelect
                                v-if="importKind === 'authenticator'"
                                v-model="choices[row.index].accountId"
                                :disabled="importLocked || !!row.error || row.unchanged"
                                clearable
                                :placeholder="l('选择账号或跳过', 'Select account or skip')"
                                ><ElOption
                                    v-for="account in mappingAccounts"
                                    :key="account.accountId"
                                    :value="account.accountId"
                                    :label="account.email || account.displayName"
                            /></ElSelect>
                            <span v-else-if="!row.accountId">{{
                                text("accountImportNewRecord", "将创建新账号", "New account will be created")
                            }}</span>
                            <span v-else>{{ l("匹配已有账号", "Existing account matched") }}</span>
                        </template></ElTableColumn
                    >
                    <ElTableColumn :label="l('显式覆盖 / 跳过', 'Overwrite / skip')" min-width="240">
                        <template #default="{ row }">
                            <div class="import-row-actions">
                                <ElCheckbox
                                    v-model="choices[row.index].overwrite"
                                    :disabled="
                                        importLocked ||
                                        protectedRow(row) ||
                                        !choices[row.index].accountId ||
                                        !!row.error ||
                                        row.unchanged
                                    "
                                    >{{ l("覆盖", "Overwrite") }}</ElCheckbox
                                >
                                <ElCheckbox
                                    :model-value="effectiveSkip(row)"
                                    :disabled="importLocked || protectedRow(row) || !!row.error || row.unchanged"
                                    @change="value => (choices[row.index].skip = value)"
                                    >{{ l("跳过", "Skip") }}</ElCheckbox
                                >
                            </div>
                            <div class="import-row-notes">
                                <span v-if="protectedRow(row)">{{
                                    text("accountImportExistingSkipped", "已有账号，已跳过", "Existing account skipped")
                                }}</span>
                                <span v-if="row.hasRecoveryEmail">{{
                                    text(
                                        "accountImportRecoveryIncluded",
                                        "本次导入含恢复邮箱",
                                        "Import includes recovery email"
                                    )
                                }}</span>
                                <span v-if="row.conflict"
                                    >⚠
                                    {{
                                        row.recoveryEmailConflict
                                            ? l("恢复邮箱冲突", "Recovery email conflict")
                                            : l("凭据冲突", "Credential conflict")
                                    }}</span
                                >
                            </div>
                        </template>
                    </ElTableColumn>
                </ElTable>
                <div v-if="importResult" class="import-result">
                    <p>
                        {{ l("创建", "Created") }} {{ importResult.created }} · {{ l("更新", "Updated") }}
                        {{ importResult.updated }} · {{ l("跳过", "Skipped") }} {{ importResult.skipped }} ·
                        {{ l("失败", "Failed") }} {{ importResult.failed }} ·
                        {{ text("accountImportLoginQueued", "自动登录已入队", "Automatic logins queued") }}
                        {{ importResult.loginQueued || 0 }}
                    </p>
                    <p v-for="warning in importResult.loginWarnings || []" :key="warning.index">
                        {{
                            text(
                                "accountImportLoginWarning",
                                "记录已创建，自动登录未入队",
                                "Record saved, automatic login not queued"
                            )
                        }}
                        ({{ warning.index + 1 }}): {{ warning.error }}
                    </p>
                    <p v-for="issue in importResult.errors || []" :key="issue.index">
                        {{ issue.index + 1 }}: {{ issue.error }}
                    </p>
                    <p>
                        {{
                            text(
                                "accountImportCommitted",
                                "此预览已提交，继续导入请重新解析预览",
                                "This preview has been committed. Parse a new preview to continue importing"
                            )
                        }}
                    </p>
                </div>
                <template #footer
                    ><ElButton
                        type="primary"
                        :disabled="!preview?.complete || importLocked"
                        :loading="importBusy"
                        @click="commitImport"
                        >{{ l("提交导入", "Commit import") }}</ElButton
                    ></template
                >
            </ElDialog>
            <ElDialog
                v-model="historyVisible"
                class="account-dialog"
                :title="l('登录任务与尝试日志', 'Login tasks and attempts')"
                :width="mobile ? 'calc(100vw - 24px)' : '85%'"
            >
                <div v-for="task in tasks" :key="task.taskId">
                    <p>
                        {{ task.taskId }} · {{ stateLabel(task.status) }} · {{ task.phase }} · {{ task.attempts }}
                        {{ l("次尝试", "attempts") }} ·
                        {{ task.startedAt ? Math.round(((task.finishedAt || now) - task.startedAt) / 1000) : 0 }}s
                        <ElButton
                            v-if="['queued', 'running', 'retry_wait'].includes(task.status)"
                            @click="cancel(task.taskId)"
                            >{{ l("取消", "Cancel") }}</ElButton
                        >
                    </p>
                    <p v-for="(attempt, index) in task.history" :key="index">
                        {{ attempt.phase }} · {{ attempt.error || "OK" }} ·
                        {{ new Date(attempt.endedAt).toISOString() }}
                        <span v-if="attempt.diagnostics">
                            · {{ l("操作诊断", "Operation diagnostics") }}:
                            {{ JSON.stringify(attempt.diagnostics) }}</span
                        >
                        <span v-if="attempt.termsOutcome">
                            · {{ l("协议状态", "Terms outcome") }}: {{ attempt.termsOutcome }}</span
                        >
                        <ElButton v-if="attempt.artifactId" @click="showArtifact(attempt.artifactId)">{{
                            l("查看失败截图", "View failure screenshot")
                        }}</ElButton
                        ><span v-else>{{ attempt.screenshotReason || l("未生成截图", "No screenshot") }}</span>
                    </p>
                </div>
                <ElPagination
                    v-model:current-page="taskPage"
                    :page-size="25"
                    :total="taskTotal"
                    layout="prev, pager, next"
                    @current-change="loadHistory"
                />
            </ElDialog>
            <ElDialog
                v-model="imageVisible"
                class="account-dialog"
                :title="l('失败截图', 'Failure screenshot')"
                :width="mobile ? 'calc(100vw - 24px)' : '85%'"
                @closed="releaseImage"
                ><img v-if="imageUrl" :src="imageUrl" style="width: 100%"
            /></ElDialog>
        </template>
    </section>
</template>
<script setup>
import PageHeader from "../components/common/PageHeader.vue";
import PageState from "../components/common/PageState.vue";
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();
const loaded = ref(false),
    loadError = ref(false);
import { useDraftGuard } from "../composables/useDraftGuard";
import { computed, nextTick, ref, reactive, watch, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import AccountTierBadge from "../components/AccountTierBadge.vue";
import I18n from "../utils/i18n";
const router = useRouter();
defineProps({
    accountDetails: { default: () => [], type: Array },
    currentAuthIndex: { default: -1, type: Number },
    isBusy: { default: false, type: Boolean },
    legacyActions: { default: () => ({}), type: Object },
    schedulingMode: { default: null, type: String },
});
const benefitTasks = ref([]);
const tierNames = { free: "Free", pro: "Pro", ultra: "Ultra 5x", ultra20: "Ultra 20x" };
const benefitState = value =>
    ({
        cancelled: l("已取消", "Cancelled"),
        failed: l("失败", "Failed"),
        queued: l("排队", "Queued"),
        running: l("检测中", "Checking"),
        succeeded: l("成功", "Succeeded"),
        waiting: l("等待账号空闲", "Waiting for account"),
    })[value] || l("未检测", "Not checked");
async function checkBenefits(rows) {
    await action(async () => {
        const result = await api("/benefit-checks", "POST", { accountIds: rows.map(row => row.accountId) });
        const rejected = result.results.filter(item => item.status === "rejected");
        if (rejected.length) ElMessage.warning(rejected.map(item => `${item.accountId}: ${item.reason}`).join("; "));
        await refresh();
    });
}
async function cancelBenefits(accountIds) {
    await action(async () => {
        await api("/benefit-checks/cancel", "POST", { accountIds });
        await refresh();
    });
}
const accountTable = ref(null);
const mobile = ref(window.matchMedia("(max-width: 768px)").matches);
const mobileQuery = window.matchMedia("(max-width: 768px)");
const updateMobile = event => {
    mobile.value = event.matches;
};

const l = (zh, en) => (I18n.getLang() === "zh" ? zh : en);
const text = (key, zh, en) => I18n.t(key, { fallback: l(zh, en) });
const labels = {
    cancelled: ["已取消", "Cancelled"],
    credentials_missing: ["缺少凭据", "Credentials missing"],
    duplicate: ["重复", "Duplicate"],
    expired: ["已过期", "Expired"],
    failed: ["失败", "Failed"],
    idle: ["空闲", "Idle"],
    manual_required: ["需人工处理", "Manual required"],
    missing: ["无会话", "Missing"],
    not_logged_in: ["未登录", "Not logged in"],
    queued: ["排队", "Queued"],
    retry_wait: ["等待重试", "Retry wait"],
    running: ["登录中", "Running"],
    succeeded: ["成功", "Succeeded"],
    valid: ["有效", "Valid"],
};
const stateLabel = value => (labels[value] ? l(...labels[value]) : value);
const accounts = ref([]),
    total = ref(0),
    page = ref(1),
    pageSize = ref(20),
    search = ref(""),
    filter = ref(""),
    selected = ref([]),
    queue = ref({}),
    autoRecoveryDraft = ref(true),
    queueConfigBase = ref(null),
    queueConfigConflict = ref(false),
    concurrency = ref(1),
    now = ref(Date.now());
const editVisible = ref(false),
    editing = ref(null),
    busy = ref(false),
    form = reactive({
        clearPassword: false,
        clearRecoveryEmail: false,
        clearTotpSecret: false,
        email: "",
        loginNow: false,
        manualTier: "",
        password: "",
        recoveryEmail: "",
        totpSecret: "",
    });
const importVisible = ref(false),
    skipExisting = ref(true),
    importKind = ref("csv"),
    importBusy = ref(false),
    importContent = ref(""),
    preview = ref(null),
    choices = ref([]),
    importResult = ref(null),
    mappingAccounts = ref([]);
const historyVisible = ref(false),
    historyAccount = ref(null),
    tasks = ref([]),
    taskPage = ref(1),
    taskTotal = ref(0),
    imageVisible = ref(false),
    imageUrl = ref("");
const loginSubmitting = ref(false),
    cancelling = ref(false),
    cancelResult = ref(null),
    stoppingIds = ref([]);
const suppressedLogins = new Set();
const pendingLogins = new Map();
const selectedIds = computed(() => new Set(selected.value.map(row => row.accountId)));
const isSelected = row => selectedIds.value.has(row.accountId);
const pageSelected = computed(() => !!accounts.value.length && accounts.value.every(isSelected));
const pagePartial = computed(() => !pageSelected.value && accounts.value.some(isSelected));
function toggleAccount(row, value) {
    invalidateSelection();
    selected.value = selected.value.filter(account => account.accountId !== row.accountId);
    if (value) selected.value.push(row);
    syncSelection();
}
function togglePage(value) {
    invalidateSelection();
    const visibleIds = new Set(accounts.value.map(row => row.accountId));
    selected.value = selected.value.filter(row => !visibleIds.has(row.accountId));
    if (value) selected.value.push(...accounts.value);
    syncSelection();
}
const selectingAll = ref(false);
let selectionSequence = 0;
let syncingSelection = false;
function updatePageSelection(rows) {
    if (syncingSelection) return;
    invalidateSelection();
    const visibleIds = new Set(accounts.value.map(row => row.accountId));
    const selectedIds = new Set(rows.map(row => row.accountId));
    selected.value = [
        ...selected.value.filter(row => !visibleIds.has(row.accountId)),
        ...accounts.value.filter(row => selectedIds.has(row.accountId)),
    ];
}
async function syncSelection() {
    syncingSelection = true;
    await nextTick();
    const ids = new Set(selected.value.map(row => row.accountId));
    accountTable.value?.clearSelection();
    for (const row of accounts.value) accountTable.value?.toggleRowSelection(row, ids.has(row.accountId));
    await nextTick();
    syncingSelection = false;
}
async function selectAll() {
    const sequence = ++selectionSequence;
    const query = `search=${encodeURIComponent(search.value || "")}&state=${encodeURIComponent(filter.value || "")}`;
    selectingAll.value = true;
    try {
        await action(async () => {
            const result = await api(`/accounts/selection?${query}`);
            if (disposed || sequence !== selectionSequence) return;
            selected.value = [...new Map(result.accounts.map(row => [row.accountId, row])).values()];
            await syncSelection();
        });
    } finally {
        if (sequence === selectionSequence) selectingAll.value = false;
    }
}
function removeSelection(rows) {
    const ids = new Set(rows.map(row => row.accountId));
    selected.value = selected.value.filter(row => !ids.has(row.accountId));
    syncSelection();
}
function invalidateSelection() {
    selectionSequence++;
    selectingAll.value = false;
}
function clearSelection() {
    invalidateSelection();
    selected.value = [];
    syncSelection();
}
const importLocked = computed(() => importBusy.value || !!importResult.value);
const actionableRows = computed(() => (preview.value?.rows || []).filter(row => !row.error && !row.unchanged));
const protectedRow = row =>
    skipExisting.value && (!!choices.value[row.index]?.accountId || !!row.accountId || row.matches > 0);
const effectiveSkip = row => protectedRow(row) || !!choices.value[row.index]?.skip;
const unprotectedRows = computed(() => actionableRows.value.filter(row => !protectedRow(row)));
const overwriteRows = computed(() => unprotectedRows.value.filter(row => choices.value[row.index]?.accountId));
function bulkState(rows, key) {
    const count = rows.filter(row => (key === "skip" ? effectiveSkip(row) : choices.value[row.index]?.[key])).length;
    return { checked: !!rows.length && count === rows.length, partial: count > 0 && count < rows.length };
}
const skipState = computed(() => bulkState(actionableRows.value, "skip"));
const overwriteState = computed(() => bulkState(overwriteRows.value, "overwrite"));
function bulkChoice(rows, key, value) {
    for (const row of rows) choices.value[row.index][key] = value;
}
let timer,
    polling = false,
    disposed = false,
    refreshSequence = 0;
async function api(path, method = "GET", body) {
    const response = await fetch(`/api/account-management${path}`, {
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || String(response.status));
    }
    return response.json();
}
async function action(work) {
    try {
        await work();
    } catch (cause) {
        if (cause !== "cancel" && cause !== "close") ElMessage.error(cause.message);
    }
}
async function refresh() {
    const sequence = ++refreshSequence;
    await action(async () => {
        try {
            const selectionVersion = selectionSequence;
            const [list, status, selection, benefits] = await Promise.all([
                api(
                    `/accounts?page=${page.value}&pageSize=${pageSize.value}&search=${encodeURIComponent(search.value || "")}&state=${encodeURIComponent(filter.value || "")}`
                ),
                api("/login-queue"),
                selected.value.length ? api("/accounts/selection") : null,
                api("/benefit-checks"),
            ]);
            if (disposed || sequence !== refreshSequence) return;
            const lastPage = Math.max(1, Math.ceil(list.total / pageSize.value));
            if (page.value > lastPage) {
                page.value = lastPage;
                return;
            }
            syncingSelection = true;
            accounts.value = list.accounts;
            benefitTasks.value = benefits.tasks || [];
            const edited = list.accounts.find(account => account.accountId === editing.value?.accountId);
            if (edited)
                for (const key of ["benefitObservation", "benefitLastCheck", "tier", "benefitTask"])
                    editing.value[key] = edited[key];
            const refreshed = new Map(list.accounts.map(account => [account.accountId, account]));
            if (selection && selectionVersion === selectionSequence) {
                const existing = new Map(selection.accounts.map(account => [account.accountId, account]));
                selected.value = selected.value
                    .filter(account => existing.has(account.accountId))
                    .map(account => existing.get(account.accountId));
            } else selected.value = selected.value.map(account => refreshed.get(account.accountId) || account);
            await syncSelection();
            total.value = list.total;
            stoppingIds.value = stoppingIds.value.filter(
                id =>
                    list.accounts.find(row => row.accountId === id)?.loginStopping ||
                    status.executions?.some(execution => execution.accountId === id)
            );
            loaded.value = true;
            loadError.value = false;
            queue.value = status;
            const base = queueConfigBase.value;
            const dirty =
                base && (autoRecoveryDraft.value !== base.autoRecovery || concurrency.value !== base.concurrency);
            if (!dirty) {
                concurrency.value = status.concurrency;
                autoRecoveryDraft.value = status.autoRecovery;
                queueConfigBase.value = {
                    autoRecovery: status.autoRecovery,
                    concurrency: status.concurrency,
                    version: status.configurationVersion,
                };
                queueConfigConflict.value = false;
            } else if (base.version !== status.configurationVersion) queueConfigConflict.value = true;
        } catch (error) {
            if (!disposed && sequence === refreshSequence) loadError.value = true;
            throw error;
        }
    });
}
watch([search, filter, pageSize, page], (values, previous) => {
    if (values[0] !== previous[0] || values[1] !== previous[1]) clearSelection();
    if (values.slice(0, 3).some((value, index) => value !== previous[index]) && page.value !== 1) {
        page.value = 1;
        return;
    }
    refresh();
});
defineExpose({ refresh });
async function saveQueueConfiguration() {
    if (queueConfigConflict.value)
        return ElMessage.error(
            l(
                "配置已被其他页面修改，请刷新并处理草稿差异",
                "Settings changed elsewhere; refresh and resolve your draft"
            )
        );
    const values = { version: queueConfigBase.value?.version };
    if (autoRecoveryDraft.value !== queueConfigBase.value?.autoRecovery) values.autoRecovery = autoRecoveryDraft.value;
    if (concurrency.value !== queueConfigBase.value?.concurrency) values.concurrency = concurrency.value;
    if (Object.keys(values).length > 1) await configure(values);
}
async function discardQueueDraft() {
    queueConfigBase.value = null;
    await refresh();
}
async function configure(values) {
    busy.value = true;
    await action(async () => {
        queue.value = await api("/login-queue", "PATCH", values);
        if (values.version !== undefined) queueConfigBase.value = null;
        await refresh();
    });
    busy.value = false;
}
function clearForm() {
    Object.assign(form, {
        clearPassword: false,
        clearRecoveryEmail: false,
        clearTotpSecret: false,
        email: "",
        loginNow: false,
        manualTier: "",
        password: "",
        recoveryEmail: "",
        totpSecret: "",
    });
    editing.value = null;
}
function openNew() {
    clearForm();
    editVisible.value = true;
}
function openEdit(account) {
    clearForm();
    releaseImage();
    editing.value = account;
    form.email = account.email || "";
    form.manualTier = account.manualTier || "";
    editVisible.value = true;
}
async function reveal() {
    await action(async () => {
        const result = await api(`/accounts/${editing.value.accountId}/credentials`);
        form.password = result.password || "";
        form.recoveryEmail = result.recoveryEmail || "";
        form.totpSecret = result.totpSecret || "";
        editing.value = { ...editing.value, credentialVersion: result.credentialVersion };
    });
}
async function save() {
    busy.value = true;
    await action(async () => {
        const body = {
            ...(!editing.value || form.email !== (editing.value.email || "") ? { email: form.email } : {}),
            manualTier: form.manualTier || null,
            ...(form.recoveryEmail ? { recoveryEmail: form.recoveryEmail } : {}),
            ...(form.password ? { password: form.password } : {}),
            ...(form.totpSecret ? { totpSecret: form.totpSecret } : {}),
        };
        if (editing.value) {
            if (form.clearPassword) delete body.password;
            if (form.clearRecoveryEmail) delete body.recoveryEmail;
            if (form.clearTotpSecret) delete body.totpSecret;
            await api(`/accounts/${editing.value.accountId}/credentials`, "PATCH", {
                ...body,
                clearPassword: form.clearPassword,
                clearRecoveryEmail: form.clearRecoveryEmail,
                clearTotpSecret: form.clearTotpSecret,
                credentialVersion: editing.value.credentialVersion,
            });
            if (form.loginNow) await api(`/accounts/${editing.value.accountId}/login`, "POST", {});
        } else await api("/accounts", "POST", body);
        editVisible.value = false;
        clearForm();
        await refresh();
    });
    busy.value = false;
}
async function login(account) {
    await action(async () => {
        await api(`/accounts/${account.accountId}/login`, "POST", {});
        await refresh();
    });
}
async function batchLogin() {
    if (loginSubmitting.value || cancelling.value) return;
    const ids = selected.value.map(row => row.accountId);
    suppressedLogins.clear();
    loginSubmitting.value = true;
    try {
        for (const id of ids) {
            if (disposed || suppressedLogins.has(id)) continue;
            const request = api(`/accounts/${id}/login`, "POST", {});
            pendingLogins.set(id, request);
            await action(() => request);
            pendingLogins.delete(id);
        }
    } finally {
        loginSubmitting.value = false;
        await refresh();
    }
}
async function batchCancelLogin() {
    if (cancelling.value) return;
    const ids = selected.value.map(row => row.accountId);
    for (const id of ids) suppressedLogins.add(id);
    cancelling.value = true;
    try {
        // Wait for dispatched requests so their newly created tasks are included in cancellation.
        await Promise.allSettled(ids.map(id => pendingLogins.get(id)).filter(Boolean));
        await action(async () => {
            cancelResult.value = await api("/accounts/batch/cancel-login", "POST", { accountIds: ids });
            stoppingIds.value = cancelResult.value.results
                .filter(row => row.status === "stopping")
                .map(row => row.accountId);
            await refresh();
        });
    } finally {
        cancelling.value = false;
    }
}
async function cancel(id) {
    await action(async () => {
        await api(`/login-tasks/${id}/cancel`, "POST", {});
        await refresh();
        if (historyVisible.value) await loadHistory();
    });
}
async function toggleRecovery(account, autoRecovery) {
    await action(async () => {
        await api(`/accounts/${account.accountId}/credentials`, "PATCH", {
            autoRecovery,
            credentialVersion: account.credentialVersion,
        });
        await refresh();
    });
}
async function batchRecovery(autoRecovery) {
    const rows = selected.value.slice();
    await action(async () => {
        await api("/accounts/batch/recovery", "PATCH", {
            accounts: rows.map(row => ({ accountId: row.accountId, credentialVersion: row.credentialVersion })),
            autoRecovery,
        });
        await refresh();
        ElMessage.success(l("已更新自动恢复设置", "Auto recovery updated"));
    });
}
async function saveDownload(endpoint, filename, body) {
    const response = await fetch(`/api/account-management${endpoint}`, {
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error((await response.json()).error || String(response.status));
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportCredentials() {
    await action(() =>
        saveDownload(
            "/export/credentials",
            "credentials.csv",
            selected.value.length ? { accountIds: selected.value.map(row => row.accountId) } : { all: true }
        )
    );
}
async function downloadBundle() {
    await action(() =>
        saveDownload("/export/bundle", "accounts.zip", { accountIds: selected.value.map(row => row.accountId) })
    );
}
async function downloadCookie(row) {
    await action(() => saveDownload(`/accounts/${row.accountId}/download`, `auth-${row.authIndex}.json`));
}
async function deleteRows(rows) {
    const chosen = rows.slice();
    await action(async () => {
        await ElMessageBox.confirm(
            l(
                `删除选中的 ${chosen.length} 个账号及其已保存的会话和凭据？`,
                `Delete ${chosen.length} selected accounts and their sessions and credentials?`
            )
        );
        busy.value = true;
        try {
            const indices = chosen.filter(row => row.authIndex !== null).map(row => row.authIndex);
            if (indices.length) {
                const remove = force =>
                    fetch("/api/accounts/batch", {
                        body: JSON.stringify({ force, indices }),
                        headers: { Accept: "application/json", "Content-Type": "application/json" },
                        method: "DELETE",
                    });
                let response = await remove(false);
                let result = await response.json();
                if (response.status === 409 && result.requiresConfirmation) {
                    await ElMessageBox.confirm(
                        l(
                            "包含当前使用中的账号，确认删除并关闭对应连接？",
                            "Includes the active account. Delete it and close its connections?"
                        )
                    );
                    response = await remove(true);
                    result = await response.json();
                }
                if (result.successIndices)
                    removeSelection(chosen.filter(row => result.successIndices.includes(row.authIndex)));
                if (!response.ok || response.status === 207)
                    throw new Error(
                        result.error ||
                            l(
                                "部分账号未能删除，请刷新后重试",
                                "Some accounts could not be deleted. Refresh and retry."
                            )
                    );
            }
            for (const row of chosen.filter(row => row.authIndex === null)) {
                await api(`/accounts/${row.accountId}`, "DELETE");
                removeSelection([row]);
            }
            ElMessage.success(l("已删除", "Deleted"));
        } finally {
            busy.value = false;
            await refresh();
        }
    });
}
async function readImportFile(event) {
    await action(async () => {
        const file = event.target.files[0];
        if (file?.size > 1048576) throw new Error("Import exceeds 1 MiB");
        if (file) importContent.value = await file.text();
        event.target.value = "";
    });
}
async function previewImport() {
    await action(async () => {
        importResult.value = null;
        preview.value = await api("/import/preview", "POST", { content: importContent.value, kind: importKind.value });
        importContent.value = "";
        choices.value = preview.value.rows.map(row => ({
            accountId: row.accountId,
            index: row.index,
            overwrite: false,
            skip: !!row.error || !!row.unchanged,
        }));
        mappingAccounts.value = [];
        let cursor = 1,
            list;
        do {
            list = await api(`/accounts?page=${cursor++}&pageSize=100`);
            mappingAccounts.value.push(...list.accounts);
        } while (mappingAccounts.value.length < list.total);
    });
}
async function commitImport() {
    if (importLocked.value || !preview.value?.complete) return;
    importBusy.value = true;
    try {
        await action(async () => {
            importResult.value = await api("/import/commit", "POST", {
                previewId: preview.value.previewId,
                rows: choices.value.map(choice => ({
                    ...choice,
                    skip: effectiveSkip(preview.value.rows[choice.index]),
                })),
                skipExisting: skipExisting.value,
            });
            await refresh();
        });
    } finally {
        importBusy.value = false;
    }
}
function clearImport() {
    skipExisting.value = true;
    importContent.value = "";
    preview.value = null;
    choices.value = [];
    importResult.value = null;
}
async function viewHistory(account) {
    releaseImage();
    historyAccount.value = account.accountId;
    taskPage.value = 1;
    historyVisible.value = true;
    await loadHistory();
}
async function loadHistory() {
    await action(async () => {
        const result = await api(`/login-tasks?accountId=${historyAccount.value}&page=${taskPage.value}`);
        tasks.value = result.tasks;
        taskTotal.value = result.total;
    });
}
function releaseImage() {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
    imageUrl.value = "";
    imageVisible.value = false;
}
async function showArtifact(id) {
    releaseImage();
    await action(async () => {
        const response = await fetch(`/api/account-management/artifacts/${id}`, {
            headers: { Accept: "application/json" },
        });
        if (!response.ok)
            throw new Error(
                response.status === 410
                    ? l("截图已过期", "Screenshot expired")
                    : l("截图不可用", "Screenshot unavailable")
            );
        imageUrl.value = URL.createObjectURL(await response.blob());
        imageVisible.value = true;
    });
}
onMounted(async () => {
    mobileQuery.addEventListener("change", updateMobile);
    await refresh();
    if (disposed) return;
    timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        now.value = Date.now();
        try {
            await refresh();
            if (historyVisible.value) await loadHistory();
        } finally {
            polling = false;
        }
    }, 5000);
});
onBeforeUnmount(() => {
    mobileQuery.removeEventListener("change", updateMobile);
    disposed = true;
    selectionSequence++;
    clearInterval(timer);
    releaseImage();
    clearForm();
    clearImport();
});

useDraftGuard(
    () =>
        queueConfigBase.value &&
        (autoRecoveryDraft.value !== queueConfigBase.value.autoRecovery ||
            concurrency.value !== queueConfigBase.value.concurrency)
);
</script>
<style scoped>
.accounts-panel {
    margin-bottom: 24px;
    min-width: 0;
    max-width: 100%;
}
.account-toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin: 12px 0;
}
.account-toolbar > .el-input {
    max-width: 280px;
}
.account-toolbar > .el-select {
    width: 200px;
}
.row-actions,
.queue-toggle,
.account-badges {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
}
.row-actions :deep(.el-button) {
    margin-left: 0;
}
.account-name {
    overflow-wrap: anywhere;
}
.account-badges {
    margin-top: 4px;
}
.failure-reason {
    display: block;
    overflow-wrap: anywhere;
}
.state-text {
    font-weight: 600;
}
.state-valid,
.state-succeeded {
    color: var(--el-color-success);
}
.state-expired,
.state-failed,
.state-manual_required {
    color: var(--el-color-danger);
}
.state-queued,
.state-retry_wait,
.state-credentials_missing {
    color: var(--el-color-warning);
}
.state-running {
    color: var(--el-color-primary);
}
.state-idle,
.state-missing,
.state-cancelled {
    color: var(--el-text-color-secondary);
}
.queue-card {
    margin: 16px 0;
}
small {
    overflow-wrap: anywhere;
    color: var(--text-muted);
}

.account-table-scroll {
    max-width: 100%;
    overflow-x: auto;
}
.account-toolbar :deep(.el-button),
.import-row-actions :deep(.el-checkbox) {
    margin-left: 0;
    margin-right: 0;
}
.import-settings,
.import-row-notes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
    overflow-wrap: anywhere;
}
.import-row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
}
:global(.account-dialog) {
    max-width: calc(100vw - 24px);
}
.account-mobile-list,
.import-mobile-list {
    display: none;
}
@media (max-width: 768px) {
    .account-table-scroll,
    .import-preview-table {
        display: none;
    }
    .account-mobile-list,
    .import-mobile-list {
        display: grid;
        gap: 12px;
    }
    .account-mobile-card {
        background: var(--el-bg-color);
        border: 1px solid var(--el-border-color-light);
        border-radius: 8px;
        padding: 12px;
        min-width: 0;
    }
    .mobile-account-heading,
    .mobile-credentials {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
    }
    .mobile-account-heading {
        flex-wrap: nowrap;
    }
    .mobile-account-heading .account-name {
        min-width: 0;
    }
    .import-mapping {
        margin: 8px 0;
    }
    .import-mobile-list {
        margin-top: 12px;
    }
    .account-mobile-card .row-actions {
        margin-top: 12px;
    }

    .account-toolbar > .el-input,
    .account-toolbar > .el-select {
        width: 100%;
        max-width: none;
    }
    .batch-toolbar > span {
        width: 100%;
    }
    .account-toolbar {
        gap: 8px;
    }
    .queue-card :deep(.el-card__body) {
        padding: 12px;
    }
    .accounts-panel > .el-pagination {
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
    }
    :global(.account-dialog) {
        width: calc(100vw - 24px);
        margin-top: 4vh;
    }
    :global(.account-dialog .el-dialog__body) {
        max-height: 75vh;
        overflow: auto;
    }
    :global(.account-dialog .el-select),
    :global(.account-dialog input[type="file"]) {
        max-width: 100%;
    }
}
</style>
