import { onBeforeUnmount, onMounted } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import I18n from '../utils/i18n';

// Each mounted editor owns its draft. Query/hash changes within a page keep it intact.
export function useDraftGuard(isDirty) {
    let confirmation = null;
    const guard = (to, from) => {
        if (to.path === from.path || !isDirty()) return true;
        if (!confirmation) {
            confirmation = ElMessageBox.confirm(I18n.t('adminUnsavedMessage'), I18n.t('adminUnsavedTitle'), {
                cancelButtonText: I18n.t('adminContinueEditing'),
                confirmButtonText: I18n.t('adminDiscardLeave'),
                type: 'warning',
            })
                .then(
                    () => true,
                    () => false
                )
                .finally(() => {
                    confirmation = null;
                });
        }
        return confirmation;
    };
    onBeforeRouteLeave(guard);
    onBeforeRouteUpdate(guard);
    const beforeUnload = event => {
        if (!isDirty()) return;
        event.preventDefault();
        event.returnValue = '';
    };
    onMounted(() => window.addEventListener('beforeunload', beforeUnload));
    onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
}
