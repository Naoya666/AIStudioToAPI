import { onBeforeUnmount, ref } from 'vue';
import I18n from '../utils/i18n';

export function useI18n() {
    const version = ref(0);
    const unsubscribe = I18n.onChange(() => version.value++);
    onBeforeUnmount(unsubscribe);
    const t = (key, options) => {
        version.value;
        return I18n.t(key, options);
    };
    return { t };
}
