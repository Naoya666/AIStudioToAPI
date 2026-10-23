<!--
 * File: ui/app/pages/NotFound.vue
 * Description: 404 Not Found page component for handling invalid routes
 *
 * Author: iBenzene
-->

<template>
    <div class="not-found">
        <PageState :message="t('adminNotFoundDescription')">
            <h1>{{ t("adminNotFound") }}</h1>
            <router-link to="/">{{ t("adminOverview") }}</router-link>
        </PageState>
    </div>
</template>
<script setup>
import PageState from "../components/common/PageState.vue";
import { useI18n } from "../composables/useI18n";
const { t } = useI18n();
</script>
<style scoped>
.not-found {
    min-height: 100vh;
    display: grid;
    place-content: center;
    padding: 16px;
}
</style>
