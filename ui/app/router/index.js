/**
 * File: ui/app/router/index.js
 * Description: Vue Router configuration for the application, defining all routes and navigation behavior
 *
 * Author: Ellinav, iBenzene, bbbugg
 */

import { createRouter, createWebHistory } from 'vue-router';
import LoginPage from '../pages/LoginPage.vue';
import StatusPage from '../pages/StatusPage.vue';
import AuthPage from '../pages/AuthPage.vue';
import NotFound from '../pages/NotFound.vue';

const routes = [
    ...['usage', 'logs', 'settings'].map(name => ({ component: StatusPage, name, path: `/${name}` })),
    { component: StatusPage, name: 'proxy-pool', path: '/proxy-pool' },
    {
        component: StatusPage,
        name: 'accounts',
        path: '/accounts',
    },
    {
        component: StatusPage,
        name: 'status',
        path: '/',
    },
    {
        component: LoginPage,
        name: 'login',
        path: '/login',
    },
    {
        component: AuthPage,
        name: 'auth',
        path: '/auth',
    },
    {
        component: NotFound,
        name: 'not-found',
        path: '/:pathMatch(.*)*',
    },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior() {
        return { left: 0, top: 0 };
    },
});

let isAuthenticated = null;

router.beforeEach(async (to, from, next) => {
    if (to.name === 'login') {
        return next();
    }

    if (isAuthenticated === null) {
        try {
            const res = await fetch('/api/status');
            // If the request was redirected (e.g. to /login), the user is not authenticated
            if (res.redirected) {
                isAuthenticated = false;
                return next({ name: 'login' });
            }

            if (res.ok) {
                isAuthenticated = true;
                return next();
            } else {
                if (res.status === 401 || res.status === 403) {
                    isAuthenticated = false;
                    return next({ name: 'login' });
                }
                // Let the workspace show service failures, and retry authentication on the next navigation.
                return next();
            }
        } catch (error) {
            console.error('Failed to check auth status:', error);
            return next();
        }
    }

    if (isAuthenticated) {
        return next();
    } else {
        return next({ name: 'login' });
    }
});

export default router;
