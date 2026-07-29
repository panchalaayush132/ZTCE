'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { resolveApiBase } from '../lib/api-base';

export default function Home() {
    const [operatorSessionId, setoperatorSessionId] = useState('');
    const [operatorName, setoperatorName] = useState('');
    const [joinError, setJoinError] = useState('');
    const [joinStatus, setJoinStatus] = useState('');
    const [joining, setJoining] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const params = new URLSearchParams(window.location.search);
        const sessionFromUrl = params.get('sessionId');
        if (sessionFromUrl && !operatorSessionId) {
            setoperatorSessionId(sessionFromUrl);
        }
    }, [operatorSessionId]);

    const apiBase = useMemo(() => {
        return resolveApiBase(process.env.NEXT_PUBLIC_API_BASE);
    }, []);

    const runtimeApiBase = useMemo(() => {
        if (typeof window === 'undefined') {
            return '';
        }

        const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
        return `${protocol}://${window.location.hostname}:8000/api`;
    }, []);

    const getHost = (url: string) => {
        try {
            return new URL(url).hostname;
        } catch {
            return '';
        }
    };

    const toUsername = (name: string) => {
        const normalized = name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');

        return normalized || `operator_${Date.now().toString().slice(-6)}`;
    };

    const handleJoinSession = async () => {
        const cleanSessionId = operatorSessionId.trim();
        const cleanName = operatorName.trim();

        if (!cleanSessionId || !cleanName) {
            setJoinError('Please enter both Session ID and operator Name.');
            return;
        }

        setJoining(true);
        setJoinError('');
        setJoinStatus('Joining session...');

        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            controller.abort('join-timeout');
        }, 12000);

        const tryJoin = async (baseUrl: string) => {
            const res = await fetch(`${baseUrl}/operators/add_operator/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    session_id: cleanSessionId,
                    username: toUsername(cleanName),
                    name: cleanName,
                }),
            });

            const contentType = res.headers.get('content-type') || '';
            const data = contentType.includes('application/json')
                ? await res.json()
                : { error: await res.text() };

            return { res, data };
        };

        const canUseRuntimeFallback =
            runtimeApiBase &&
            runtimeApiBase !== apiBase &&
            getHost(runtimeApiBase) &&
            getHost(runtimeApiBase) !== getHost(apiBase);

        try {
            let activeBase = apiBase;
            let { res, data } = await tryJoin(activeBase);

            const shouldFallbackOn404 =
                canUseRuntimeFallback &&
                !res.ok &&
                res.status === 404;

            if (shouldFallbackOn404) {
                activeBase = runtimeApiBase;
                ({ res, data } = await tryJoin(activeBase));
            }

            if (!res.ok) {
                const message = data?.error || data?.detail || 'Unable to join session. Check Session ID.';
                setJoinError(message);
                setJoinStatus('');
                return;
            }

            if (!data?.id) {
                setJoinError('Session joined but operator details were not returned. Please try again.');
                setJoinStatus('');
                return;
            }

            setJoinStatus('Connected. Redirecting...');
            // Use session_id from response (server returns actual UUID regardless of token input)
            const sessionUuid = data.session_id || cleanSessionId;
            window.location.href = `/workspace/${sessionUuid}/${data.id}`;
        } catch (err) {
            const isAbortError = err instanceof DOMException && err.name === 'AbortError';
            const isTimeoutReason = err === 'join-timeout';

            if (isAbortError || isTimeoutReason) {
                if (!timedOut) {
                    // Request was aborted for a non-timeout reason (e.g. navigation/unmount).
                    setJoinStatus('');
                    return;
                }
                setJoinError('Request timed out. Check backend server and try again.');
            } else {
                const detail = err instanceof Error ? err.message : 'Unknown network error';
                if (canUseRuntimeFallback) {
                    try {
                        const { res, data } = await tryJoin(runtimeApiBase);
                        if (res.ok && data?.id) {
                            setJoinStatus('Connected. Redirecting...');
                            const sessionUuid = data.session_id || cleanSessionId;
                            window.location.href = `/workspace/${sessionUuid}/${data.id}`;
                            return;
                        }
                    } catch {
                        // Ignore fallback error and show original network failure below.
                    }
                }

                setJoinError(`Failed to connect to ${apiBase}. ${detail}`);
                console.error('Join session failed:', err);
            }
            setJoinStatus('');
        } finally {
            clearTimeout(timeout);
            setJoining(false);
        }
    };

    const handleJoinSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (!joining) {
            handleJoinSession();
        }
    };

    return (
        <div className={styles.container}>
            <div className={styles.operatorPanel}>
                <h1>🔐 Operator Access</h1>
                <p>Join your secure session by entering the Session ID/token and your name.</p>

                <form className={styles.operatorForm} onSubmit={handleJoinSubmit}>
                    <input
                        type="text"
                        placeholder="Session ID or Session Token"
                        value={operatorSessionId}
                        onChange={(e) => setoperatorSessionId(e.target.value)}
                        className={styles.input}
                    />
                    <input
                        type="text"
                        placeholder="Your Name"
                        value={operatorName}
                        onChange={(e) => setoperatorName(e.target.value)}
                        className={styles.input}
                    />

                    {joinError && <p className={styles.errorText}>{joinError}</p>}
                    {joinStatus && <p className={styles.statusText}>{joinStatus}</p>}

                    <button
                        type="submit"
                        disabled={joining}
                        className={styles.primaryBtn}
                    >
                        {joining ? 'Connecting...' : 'Connect to Session'}
                    </button>
                </form>

                <p className={styles.hintText}>Use either Session ID (UUID) or Session Token from the Command Center.</p>
                <div className={styles.homeButtons}>
                    <Link href="/command-center" className={styles.secondaryBtn}>Command Center</Link>
                </div>
            </div>
        </div>
    );
}

