/**
 * ZTCE API Base Resolution
 * ━━━━━━━━━━━━━━━━━━━━━━━━
 * Intelligent API base URL resolution for air-gapped networks.
 * Automatically detects whether the client is on localhost or LAN
 * and resolves the correct backend URL without internet access.
 */

const API_BASE_STORAGE_KEY = 'ztce_api_base_v1';

const DEFAULT_API_BASE = 'http://127.0.0.1:8000/api';

function isLoopbackHost(hostname: string) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function normalizeApiBase(rawBase: string) {
    const trimmed = rawBase.trim().replace(/\/+$/, '');

    if (!trimmed) {
        return '';
    }

    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.replace(/\/+$/, '');
        url.pathname = pathname.endsWith('/api') ? pathname : `${pathname}/api`;
        return url.toString().replace(/\/+$/, '');
    } catch {
        return trimmed;
    }
}

export function getStoredApiBase() {
    if (typeof window === 'undefined') {
        return '';
    }

    try {
        return normalizeApiBase(window.localStorage.getItem(API_BASE_STORAGE_KEY) || '');
    } catch {
        return '';
    }
}

export function setStoredApiBase(rawBase: string) {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        const normalized = normalizeApiBase(rawBase);
        if (normalized) {
            window.localStorage.setItem(API_BASE_STORAGE_KEY, normalized);
        } else {
            window.localStorage.removeItem(API_BASE_STORAGE_KEY);
        }
    } catch {
        // Ignore storage failures in restricted environments.
    }
}

export function resolveApiBase(envBase?: string) {
    if (typeof window === 'undefined') {
        return normalizeApiBase(envBase || DEFAULT_API_BASE);
    }

    const runtimeHost = (window.location.hostname || '').trim() || '127.0.0.1';
    const runtimeIsLoopback = isLoopbackHost(runtimeHost);
    const storedBase = getStoredApiBase();
    if (storedBase) {
        try {
            const storedHost = new URL(storedBase).hostname;
            const storedIsLoopback = isLoopbackHost(storedHost);

            // On LAN/remote clients, ignore loopback values that cannot reach the host backend.
            if (!runtimeIsLoopback && storedIsLoopback) {
                // Fall through to env/runtime-derived base.
            } else if (!(runtimeIsLoopback && !storedIsLoopback)) {
                // On localhost development, ignore stale non-loopback values saved from other networks.
                return storedBase;
            }
        } catch {
            if (!runtimeIsLoopback) {
                return storedBase;
            }
        }
    }

    if (!envBase) {
        return `http://${runtimeHost}:8000/api`;
    }

    try {
        const parsed = new URL(envBase);
        if (isLoopbackHost(parsed.hostname)) {
            const configuredPort = parsed.port || '8000';
            return `http://${runtimeHost}:${configuredPort}/api`;
        }

        return normalizeApiBase(envBase);
    } catch {
        return `http://${runtimeHost}:8000/api`;
    }
}
