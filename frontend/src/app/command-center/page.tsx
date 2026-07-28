'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import styles from './command-center.module.css';
import { getStoredApiBase, resolveApiBase, setStoredApiBase } from '../../lib/api-base';
import Whiteboard from '../../components/Whiteboard';
import TestCreator from '../../components/TestCreator';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const PdfWhiteboard = dynamic(() => import('../../components/PdfWhiteboard'), { ssr: false });

interface Session {
    id: string;
    creator_name: string;
    ai_enabled: boolean;
    autocomplete_enabled: boolean;
    leaderboard_visible?: boolean;
    allow_operator_download?: boolean;
    operator_count: number;
    active_operators: number;
    session_token: string;
    operators?: operator[];
}

interface operator {
    id: string;
    username: string;
    name: string;
    is_online: boolean;
    current_activity?: { status: string; message: string };
}

interface operatorFile {
    id: string;
    filename: string;
    content: string;
    version: number;
}

interface ExecutionResult {
    stdout: string;
    stderr: string;
    return_code: number;
    execution_time: number;
}

interface SessionTask {
    id: string;
    session: string;
    assigned_operator_id?: string;
    assigned_operator_name?: string;
    title: string;
    description: string;
    status: 'todo' | 'in_progress' | 'blocked' | 'done';
    priority: 'low' | 'medium' | 'high' | 'critical';
    created_by: string;
    due_at?: string;
    version: number;
}

interface BroadcastFile {
    id: string;
    filename: string;
    file_url: string | null;
    file_type: string;
    uploaded_at: string;
    is_active: boolean;
    description: string;
}

interface AnalyticsReportoperator {
    operator_id: string;
    name: string;
    username: string;
    accuracy: number;
    total_executions: number;
    score: number;
    weekly_activity: {
        green: number;
        yellow: number;
        red: number;
        idle: number;
    };
}

interface AnalyticsReport {
    session_id: string;
    leaderboard_visible: boolean;
    total_operators: number;
    weekly_activity_total: number;
    top_10: AnalyticsReportoperator[];
}

const ACCESS_KEY_STORAGE = 'ZTCE_Commander_access_key_v1';
const ACCESS_UNLOCK_STORAGE = 'ZTCE_Commander_unlocked_v1';
const SHARE_DISMISSED_STORAGE = 'ZTCE_Commander_share_dismissed_v1';

export default function CommanderPage() {
    const [accessKeyInput, setAccessKeyInput] = useState('');
    const [isUnlocked, setIsUnlocked] = useState(false);
    const [accessMessage, setAccessMessage] = useState('');

    const [sessionId, setSessionId] = useState('');
    const [CommanderName, setCommanderName] = useState('');
    const [sessions, setSessions] = useState<Session[]>([]);
    const [operators, setoperators] = useState<operator[]>([]);
    const [loading, setLoading] = useState(false);
    const [copyMessage, setCopyMessage] = useState('');

    const [selectedoperatorId, setSelectedoperatorId] = useState('');
    const [operatorFiles, setoperatorFiles] = useState<operatorFile[]>([]);
    const [selectedFileId, setSelectedFileId] = useState('');
    const [editorContent, setEditorContent] = useState('');
    const [executionOutput, setExecutionOutput] = useState('Execution output will appear here');
    const [terminalCommand, setTerminalCommand] = useState('');
    const [aiPrompt, setAiPrompt] = useState('');
    const [aiModel, setAiModel] = useState('gemini-pro');
    const [aiSuggestion, setAiSuggestion] = useState('');
    const [isWsConnected, setIsWsConnected] = useState(false);
    const [tasks, setTasks] = useState<SessionTask[]>([]);
    const [taskTitle, setTaskTitle] = useState('');
    const [taskDescription, setTaskDescription] = useState('');
    const [taskPriority, setTaskPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
    const [taskAssignee, setTaskAssignee] = useState('');
    const [broadcastFiles, setBroadcastFiles] = useState<BroadcastFile[]>([]);
    const [broadcastUploadFile, setBroadcastUploadFile] = useState<File | null>(null);
    const [broadcastDescription, setBroadcastDescription] = useState('');
    const [maximizedPdf, setMaximizedPdf] = useState<{ url: string; title: string; fileId: string } | null>(null);
    const [uploadingBroadcast, setUploadingBroadcast] = useState(false);
    const [analyticsReport, setAnalyticsReport] = useState<AnalyticsReport | null>(null);
    const [showSharePopup, setShowSharePopup] = useState(false);
    const [shareLink, setShareLink] = useState('');
    const [showWhiteboard, setShowWhiteboard] = useState(false);
    const [whiteboardSceneData, setWhiteboardSceneData] = useState<{ elements: any; appState: any } | null>(null);
    const [pdfWhiteboardData, setPdfWhiteboardData] = useState<Record<string, Record<number, any>>>({});
    const [pdfCurrentPages, setPdfCurrentPages] = useState<Record<string, number>>({});
    const [sessionJoinLink, setSessionJoinLink] = useState('');
    const [backendUrlInput, setBackendUrlInput] = useState('');
    const [backendUrlStatus, setBackendUrlStatus] = useState('');

    const aiModelOptions = [
        { label: 'Gemini Pro (cloud)', value: 'gemini-pro' },
        { label: 'Gemma 4 E4B (local)', value: 'ollama:gemma4:e4b' },
        { label: 'Qwen 2.5 3B (local)', value: 'ollama:qwen2.5:3b' },
        { label: 'Qwen 3.5 Latest (local)', value: 'ollama:qwen3.5:latest' },
    ];

    const wsRef = useRef<WebSocket | null>(null);
    const sessionWsRef = useRef<WebSocket | null>(null);
    const broadcastTimerRef = useRef<NodeJS.Timeout | null>(null);
    const autosaveTimerRef = useRef<NodeJS.Timeout | null>(null);
    const wsReconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
    const wsManualCloseRef = useRef(false);
    const applyingRemoteRef = useRef(false);
    const sessionsLoadedRef = useRef(false);
    const selectedFileRef = useRef<operatorFile | null>(null);
    const editorContentRef = useRef('');
    const lastLocalEditAtRef = useRef(0);
    const lastSessionSyncAtRef = useRef(0);
    const clientIdRef = useRef(`Commander-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);

    const storageGet = useCallback((key: string) => {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }, []);

    const storageSet = useCallback((key: string, value: string) => {
        try {
            localStorage.setItem(key, value);
            return true;
        } catch {
            return false;
        }
    }, []);

    const storageRemove = useCallback((key: string) => {
        try {
            localStorage.removeItem(key);
            return true;
        } catch {
            return false;
        }
    }, []);

    const [apiBase, setApiBase] = useState(() => resolveApiBase(process.env.NEXT_PUBLIC_API_BASE));
    const backendBase = useMemo(() => apiBase.replace(/\/api\/?$/, ''), [apiBase]);
    const wsBase = useMemo(() => backendBase.replace(/^http/, 'ws'), [backendBase]);
    const pdfWhiteboardStorageKey = useMemo(
        () => (sessionId ? `ZTCE:Commander-pdf-whiteboard:${sessionId}` : ''),
        [sessionId]
    );
    const whiteboardStorageKey = useMemo(
        () => (sessionId ? `ZTCE:Commander-whiteboard:${sessionId}` : ''),
        [sessionId]
    );

    useEffect(() => {
        const resolved = getStoredApiBase() || resolveApiBase(process.env.NEXT_PUBLIC_API_BASE);
        setBackendUrlInput(resolved);
        setApiBase(resolved);
    }, []);

    const selectedFile = useMemo(
        () => operatorFiles.find((file) => file.id === selectedFileId) || null,
        [operatorFiles, selectedFileId]
    );

    useEffect(() => {
        selectedFileRef.current = selectedFile;
    }, [selectedFile]);

    useEffect(() => {
        editorContentRef.current = editorContent;
    }, [editorContent]);

    const parseJsonResponse = useCallback(async (res: Response) => {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`Expected JSON but got: ${text.slice(0, 120)}`);
        }
        return res.json();
    }, []);

    useEffect(() => {
        const unlocked = storageGet(ACCESS_UNLOCK_STORAGE) === 'true';
        setIsUnlocked(unlocked);
    }, [storageGet]);

    useEffect(() => {
        if (!isUnlocked) {
            setShowSharePopup(false);
            setShareLink('');
            return;
        }

        const dismissed = storageGet(SHARE_DISMISSED_STORAGE) === 'true';
        setShowSharePopup(!dismissed);
    }, [isUnlocked, storageGet]);

    const isLoopbackUrl = useCallback((rawUrl: string) => {
        try {
            const parsed = new URL(rawUrl);
            return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
        } catch {
            return false;
        }
    }, []);

    const resolveShareBase = useCallback((payload?: { frontend_url?: string; lan_ip?: string }) => {
        const protocol = typeof window !== 'undefined' ? window.location.protocol : 'http:';
        const browserBase = typeof window !== 'undefined' ? `${protocol}//${window.location.hostname}:3000` : '';

        if (payload?.frontend_url && !isLoopbackUrl(payload.frontend_url)) {
            return payload.frontend_url;
        }

        if (payload?.lan_ip && payload.lan_ip !== '127.0.0.1') {
            return `${protocol}//${payload.lan_ip}:3000`;
        }

        if (browserBase && !isLoopbackUrl(browserBase)) {
            return browserBase;
        }

        return '';
    }, [isLoopbackUrl]);

    useEffect(() => {
        if (!showSharePopup) {
            return;
        }

        let cancelled = false;

        const loadShareLink = async () => {
            try {
                const res = await fetch(`${apiBase}/network-info/`);
                const data = await parseJsonResponse(res);
                if (!cancelled) {
                    setShareLink(resolveShareBase(data));
                }
            } catch (error) {
                if (!cancelled) {
                    setShareLink(resolveShareBase());
                }
            }
        };

        loadShareLink();

        return () => {
            cancelled = true;
        };
    }, [apiBase, parseJsonResponse, resolveShareBase, showSharePopup]);

    const buildJoinLink = useCallback(async (sid: string) => {
        try {
            const res = await fetch(`${apiBase}/network-info/`);
            const data = await parseJsonResponse(res);
            const baseUrl = resolveShareBase(data);

            if (!baseUrl || isLoopbackUrl(baseUrl)) {
                return '';
            }

            return `${baseUrl}/?sessionId=${sid}`;
        } catch {
            const fallbackBase = resolveShareBase();
            if (!fallbackBase || isLoopbackUrl(fallbackBase)) {
                return '';
            }
            return `${fallbackBase}/?sessionId=${sid}`;
        }
    }, [apiBase, isLoopbackUrl, parseJsonResponse, resolveShareBase]);

    useEffect(() => {
        if (!sessionId) {
            setSessionJoinLink('');
            return;
        }

        let cancelled = false;

        const loadJoinLink = async () => {
            const joinLink = await buildJoinLink(sessionId);
            if (!cancelled) {
                setSessionJoinLink(joinLink);
            }
        };

        loadJoinLink();

        return () => {
            cancelled = true;
        };
    }, [buildJoinLink, sessionId]);

    const loadSessions = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/sessions/`);
            const data = await parseJsonResponse(res);
            setSessions(data.results || []);
        } catch (err) {
            setSessions([]);
        }
    }, [apiBase, parseJsonResponse]);

    const loadSessionDetails = useCallback(async (sid: string) => {
        try {
            const res = await fetch(`${apiBase}/sessions/${sid}/`);
            const data = await parseJsonResponse(res);
            setoperators((prev) => {
                const nextoperators = data.operators || [];
                return JSON.stringify(prev) === JSON.stringify(nextoperators) ? prev : nextoperators;
            });
        } catch (err) {
            setoperators([]);
        }
    }, [apiBase, parseJsonResponse]);

    const loadTasks = useCallback(async (sid: string) => {
        try {
            const res = await fetch(`${apiBase}/tasks/by_session/?session_id=${sid}`);
            const data = await parseJsonResponse(res);
            setTasks(data || []);
        } catch (err) {
            setTasks([]);
        }
    }, [apiBase]);

    const selectedSession = useMemo(
        () => sessions.find((s) => s.id === sessionId),
        [sessions, sessionId]
    );

    const authHeaders = useMemo(() => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const token = selectedSession?.session_token;
        if (token) {
            headers['X-Session-Token'] = token;
        }
        return headers;
    }, [selectedSession]);

    const loadBroadcastFiles = useCallback(async (sid: string) => {
        try {
            const res = await fetch(`${apiBase}/broadcasts/get_session_files/?session_id=${sid}`);
            const data = await parseJsonResponse(res);
            setBroadcastFiles(data || []);
        } catch {
            setBroadcastFiles([]);
        }
    }, [apiBase, parseJsonResponse]);

    const loadAnalyticsReport = useCallback(async (sid: string) => {
        try {
            const res = await fetch(`${apiBase}/sessions/${sid}/analytics_report/`, {
                headers: authHeaders,
            });
            const data = await parseJsonResponse(res);
            setAnalyticsReport(data);
        } catch {
            setAnalyticsReport(null);
        }
    }, [apiBase, authHeaders, parseJsonResponse]);

    useEffect(() => {
        if (!isUnlocked) {
            sessionsLoadedRef.current = false;
            return;
        }

        if (!sessionsLoadedRef.current) {
            sessionsLoadedRef.current = true;
            loadSessions();
        }
    }, [isUnlocked, loadSessions]);

    useEffect(() => {
        if (!sessionId || !isUnlocked) {
            return;
        }
        loadSessionDetails(sessionId);
        loadTasks(sessionId);
        loadBroadcastFiles(sessionId);
        loadAnalyticsReport(sessionId);
        const interval = setInterval(() => {
            if (Date.now() - lastSessionSyncAtRef.current < 2000) {
                return;
            }
            lastSessionSyncAtRef.current = Date.now();
            loadSessionDetails(sessionId);
            loadAnalyticsReport(sessionId);
        }, 5000);
        return () => clearInterval(interval);
    }, [isUnlocked, sessionId, loadAnalyticsReport, loadBroadcastFiles, loadSessionDetails, loadTasks]);

    useEffect(() => {
        if (!sessionId) {
            if (sessionWsRef.current) {
                sessionWsRef.current.close();
                sessionWsRef.current = null;
            }
            return;
        }

        if (sessionWsRef.current) {
            sessionWsRef.current.close();
        }

        const socket = new WebSocket(`${wsBase}/ws/session/${sessionId}/`);
        sessionWsRef.current = socket;

        socket.onmessage = (event) => {
            try {
                const payload = JSON.parse(event.data);
                if (payload.type === 'task_updated') {
                    loadTasks(sessionId);
                }
                if (payload.type === 'operator_added' || payload.type === 'activity_update') {
                    loadSessionDetails(sessionId);
                }
                if (payload.type === 'file_broadcast') {
                    loadBroadcastFiles(sessionId);
                }
            } catch (err) {
                console.error('Session WS parse failed', err);
            }
        };

        return () => {
            if (sessionWsRef.current) {
                sessionWsRef.current.close();
            }
        };
    }, [sessionId, wsBase, loadTasks, loadSessionDetails, loadBroadcastFiles]);

    const sendWhiteboardUpdate = useCallback((elements: any, appState: any) => {
        const normalizedAppState = appState
            ? {
                ...appState,
                collaborators: {},
            }
            : undefined;

        if (sessionWsRef.current && sessionWsRef.current.readyState === WebSocket.OPEN) {
            sessionWsRef.current.send(JSON.stringify({
                type: 'whiteboard_update',
                elements,
                appState: normalizedAppState
            }));
        }
        setWhiteboardSceneData({ elements, appState: normalizedAppState });
    }, []);

    const sendPdfWhiteboardUpdate = useCallback((fileId: string, page: number, elements: any, appState: any) => {
        const normalizedAppState = appState
            ? {
                ...appState,
                // Maps are not JSON-serializable. Keep a plain object placeholder.
                collaborators: {},
            }
            : undefined;

        if (sessionWsRef.current && sessionWsRef.current.readyState === WebSocket.OPEN) {
            sessionWsRef.current.send(JSON.stringify({
                type: 'pdf_whiteboard_update',
                file_id: fileId,
                page,
                elements,
                appState: normalizedAppState
            }));
        }
        setPdfWhiteboardData(prev => ({
            ...prev,
            [fileId]: {
                ...(prev[fileId] || {}),
                [page]: { elements, appState: normalizedAppState }
            }
        }));
    }, []);

    const sendPdfPageChange = useCallback((fileId: string, page: number) => {
        if (sessionWsRef.current && sessionWsRef.current.readyState === WebSocket.OPEN) {
            sessionWsRef.current.send(JSON.stringify({
                type: 'pdf_page_change',
                file_id: fileId,
                page
            }));
        }
        setPdfCurrentPages(prev => ({ ...prev, [fileId]: page }));
    }, []);

    useEffect(() => {
        if (!pdfWhiteboardStorageKey) {
            setPdfWhiteboardData({});
            setPdfCurrentPages({});
            return;
        }

        const raw = storageGet(pdfWhiteboardStorageKey);
        if (!raw) {
            setPdfWhiteboardData({});
            setPdfCurrentPages({});
            return;
        }

        try {
            const parsed = JSON.parse(raw);
            setPdfWhiteboardData(parsed?.whiteboardData || {});
            setPdfCurrentPages(parsed?.currentPages || {});
        } catch {
            setPdfWhiteboardData({});
            setPdfCurrentPages({});
        }
    }, [pdfWhiteboardStorageKey, storageGet]);

    useEffect(() => {
        if (!pdfWhiteboardStorageKey) {
            return;
        }

        storageSet(
            pdfWhiteboardStorageKey,
            JSON.stringify({
                whiteboardData: pdfWhiteboardData,
                currentPages: pdfCurrentPages,
                updatedAt: new Date().toISOString(),
            })
        );
    }, [pdfCurrentPages, pdfWhiteboardData, pdfWhiteboardStorageKey, storageSet]);

    useEffect(() => {
        if (!whiteboardStorageKey) {
            setWhiteboardSceneData(null);
            return;
        }

        const raw = storageGet(whiteboardStorageKey);
        if (!raw) {
            setWhiteboardSceneData(null);
            return;
        }

        try {
            const parsed = JSON.parse(raw);
            if (parsed?.elements) {
                setWhiteboardSceneData({
                    elements: parsed.elements,
                    appState: parsed.appState,
                });
            } else {
                setWhiteboardSceneData(null);
            }
        } catch {
            setWhiteboardSceneData(null);
        }
    }, [storageGet, whiteboardStorageKey]);

    useEffect(() => {
        if (!whiteboardStorageKey) {
            return;
        }

        if (!whiteboardSceneData) {
            storageRemove(whiteboardStorageKey);
            return;
        }

        storageSet(
            whiteboardStorageKey,
            JSON.stringify({
                elements: whiteboardSceneData.elements,
                appState: whiteboardSceneData.appState,
                updatedAt: new Date().toISOString(),
            })
        );
    }, [storageRemove, storageSet, whiteboardSceneData, whiteboardStorageKey]);

    useEffect(() => {
        if (!sessionId) {
            return;
        }

        const interval = setInterval(() => {
            if (!sessionWsRef.current || sessionWsRef.current.readyState !== WebSocket.OPEN) {
                return;
            }

            const activePdfFiles = broadcastFiles.filter((file) => file.is_active && file.file_type === 'pdf');
            for (const file of activePdfFiles) {
                const currentPage = pdfCurrentPages[file.id] || 1;
                sessionWsRef.current.send(JSON.stringify({
                    type: 'pdf_page_change',
                    file_id: file.id,
                    page: currentPage,
                }));

                const pageData = pdfWhiteboardData[file.id]?.[currentPage];
                if (pageData?.elements) {
                    sessionWsRef.current.send(JSON.stringify({
                        type: 'pdf_whiteboard_update',
                        file_id: file.id,
                        page: currentPage,
                        elements: pageData.elements,
                        appState: pageData.appState,
                    }));
                }
            }
        }, 2500);

        return () => clearInterval(interval);
    }, [broadcastFiles, pdfCurrentPages, pdfWhiteboardData, sessionId]);

    const loadoperatorFiles = useCallback(async (operatorId: string) => {
        try {
            const res = await fetch(`${apiBase}/operators/${operatorId}/get_files/`);
            const data = await parseJsonResponse(res);
            const files: operatorFile[] = data.results || data || [];
            setoperatorFiles(files);

            if (files.length > 0) {
                const first = files[0];
                setSelectedFileId(first.id);
                applyingRemoteRef.current = true;
                setEditorContent(first.content || '');
                setTimeout(() => {
                    applyingRemoteRef.current = false;
                }, 0);
            } else {
                setSelectedFileId('');
                setEditorContent('');
            }
        } catch (err) {
            alert('Failed to load operator files: ' + (err as Error).message);
        }
    }, [apiBase, parseJsonResponse]);

    useEffect(() => {
        if (!selectedoperatorId || !selectedFileId || isWsConnected) {
            return;
        }

        const pollSelectedoperatorFile = async () => {
            try {
                // Do not overwrite while Commander is actively typing.
                if (Date.now() - lastLocalEditAtRef.current < 180) {
                    return;
                }

                const res = await fetch(`${apiBase}/operators/${selectedoperatorId}/get_files/`);
                const data = await parseJsonResponse(res);
                const files: operatorFile[] = data.results || data || [];

                setoperatorFiles(files);

                const updatedSelected = files.find((f) => f.id === selectedFileId);
                if (!updatedSelected) {
                    return;
                }

                const currentContent = editorContentRef.current;
                if (updatedSelected.content !== currentContent) {
                    applyingRemoteRef.current = true;
                    setEditorContent(updatedSelected.content || '');
                    setTimeout(() => {
                        applyingRemoteRef.current = false;
                    }, 0);
                }
            } catch (err) {
                console.error('Fallback file sync failed:', err);
            }
        };

        const interval = setInterval(pollSelectedoperatorFile, 250);
        return () => clearInterval(interval);
    }, [apiBase, isWsConnected, parseJsonResponse, selectedFileId, selectedoperatorId]);

    useEffect(() => {
        if (!selectedoperatorId || !selectedFileId) {
            return;
        }
        const target = operatorFiles.find((f) => f.id === selectedFileId);
        if (!target) {
            return;
        }
        if ((target.content || '') === editorContentRef.current) {
            return;
        }
        applyingRemoteRef.current = true;
        setEditorContent(target.content || '');
        setTimeout(() => {
            applyingRemoteRef.current = false;
        }, 0);
    }, [selectedFileId, selectedoperatorId, operatorFiles]);

    useEffect(() => {
        if (!selectedoperatorId) {
            setIsWsConnected(false);
            wsManualCloseRef.current = true;
            if (wsReconnectTimerRef.current) {
                clearTimeout(wsReconnectTimerRef.current);
                wsReconnectTimerRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            return;
        }

        // Close existing connection before creating new one
        wsManualCloseRef.current = true;
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        if (wsReconnectTimerRef.current) {
            clearTimeout(wsReconnectTimerRef.current);
            wsReconnectTimerRef.current = null;
        }

        const connectSocket = () => {
            wsManualCloseRef.current = false;
            const socket = new WebSocket(`${wsBase}/ws/operator/${selectedoperatorId}/`);
            wsRef.current = socket;

            socket.onopen = () => {
                console.log(`âœ“ Commander connected to operator ${selectedoperatorId}`);
                setIsWsConnected(true);
            };

            socket.onclose = () => {
                console.log(`âœ— Commander disconnected from operator ${selectedoperatorId}`);
                setIsWsConnected(false);

                if (!wsManualCloseRef.current) {
                    wsReconnectTimerRef.current = setTimeout(() => {
                        connectSocket();
                    }, 700);
                }
            };

            socket.onerror = (error) => {
                console.error('operator WS error:', error);
                setIsWsConnected(false);
            };

            socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload.type === 'code_update' && payload.filename) {
                        if (payload.source_client_id && payload.source_client_id === clientIdRef.current) {
                            return;
                        }

                        // Prefer local typing smoothness over immediate remote apply.
                        if (Date.now() - lastLocalEditAtRef.current < 140) {
                            return;
                        }

                        setoperatorFiles((prev) => prev.map((file) => {
                            if (file.filename === payload.filename) {
                                return { ...file, content: payload.content ?? '' };
                            }
                            return file;
                        }));

                        const currentFile = selectedFileRef.current;
                        const currentContent = editorContentRef.current;
                        if (currentFile && currentFile.filename === payload.filename && payload.content !== currentContent) {
                            applyingRemoteRef.current = true;
                            setEditorContent(payload.content ?? '');
                            setTimeout(() => {
                                applyingRemoteRef.current = false;
                            }, 0);
                        }
                    }
                } catch (err) {
                    console.error('WS parse failed', err);
                }
            };
        };

        // Small delay to ensure previous connection fully closes
        const connectTimer = setTimeout(connectSocket, 50);

        return () => {
            clearTimeout(connectTimer);
            wsManualCloseRef.current = true;
            if (broadcastTimerRef.current) {
                clearTimeout(broadcastTimerRef.current);
                broadcastTimerRef.current = null;
            }
            if (wsReconnectTimerRef.current) {
                clearTimeout(wsReconnectTimerRef.current);
                wsReconnectTimerRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
                wsRef.current = null;
            }
            setIsWsConnected(false);
        };
    }, [selectedoperatorId, wsBase]);

    const handleUnlock = () => {
        const trimmed = accessKeyInput.trim();
        if (!trimmed) {
            setAccessMessage('Enter your Commander access key.');
            return;
        }

        const stored = storageGet(ACCESS_KEY_STORAGE);
        if (!stored) {
            const keySaved = storageSet(ACCESS_KEY_STORAGE, trimmed);
            const unlockSaved = storageSet(ACCESS_UNLOCK_STORAGE, 'true');
            setIsUnlocked(true);
            setAccessMessage(keySaved && unlockSaved
                ? 'Commander access key set for this device.'
                : 'Access granted for this tab (storage unavailable).');
            return;
        }

        if (stored !== trimmed) {
            setAccessMessage('Incorrect Commander access key for this device.');
            return;
        }

        storageSet(ACCESS_UNLOCK_STORAGE, 'true');
        setIsUnlocked(true);
        storageRemove(SHARE_DISMISSED_STORAGE);
        setShowSharePopup(true);
        setAccessMessage('Access granted.');
    };

    const handleResetDeviceAccess = () => {
        storageRemove(ACCESS_KEY_STORAGE);
        storageRemove(ACCESS_UNLOCK_STORAGE);
        storageRemove(SHARE_DISMISSED_STORAGE);
        setAccessKeyInput('');
        setIsUnlocked(false);
        setShowSharePopup(false);
        setAccessMessage('Device access reset. Enter a key to continue.');
    };

    const handleLock = () => {
        storageRemove(ACCESS_UNLOCK_STORAGE);
        storageRemove(SHARE_DISMISSED_STORAGE);
        setIsUnlocked(false);
        setShowSharePopup(false);
        sessionsLoadedRef.current = false;
        setSessionId('');
        setoperators([]);
        setSelectedoperatorId('');
        setoperatorFiles([]);
        setSelectedFileId('');
        setEditorContent('');
    };

    const handleSaveBackendUrl = () => {
        const trimmed = backendUrlInput.trim();
        if (!trimmed) {
            setBackendUrlStatus('Enter a backend URL first.');
            setTimeout(() => setBackendUrlStatus(''), 1800);
            return;
        }

        const resolved = resolveApiBase(trimmed);
        setStoredApiBase(trimmed);
        setBackendUrlInput(resolved);
        setApiBase(resolved);
        setBackendUrlStatus('Backend URL saved.');
        setTimeout(() => setBackendUrlStatus(''), 1800);
    };

    const handleResetBackendUrl = () => {
        const defaultBase = resolveApiBase(process.env.NEXT_PUBLIC_API_BASE);
        setStoredApiBase('');
        setBackendUrlInput(defaultBase);
        setApiBase(defaultBase);
        setBackendUrlStatus('Backend URL reset.');
        setTimeout(() => setBackendUrlStatus(''), 1800);
    };

    const handleCreateSession = async () => {
        if (!CommanderName.trim()) {
            alert('Enter Commander name');
            return;
        }

        setLoading(true);
        try {
            const res = await fetch(`${apiBase}/sessions/create_session/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ creator_name: CommanderName.trim() }),
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data?.detail || data?.error || 'Failed to create session');
                return;
            }

            setSessionId(data.id);
            await loadSessions();
            await loadSessionDetails(data.id);
        } catch (err) {
            alert(`Failed to create session: ${(err as Error).message}\nBackend URL: ${apiBase}`);
        } finally {
            setLoading(false);
        }
    };

    const handleEndSession = async () => {
        if (!sessionId) {
            return;
        }

        if (!window.confirm('End this session for all operators?')) {
            return;
        }

        try {
            const res = await fetch(`${apiBase}/sessions/${sessionId}/end_session/`, {
                method: 'POST',
                headers: authHeaders,
            });

            const data = await parseJsonResponse(res);
            if (!res.ok) {
                throw new Error(data?.detail || data?.error || 'Failed to end session');
            }

            setCopyMessage('Session ended');
            setTimeout(() => setCopyMessage(''), 1400);
            setSessionId('');
            setSelectedoperatorId('');
            setoperatorFiles([]);
            setSelectedFileId('');
            setEditorContent('');
            setoperators([]);
            await loadSessions();
        } catch (err) {
            alert('Failed to end session: ' + (err as Error).message);
        }
    };

    const handleSelectoperator = async (operator: operator) => {
        setSelectedoperatorId(operator.id);
        // Reset file state when switching operators
        setSelectedFileId('');
        setEditorContent('');
        selectedFileRef.current = null;
        editorContentRef.current = '';
        // Clear any pending broadcast timers
        if (broadcastTimerRef.current) {
            clearTimeout(broadcastTimerRef.current);
            broadcastTimerRef.current = null;
        }
        if (autosaveTimerRef.current) {
            clearTimeout(autosaveTimerRef.current);
            autosaveTimerRef.current = null;
        }
        await loadoperatorFiles(operator.id);
    };

    const persistCurrentFile = useCallback(async (content: string) => {
        if (!selectedFileId) {
            return;
        }
        try {
            await fetch(`${apiBase}/files/${selectedFileId}/update_content/`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    language: 'python',
                    client_id: clientIdRef.current,
                }),
            });
        } catch (err) {
            console.error('Persist failed:', err);
        }
    }, [apiBase, selectedFileId]);

    const publishRealtimeUpdate = useCallback((content: string) => {
        if (!selectedFile || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            console.warn('Cannot publish: WebSocket not ready or no selected file', {
                hasFile: !!selectedFile,
                wsState: wsRef.current?.readyState,
                wsOpen: WebSocket.OPEN
            });
            return;
        }
        try {
            wsRef.current.send(JSON.stringify({
                type: 'code_update',
                filename: selectedFile.filename,
                content,
                client_id: clientIdRef.current,
            }));
        } catch (error) {
            console.error('Failed to send code update:', error);
        }
    }, [selectedFile]);

    const handleCommanderCodeChange = (value: string | undefined) => {
        if (!selectedFileId || value === undefined) {
            return;
        }

        lastLocalEditAtRef.current = Date.now();
        setEditorContent(value);

        if (applyingRemoteRef.current) {
            return;
        }

        // Word-wise realtime sync: immediate on whitespace/newline, short debounce otherwise.
        if (broadcastTimerRef.current) {
            clearTimeout(broadcastTimerRef.current);
        }
        if (/\s$/.test(value)) {
            publishRealtimeUpdate(value);
        } else {
            broadcastTimerRef.current = setTimeout(() => publishRealtimeUpdate(value), 60);
        }

        if (autosaveTimerRef.current) {
            clearTimeout(autosaveTimerRef.current);
        }
        const persistDelay = isWsConnected ? 220 : 180;
        autosaveTimerRef.current = setTimeout(() => persistCurrentFile(value), persistDelay);
    };

    const broadcastCommanderCode = async () => {
        if (!sessionId) {
            return;
        }

        try {
            const res = await fetch(`${apiBase}/sessions/${sessionId}/update_Commander_code/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ code: editorContent }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                throw new Error(data?.error || data?.detail || 'Broadcast failed');
            }
            setCopyMessage('Commander code broadcasted');
            setTimeout(() => setCopyMessage(''), 1400);
        } catch (err) {
            setCopyMessage('Broadcast failed: ' + (err as Error).message);
            setTimeout(() => setCopyMessage(''), 2000);
        }
    };

    const uploadBroadcastFile = async () => {
        if (!sessionId || !selectedSession?.session_token || !broadcastUploadFile) {
            return;
        }

        setUploadingBroadcast(true);
        try {
            const formData = new FormData();
            formData.append('session_id', sessionId);
            formData.append('description', broadcastDescription);
            formData.append('file', broadcastUploadFile);

            const res = await fetch(`${apiBase}/broadcasts/upload_file/`, {
                method: 'POST',
                headers: {
                    'X-Session-Token': selectedSession.session_token,
                },
                body: formData,
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                throw new Error(data?.error || data?.detail || 'Upload failed');
            }

            setBroadcastUploadFile(null);
            setBroadcastDescription('');
            loadBroadcastFiles(sessionId);
        } catch (err) {
            alert('Broadcast upload failed: ' + (err as Error).message);
        } finally {
            setUploadingBroadcast(false);
        }
    };
    const resolveBroadcastUrl = (url: string | null) => {
        if (!url) return null;
        if (url.startsWith('http')) return url;
        return `${apiBase.replace(/\/api\/?$/, '')}${url}`;
    };

    const renderBroadcastPreview = (file: BroadcastFile) => {
        if (!file.is_active) return null;
        const normalizedUrl = resolveBroadcastUrl(file.file_url);
        if (!normalizedUrl) {
            return null;
        }

        if (file.file_type === 'image') {
            return <img className={styles.broadcastPreview} src={normalizedUrl} alt={file.filename} style={{ maxWidth: '100%', borderRadius: '4px', marginTop: '8px' }} />;
        }

        if (file.file_type === 'pdf') {
            return (
                <div style={{ marginTop: '8px' }}>
                    <div style={{ padding: '8px', background: '#1c2b36', display: 'flex', gap: '8px', borderRadius: '4px' }}>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => setMaximizedPdf({ url: normalizedUrl, title: file.filename, fileId: file.id })}
                        >
                            Open PDF (Maximize)
                        </button>
                        <a className={styles.secondaryBtn} href={normalizedUrl} target="_blank" rel="noreferrer" download>
                            Download PDF
                        </a>
                    </div>
                </div>
            );
        }

        return (
            <a className={styles.secondaryBtn} style={{ marginTop: '8px', display: 'inline-block' }} href={normalizedUrl} target="_blank" rel="noreferrer">
                Download file
            </a>
        );
    };

    const setBroadcastFileActiveState = async (fileId: string, enabled: boolean) => {
        try {
            const res = await fetch(`${apiBase}/broadcasts/${fileId}/toggle_active/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ enabled }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                throw new Error(data?.error || data?.detail || 'Broadcast update failed');
            }
            if (sessionId) {
                loadBroadcastFiles(sessionId);
            }
        } catch (err) {
            alert('Failed to update broadcast file: ' + (err as Error).message);
        }
    };

    const executeCommanderCode = async () => {
        if (!selectedoperatorId || !selectedFileId) {
            return;
        }
        try {
            const res = await fetch(`${apiBase}/executions/execute/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    operator_id: selectedoperatorId,
                    file_id: selectedFileId,
                    code: editorContent,
                }),
            });
            const data: ExecutionResult = await parseJsonResponse(res);
            setExecutionOutput(
                `${data.stdout || ''}${data.stderr ? `\nERROR:\n${data.stderr}` : ''}\n\nReturn: ${data.return_code} (${data.execution_time}s)`
            );
        } catch (err) {
            setExecutionOutput('Execution failed: ' + (err as Error).message);
        }
    };

    const runCommanderTerminalCommand = async () => {
        if (!selectedoperatorId || !terminalCommand.trim()) {
            return;
        }

        const command = terminalCommand.trim();
        setExecutionOutput((prev) => `${prev}\n\n$ ${command}\nRunning...`);

        try {
            const res = await fetch(`${apiBase}/executions/run_terminal/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    operator_id: selectedoperatorId,
                    command,
                }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                setExecutionOutput((prev) => `${prev}\nERROR: ${data?.error || 'Terminal command failed'}`);
                return;
            }

            const output = `${data.stdout || ''}${data.stderr ? `\nERROR:\n${data.stderr}` : ''}`;
            setExecutionOutput((prev) => `${prev}\n${output}\n\nReturn: ${data.return_code} (${data.execution_time}s)`);
            setTerminalCommand('');
        } catch (err) {
            setExecutionOutput((prev) => `${prev}\nExecution failed: ${(err as Error).message}`);
        }
    };

    const saveSnapshot = async () => {
        if (!selectedoperatorId || !selectedFile) {
            return;
        }
        try {
            await fetch(`${apiBase}/snapshots/create_snapshot/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    operator_id: selectedoperatorId,
                    filename: selectedFile.filename,
                    content: editorContent,
                    language: 'python',
                    message: 'Commander live snapshot',
                }),
            });
            alert('Snapshot saved');
        } catch (err) {
            alert('Snapshot failed: ' + (err as Error).message);
        }
    };

    const requestAiSuggestion = async () => {
        if (!selectedoperatorId) {
            return;
        }
        try {
            const res = await fetch(`${apiBase}/suggestions/get_suggestion/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    operator_id: selectedoperatorId,
                    code: editorContent,
                    prompt: aiPrompt,
                    model: aiModel,
                }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                setAiSuggestion(data?.error || 'Suggestion failed');
                return;
            }
            setAiSuggestion(data?.suggestion || 'No suggestion returned');
        } catch (err) {
            setAiSuggestion('Suggestion failed: ' + (err as Error).message);
        }
    };

    const createTask = async () => {
        if (!sessionId || !taskTitle.trim()) {
            return;
        }
        try {
            const res = await fetch(`${apiBase}/tasks/create_task/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({
                    session_id: sessionId,
                    title: taskTitle.trim(),
                    description: taskDescription,
                    priority: taskPriority,
                    assigned_operator_id: taskAssignee || null,
                    created_by: CommanderName || 'admin',
                }),
            });
            await parseJsonResponse(res);
            setTaskTitle('');
            setTaskDescription('');
            setTaskPriority('medium');
            setTaskAssignee('');
            loadTasks(sessionId);
        } catch (err) {
            alert('Task creation failed: ' + (err as Error).message);
        }
    };

    const updateTaskStatus = async (task: SessionTask, nextStatus: SessionTask['status']) => {
        try {
            const res = await fetch(`${apiBase}/tasks/${task.id}/update_task/`, {
                method: 'PATCH',
                headers: authHeaders,
                body: JSON.stringify({ status: nextStatus }),
            });
            await parseJsonResponse(res);
            if (sessionId) {
                loadTasks(sessionId);
            }
        } catch (err) {
            alert('Task update failed: ' + (err as Error).message);
        }
    };

    const toggleSessionFeature = async (feature: 'toggle_ai' | 'toggle_autocomplete' | 'toggle_leaderboard_visibility' | 'toggle_download', enabled: boolean) => {
        if (!sessionId) {
            return;
        }
        try {
            await fetch(`${apiBase}/sessions/${sessionId}/${feature}/`, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ enabled }),
            });
            await loadSessions();
            await loadSessionDetails(sessionId);
            loadAnalyticsReport(sessionId);
        } catch (err) {
            alert('Failed to update feature: ' + (err as Error).message);
        }
    };

    const copyToClipboard = async (value: string, label: string, closeAfterCopy = false) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopyMessage(`${label} copied`);
            setTimeout(() => setCopyMessage(''), 1400);
            if (closeAfterCopy) {
                dismissSharePopup();
            }
        } catch {
            setCopyMessage('Copy failed');
            setTimeout(() => setCopyMessage(''), 1400);
        }
    };

    const dismissSharePopup = () => {
        storageSet(SHARE_DISMISSED_STORAGE, 'true');
        setShowSharePopup(false);
    };

    if (!isUnlocked) {
        return (
            <div className={styles.container}>
                <div className={styles.card}>
                    <h1>Commander Portal Login</h1>
                    <p>This page is locked for Commanders on this device. operators should use Home page only.</p>
                    <input
                        className={styles.input}
                        type="password"
                        placeholder="Commander access key"
                        value={accessKeyInput}
                        onChange={(e) => setAccessKeyInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                handleUnlock();
                            }
                        }}
                    />
                    {accessMessage && <p className={styles.message}>{accessMessage}</p>}
                    <button className={styles.primaryBtn} onClick={handleUnlock}>Unlock Commander Portal</button>
                    <button className={styles.secondaryBtn} onClick={handleResetDeviceAccess}>Reset Device Access</button>
                    <Link href="/" className={styles.secondaryBtn}>Go to operator Page</Link>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>

            {showSharePopup && (
                <div className={styles.shareOverlay} role="dialog" aria-modal="true" aria-label="Share Commander link">
                    <div className={styles.shareModal}>
                        <div className={styles.shareModalHeader}>
                            <h3>Share Commander Link</h3>
                            <button className={styles.shareCloseBtn} onClick={dismissSharePopup}>âœ•</button>
                        </div>
                        <p>Copy this link and open it on the other device connected to the same hotspot or Wi-Fi.</p>
                        <div className={styles.shareLinkBox}>{shareLink || 'Loading direct IP link...'}</div>
                        <div className={styles.shareActions}>
                            <button
                                className={styles.primaryBtn}
                                onClick={() => copyToClipboard(shareLink, 'Commander link', true)}
                                disabled={!shareLink}
                            >
                                Copy Link
                            </button>
                            <button className={styles.secondaryBtn} onClick={dismissSharePopup}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            <div className={styles.headerBar}>
                <h1>Commander Dashboard</h1>
                <div className={styles.headerActions}>
                    <Link href="/" className={styles.secondaryBtn}>operator Page</Link>
                    <button className={styles.secondaryBtn} onClick={handleLock}>Lock Portal</button>
                </div>
            </div>

            {!sessionId ? (
                <div className={styles.card}>
                    <h2>Create Session</h2>
                    <input
                        className={styles.input}
                        type="text"
                        placeholder="Commander name"
                        value={CommanderName}
                        onChange={(e) => setCommanderName(e.target.value)}
                    />
                    <input
                        className={styles.input}
                        type="url"
                        placeholder="Backend URL, e.g. http://192.168.1.101:8000/api"
                        value={backendUrlInput}
                        onChange={(e) => setBackendUrlInput(e.target.value)}
                    />
                    <div className={styles.rowBtns}>
                        <button className={styles.secondaryBtn} onClick={handleSaveBackendUrl} type="button">
                            Save Backend URL
                        </button>
                        <button className={styles.secondaryBtn} onClick={handleResetBackendUrl} type="button">
                            Reset
                        </button>
                    </div>
                    {backendUrlStatus && <p className={styles.message}>{backendUrlStatus}</p>}
                    <button className={styles.primaryBtn} onClick={handleCreateSession} disabled={loading}>
                        {loading ? 'Creating...' : 'Create Session'}
                    </button>

                    <h3>Recent Sessions</h3>
                    <div className={styles.sessionsList}>
                        {sessions.map((s) => (
                            <div key={s.id} className={styles.sessionCard}>
                                <div>
                                    <h4>{s.creator_name}</h4>
                                    <p>ID: {s.id}</p>
                                    <p>operators: {s.operator_count} (active: {s.active_operators})</p>
                                </div>
                                <div className={styles.rowBtns}>
                                    <button className={styles.secondaryBtn} onClick={() => setSessionId(s.id)}>Open</button>
                                    <button
                                        className={styles.secondaryBtn}
                                        onClick={async () => {
                                            const link = await buildJoinLink(s.id);
                                            if (!link) {
                                                setCopyMessage('IP link unavailable. Open Commander using host IP URL.');
                                                setTimeout(() => setCopyMessage(''), 2000);
                                                return;
                                            }
                                            copyToClipboard(link, 'Join link');
                                        }}
                                    >
                                        Copy Join Link
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : (
                <div className={styles.dashboardPanel}>
                    <div className={styles.sessionMeta}>
                        <h2>Live Session</h2>
                        <p>Session ID: {sessionId}</p>
                        <p>Session Token: {selectedSession?.session_token || 'loading...'}</p>
                        <div className={styles.rowBtns}>
                            <button className={styles.secondaryBtn} onClick={() => copyToClipboard(sessionId, 'Session ID')}>Copy Session ID</button>
                            <button
                                className={styles.secondaryBtn}
                                onClick={() => copyToClipboard(sessionJoinLink, 'Join link')}
                                disabled={!sessionJoinLink}
                            >
                                Copy Join Link
                            </button>
                            {selectedSession?.session_token && (
                                <button
                                    className={styles.secondaryBtn}
                                    onClick={() => copyToClipboard(selectedSession.session_token, 'Session token')}
                                >
                                    Copy Session Token
                                </button>
                            )}
                            <button
                                className={styles.secondaryBtn}
                                onClick={async () => {
                                    try {
                                        const res = await fetch(`${apiBase}/sessions/${sessionId}/export_workspaces/`, {
                                            method: 'POST',
                                            headers: authHeaders,
                                        });
                                        const data = await parseJsonResponse(res);
                                        alert(data.message);
                                    } catch (err) {
                                        alert('Failed to export: ' + (err as Error).message);
                                    }
                                }}
                            >
                                Save All Workspaces
                            </button>
                            <button className={styles.dangerBtn} onClick={handleEndSession}>End Session</button>
                        </div>
                        {sessionJoinLink
                            ? <p className={styles.linkHint}>Join link: {sessionJoinLink}</p>
                            : <p className={styles.linkHint}>Join link unavailable while using localhost. Use Commander via host IP.</p>}
                        {copyMessage && <p className={styles.message}>{copyMessage}</p>}
                    </div>

                    <div className={styles.featureToggles}>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => toggleSessionFeature('toggle_ai', !selectedSession?.ai_enabled)}
                        >
                            AI: {selectedSession?.ai_enabled ? 'ON' : 'OFF'}
                        </button>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => toggleSessionFeature('toggle_autocomplete', !selectedSession?.autocomplete_enabled)}
                        >
                            Autocomplete: {selectedSession?.autocomplete_enabled ? 'ON' : 'OFF'}
                        </button>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => toggleSessionFeature('toggle_leaderboard_visibility', !selectedSession?.leaderboard_visible)}
                        >
                            operator leaderboard: {selectedSession?.leaderboard_visible ? 'ON' : 'OFF'}
                        </button>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => toggleSessionFeature('toggle_download', !selectedSession?.allow_operator_download)}
                        >
                            Allow operator Downloads: {selectedSession?.allow_operator_download ? 'YES' : 'NO'}
                        </button>
                        <button
                            className={styles.secondaryBtn}
                            onClick={() => setShowWhiteboard((prev) => !prev)}
                        >
                            Whiteboard: {showWhiteboard ? 'ON' : 'OFF'}
                        </button>
                    </div>

                    <div className={styles.operatorsWrap}>
                        <h3>operators ({operators.length})</h3>
                        {operators.length === 0 ? (
                            <p>No operators connected yet.</p>
                        ) : (
                            <div className={styles.grid}>
                                {operators.map((operator) => (
                                    <div key={operator.id} className={styles.operatorCard}>
                                        <div className={styles.statusRow}>
                                            <span>
                                                {!operator.is_online ? 'âš«' :
                                                    operator.current_activity?.status === 'red' ? 'ðŸ”´' :
                                                        operator.current_activity?.status === 'yellow' ? 'ðŸŸ¡' :
                                                            operator.current_activity?.status === 'green' ? 'ðŸŸ¢' : 'âšª'}
                                            </span>
                                            <div>
                                                <h4>{operator.name}</h4>
                                                <p>@{operator.username}</p>
                                            </div>
                                        </div>
                                        {operator.current_activity && (
                                            <p className={styles.activity}>
                                                {operator.current_activity.status}: {operator.current_activity.message}
                                            </p>
                                        )}
                                        <button
                                            className={styles.secondaryBtn}
                                            onClick={() => handleSelectoperator(operator)}
                                        >
                                            Monitor Live
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className={styles.livePanel}>
                        <div className={styles.liveHeader}>
                            <h3>Live Monitor</h3>
                            <div className={styles.rowBtns}>
                                <p>
                                    Sync: {isWsConnected ? 'Realtime (WebSocket)' : 'Fallback (HTTP)'}
                                </p>
                                <button
                                    className={styles.primaryBtn}
                                    onClick={broadcastCommanderCode}
                                    disabled={!selectedoperatorId || !selectedFileId}
                                >
                                    Broadcast Commander Editor
                                </button>
                            </div>
                        </div>

                        {selectedoperatorId ? (
                            <>
                                <div className={styles.toolbarRow}>
                                    <select
                                        className={styles.select}
                                        value={aiModel}
                                        onChange={(e) => setAiModel(e.target.value)}
                                    >
                                        {aiModelOptions.map((option) => (
                                            <option key={option.value} value={option.value}>{option.label}</option>
                                        ))}
                                    </select>
                                    <select
                                        className={styles.select}
                                        value={selectedFileId}
                                        onChange={(e) => setSelectedFileId(e.target.value)}
                                    >
                                        {operatorFiles.map((file) => (
                                            <option key={file.id} value={file.id}>{file.filename}</option>
                                        ))}
                                    </select>
                                    <button className={styles.secondaryBtn} onClick={executeCommanderCode}>Execute</button>
                                    <button className={styles.secondaryBtn} onClick={saveSnapshot}>Save Snapshot</button>
                                    <button className={styles.secondaryBtn} onClick={requestAiSuggestion}>Process AI</button>
                                </div>

                                <div className={styles.toolbarRow}>
                                    <input
                                        className={styles.input}
                                        placeholder="Optional AI prompt"
                                        value={aiPrompt}
                                        onChange={(e) => setAiPrompt(e.target.value)}
                                    />
                                </div>

                                <TestCreator apiBase={apiBase} authHeaders={authHeaders} sessionId={sessionId} operatorId={selectedoperatorId} model={aiModel} />

                                <div className={styles.toolbarRow}>
                                    <input
                                        className={styles.input}
                                        placeholder="Terminal command (example: pip install requests)"
                                        value={terminalCommand}
                                        onChange={(e) => setTerminalCommand(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                runCommanderTerminalCommand();
                                            }
                                        }}
                                    />
                                    <button className={styles.secondaryBtn} onClick={runCommanderTerminalCommand}>Run Terminal</button>
                                </div>

                                <div className={styles.monitorGrid}>
                                    <div className={styles.editorWrap}>
                                        <MonacoEditor
                                            height="420px"
                                            language="python"
                                            theme="vs-dark"
                                            value={editorContent}
                                            onChange={handleCommanderCodeChange}
                                            options={{
                                                minimap: { enabled: false },
                                                fontSize: 14,
                                                lineNumbers: 'on',
                                            }}
                                        />
                                    </div>
                                    <div className={styles.sideOutput}>
                                        <h4>Output</h4>
                                        <pre>{executionOutput}</pre>
                                        <h4>AI Suggestion</h4>
                                        <pre>{aiSuggestion || 'Ask AI for guidance'}</pre>
                                    </div>
                                </div>
                            </>
                        ) : (
                            <p>Select a operator to start live monitoring and editing.</p>
                        )}
                    </div>

                    <div className={styles.livePanel}>
                        <div className={styles.liveHeader}>
                            <h3>Broadcast Files</h3>
                            <p>{broadcastFiles.length} shared</p>
                        </div>
                        <div className={styles.toolbarRow}>
                            <input
                                className={styles.input}
                                type="file"
                                accept=".pdf,.ppt,.pptx,.doc,.docx,.jpg,.jpeg,.png,.gif,.bmp,.txt,.zip"
                                onChange={(e) => setBroadcastUploadFile(e.target.files?.[0] || null)}
                            />
                            <input
                                className={styles.input}
                                placeholder="Broadcast note for operators"
                                value={broadcastDescription}
                                onChange={(e) => setBroadcastDescription(e.target.value)}
                            />
                            <button className={styles.primaryBtn} onClick={uploadBroadcastFile} disabled={uploadingBroadcast || !broadcastUploadFile}>
                                {uploadingBroadcast ? 'Uploading...' : 'Upload Broadcast File'}
                            </button>
                        </div>
                        <div className={styles.broadcastList}>
                            {broadcastFiles.length === 0 ? (
                                <p>No broadcast files yet.</p>
                            ) : (
                                broadcastFiles.map((file) => (
                                    <div key={file.id} className={styles.broadcastCard}>
                                        <div>
                                            <strong>{file.filename}</strong>
                                            <p>{file.description || file.file_type}</p>
                                        </div>
                                        <div className={styles.rowBtns}>
                                            {file.file_url && file.file_type !== 'pdf' && (
                                                <a className={styles.secondaryBtn} href={file.file_url} target="_blank" rel="noreferrer">
                                                    Open
                                                </a>
                                            )}
                                            <button
                                                className={file.is_active ? styles.dangerBtn : styles.secondaryBtn}
                                                onClick={() => setBroadcastFileActiveState(file.id, !file.is_active)}
                                            >
                                                {file.is_active ? 'Stop Broadcast' : 'Broadcast to operators'}
                                            </button>
                                        </div>
                                        {renderBroadcastPreview(file)}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className={styles.livePanel}>
                        <div className={styles.liveHeader}>
                            <h3>Behavior Report</h3>
                            <p>Weekly total: {analyticsReport?.weekly_activity_total ?? 0}</p>
                        </div>
                        {analyticsReport?.top_10?.length ? (
                            <div className={styles.leaderboardList}>
                                {analyticsReport.top_10.map((operator, index) => (
                                    <div key={operator.operator_id} className={styles.leaderboardCard}>
                                        <div>
                                            <strong>#{index + 1} {operator.name}</strong>
                                            <p>@{operator.username}</p>
                                        </div>
                                        <div className={styles.leaderboardStats}>
                                            <span>Score {operator.score}</span>
                                            <span>Accuracy {operator.accuracy}%</span>
                                            <span>Execs {operator.total_executions}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p>No weekly behavior data yet.</p>
                        )}
                    </div>

                    {showWhiteboard && (
                        <div className={styles.livePanel}>
                            <div className={styles.liveHeader}>
                                <h3>Interactive Whiteboard</h3>
                                <p>Live synced</p>
                            </div>
                            <Whiteboard
                                isCommander={true}
                                initialData={whiteboardSceneData || undefined}
                                onUpdate={sendWhiteboardUpdate}
                            />
                        </div>
                    )}

                    <div className={styles.livePanel}>
                        <div className={styles.liveHeader}>
                            <h3>Task Board</h3>
                            <p>{tasks.length} tasks</p>
                        </div>

                        <div className={styles.toolbarRow}>
                            <input
                                className={styles.input}
                                placeholder="Task title"
                                value={taskTitle}
                                onChange={(e) => setTaskTitle(e.target.value)}
                            />
                            <select className={styles.select} value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as SessionTask['priority'])}>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="critical">Critical</option>
                            </select>
                            <select className={styles.select} value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)}>
                                <option value="">Unassigned</option>
                                {operators.map((operator) => (
                                    <option key={operator.id} value={operator.id}>{operator.name}</option>
                                ))}
                            </select>
                            <button className={styles.secondaryBtn} onClick={createTask}>Add Task</button>
                        </div>
                        <div className={styles.toolbarRow}>
                            <input
                                className={styles.input}
                                placeholder="Task description"
                                value={taskDescription}
                                onChange={(e) => setTaskDescription(e.target.value)}
                            />
                        </div>

                        <div className={styles.taskList}>
                            {tasks.length === 0 ? (
                                <p>No tasks yet.</p>
                            ) : (
                                tasks.map((task) => (
                                    <div key={task.id} className={styles.taskCard}>
                                        <div>
                                            <strong>{task.title}</strong>
                                            <p>{task.description || 'No description'}</p>
                                            <p>Priority: {task.priority} | Status: {task.status}</p>
                                            <p>Assignee: {task.assigned_operator_name || 'Unassigned'}</p>
                                        </div>
                                        <div className={styles.rowBtns}>
                                            <button className={styles.secondaryBtn} onClick={() => updateTaskStatus(task, 'in_progress')}>Start</button>
                                            <button className={styles.secondaryBtn} onClick={() => updateTaskStatus(task, 'blocked')}>Block</button>
                                            <button className={styles.secondaryBtn} onClick={() => updateTaskStatus(task, 'done')}>Done</button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <button
                        className={styles.secondaryBtn}
                        onClick={() => {
                            setSessionId('');
                            loadSessions();
                        }}
                    >
                        Back to Sessions
                    </button>
                </div>
            )}

            {maximizedPdf && (
                <div
                    style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', flexDirection: 'column' }}
                >
                    <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1c2b36' }}>
                        <h3 style={{ margin: 0, color: '#fff' }}>{maximizedPdf.title}</h3>
                        <button
                            style={{ background: '#d32f2f', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                            onClick={() => setMaximizedPdf(null)}
                        >
                            Close
                        </button>
                    </div>
                    <div style={{ flex: 1, width: '100%', overflow: 'auto' }}>
                        <PdfWhiteboard
                            isCommander={true}
                            pdfUrl={maximizedPdf.url}
                            pdfTitle={maximizedPdf.title}
                            currentPage={pdfCurrentPages[maximizedPdf.fileId] || 1}
                            initialWhiteboardData={pdfWhiteboardData[maximizedPdf.fileId] || {}}
                            onClose={() => setMaximizedPdf(null)}
                            showMaximizeButton={false}
                            allowWheelPageSwitch={true}
                            onPageChange={(page) => sendPdfPageChange(maximizedPdf.fileId, page)}
                            onWhiteboardUpdate={(page, elements, appState) => sendPdfWhiteboardUpdate(maximizedPdf.fileId, page, elements, appState)}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

