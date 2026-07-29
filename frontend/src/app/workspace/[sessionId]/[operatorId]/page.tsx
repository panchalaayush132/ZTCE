'use client';

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import styles from './editor.module.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { resolveApiBase } from '../../../../lib/api-base';
import Whiteboard from '../../../../components/Whiteboard';
import OperatorTests from '../../../../components/OperatorTests';

const PdfWhiteboard = dynamic(() => import('../../../../components/PdfWhiteboard'), { ssr: false });

interface OperatorFile {
    id: string;
    filename: string;
    content: string;
    version: number;
}

interface Message {
    id: string;
    sender: string;
    content: string;
    created_at: string;
    is_read: boolean;
}

interface ExecutionResult {
    stdout: string;
    stderr: string;
    return_code: number;
    execution_time: number;
}

interface FileTreeNode {
    key: string;
    name: string;
    type: 'file' | 'folder';
    file?: OperatorFile;
    children?: FileTreeNode[];
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

interface AnalyticsReportOperator {
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
    top_10: AnalyticsReportOperator[];
}

interface LocalBackupFile {
    id?: string;
    filename: string;
    content: string;
    version: number;
}

interface LocalBackupPayload {
    updated_at: string;
    files: LocalBackupFile[];
}

// Dynamic import for Monaco Editor
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export default function OperatorEditor() {
    const params = useParams();
    const sessionId = params.sessionId as string;
    const operatorId = params.operatorId as string;
    const router = useRouter();

    const [files, setFiles] = useState<OperatorFile[]>([]);
    const [currentFile, setCurrentFile] = useState<OperatorFile | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [newMessage, setNewMessage] = useState('');
    const [output, setOutput] = useState('Code output will appear here');
    const [terminalCommand, setTerminalCommand] = useState('');
    const [executing, setExecuting] = useState(false);
    const [useBasicEditor, setUseBasicEditor] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [showNewFile, setShowNewFile] = useState(false);
    const [isWsConnected, setIsWsConnected] = useState(false);
    const [isEditorReady, setIsEditorReady] = useState(false);
    const [activityStatus, setActivityStatus] = useState<'green' | 'yellow' | 'red' | 'idle'>('idle');
    const [activityMessage, setActivityMessage] = useState('');
    const [sessionInfo, setSessionInfo] = useState<{ leaderboard_visible: boolean; admin_name?: string; allow_operator_download?: boolean } | null>(null);
    const [broadcastFiles, setBroadcastFiles] = useState<BroadcastFile[]>([]);
    const [adminBroadcastCode, setAdminBroadcastCode] = useState('');
    const [analyticsReport, setAnalyticsReport] = useState<AnalyticsReport | null>(null);
    const [maximizedPdf, setMaximizedPdf] = useState<{ url: string; title: string; fileId: string } | null>(null);
    const [localSaveNotice, setLocalSaveNotice] = useState('');
    const [whiteboardData, setWhiteboardData] = useState<{ elements: any, appState: any } | null>(null);
    const [pdfWhiteboardData, setPdfWhiteboardData] = useState<Record<string, Record<number, any>>>({});
    const [pdfCurrentPages, setPdfCurrentPages] = useState<Record<string, number>>({});
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const apiBase = useMemo(() => {
        return resolveApiBase(process.env.NEXT_PUBLIC_API_BASE);
    }, []);
    const autoSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
    const wsBroadcastTimerRef = useRef<NodeJS.Timeout | null>(null);
    const terminalRef = useRef<HTMLDivElement | null>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const sessionWsRef = useRef<WebSocket | null>(null);
    const sessionWsReconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
    const wsReconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
    const wsManualCloseRef = useRef(false);
    const wsSendTimerRef = useRef<NodeJS.Timeout | null>(null);
    const applyingRemoteRef = useRef(false);
    const currentFileRef = useRef<OperatorFile | null>(null);
    const lastLocalEditAtRef = useRef(0);
    const lastRemoteSyncAtRef = useRef(0);
    const lastAppliedRemoteVersionRef = useRef(0);
    const fallbackPollBackoffUntilRef = useRef(0);
    const localBackupTimerRef = useRef<NodeJS.Timeout | null>(null);
    const clientIdRef = useRef(`operator-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`);
    const wsBase = useMemo(() => apiBase.replace(/\/api\/?$/, '').replace(/^http/, 'ws'), [apiBase]);
    const localBackupKey = useMemo(() => `edusync:operator-backup:${sessionId}:${operatorId}`, [sessionId, operatorId]);
    const downloadsPathHint = useMemo(() => {
        if (typeof navigator === 'undefined') {
            return 'Downloads folder';
        }

        const platform = (navigator.platform || '').toLowerCase();
        if (platform.includes('win')) {
            return 'C:/Users/<your-username>/Downloads';
        }
        if (platform.includes('mac')) {
            return '/Users/<your-username>/Downloads';
        }
        return '~/Downloads';
    }, []);

    useEffect(() => {
        currentFileRef.current = currentFile;
    }, [currentFile]);

    const parseJsonResponse = useCallback(async (res: Response) => {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(`Expected JSON but got: ${text.slice(0, 120)}`);
        }
        return res.json();
    }, []);

    const isLoopbackHost = useCallback((hostname: string) => {
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    }, []);

    const resolveBroadcastUrl = useCallback((rawUrl: string | null) => {
        if (!rawUrl) {
            return null;
        }

        try {
            const baseUrl = new URL(apiBase);
            const resolved = new URL(rawUrl, baseUrl.origin);
            const runtimeHost = typeof window !== 'undefined' ? window.location.hostname : '';

            if (runtimeHost && !isLoopbackHost(runtimeHost) && isLoopbackHost(resolved.hostname)) {
                resolved.hostname = runtimeHost;
            }

            return resolved.toString();
        } catch {
            return rawUrl;
        }
    }, [apiBase, isLoopbackHost]);

    const loadLocalBackup = useCallback((): LocalBackupPayload | null => {
        try {
            const raw = localStorage.getItem(localBackupKey);
            if (!raw) {
                return null;
            }
            const parsed = JSON.parse(raw) as LocalBackupPayload;
            if (!Array.isArray(parsed.files)) {
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }, [localBackupKey]);

    const saveFilesToLocalBackup = useCallback((filesToSave: OperatorFile[]) => {
        try {
            const payload: LocalBackupPayload = {
                updated_at: new Date().toISOString(),
                files: filesToSave.map((file) => ({
                    id: file.id,
                    filename: file.filename,
                    content: file.content,
                    version: file.version || 0,
                })),
            };
            localStorage.setItem(localBackupKey, JSON.stringify(payload));

            const verify = localStorage.getItem(localBackupKey);
            if (!verify) {
                return false;
            }
            const parsed = JSON.parse(verify) as LocalBackupPayload;
            return Array.isArray(parsed.files) && parsed.files.length === payload.files.length;
        } catch {
            // Ignore storage quota or browser-private-mode errors.
            return false;
        }
    }, [localBackupKey]);

    const saveLocalBackupWithNotice = useCallback((filesToSave: OperatorFile[], successMessage: string) => {
        const saved = saveFilesToLocalBackup(filesToSave);
        setLocalSaveNotice(saved ? successMessage : 'Local save failed (browser storage unavailable)');
        setTimeout(() => setLocalSaveNotice(''), 1600);
        return saved;
    }, [saveFilesToLocalBackup]);

    const exportFilesToComputer = useCallback((filesToExport: OperatorFile[]) => {
        if (!filesToExport.length) {
            return false;
        }

        try {
            const payload = {
                saved_at: new Date().toISOString(),
                session_id: sessionId,
                operator_id: operatorId,
                files: filesToExport.map((file) => ({
                    filename: file.filename,
                    content: file.content,
                    version: file.version || 0,
                })),
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
            const link = document.createElement('a');
            const objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
            link.download = `edusync_backup_${sessionId.slice(0, 8)}_${operatorId.slice(0, 8)}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            return true;
        } catch {
            return false;
        }
    }, [sessionId, operatorId]);

    const fileTree = useMemo<FileTreeNode[]>(() => {
        const root: FileTreeNode[] = [];

        const findFolder = (nodes: FileTreeNode[], key: string) => nodes.find((n) => n.type === 'folder' && n.key === key);

        for (const file of files) {
            const parts = file.filename.split('/').filter(Boolean);
            let cursor = root;
            let pathAcc = '';

            parts.forEach((part, index) => {
                pathAcc = pathAcc ? `${pathAcc}/${part}` : part;
                const isFile = index === parts.length - 1;

                if (isFile) {
                    cursor.push({ key: pathAcc, name: part, type: 'file', file });
                    return;
                }

                let folder = findFolder(cursor, pathAcc);
                if (!folder) {
                    folder = { key: pathAcc, name: part, type: 'folder', children: [] };
                    cursor.push(folder);
                }
                cursor = folder.children!;
            });
        }

        const sortTree = (nodes: FileTreeNode[]) => {
            nodes.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'folder' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });
            nodes.forEach((node) => {
                if (node.children) {
                    sortTree(node.children);
                }
            });
        };

        sortTree(root);
        return root;
    }, [files]);

    const renderTree = (nodes: FileTreeNode[], level = 0): ReactNode[] => {
        return nodes.flatMap((node) => {
            if (node.type === 'folder') {
                return [
                    (
                        <div key={node.key} className={styles.folderItem} style={{ paddingLeft: `${8 + level * 14}px` }}>
                            📁 {node.name}
                        </div>
                    ),
                    ...renderTree(node.children || [], level + 1),
                ];
            }

            return [
                (
                    <div
                        key={node.key}
                        className={`${styles.fileItem} ${currentFile?.id === node.file?.id ? styles.active : ''}`}
                        style={{ paddingLeft: `${8 + level * 14}px` }}
                        onClick={() => node.file && setCurrentFile(node.file)}
                    >
                        <span>📄 {node.name}</span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (node.file) {
                                    handleDeleteFile(node.file.id);
                                }
                            }}
                            className={styles.deleteBtn}
                        >
                            ✕
                        </button>
                    </div>
                ),
            ];
        });
    };

    // Load files
    const loadFiles = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/operators/${operatorId}/get_files/`);
            const data = await parseJsonResponse(res);
            const filesList: OperatorFile[] = data.results || data || [];

            const localBackup = loadLocalBackup();
            const localByFilename = new Map((localBackup?.files || []).map((item) => [item.filename, item]));

            const mergedFiles = filesList.map((remoteFile) => {
                const localFile = localByFilename.get(remoteFile.filename);
                if (!localFile) {
                    return remoteFile;
                }
                // Prefer local content only when local version is newer or equal.
                if ((localFile.version || 0) >= (remoteFile.version || 0) && localFile.content !== remoteFile.content) {
                    return {
                        ...remoteFile,
                        content: localFile.content,
                        version: Math.max(localFile.version || 0, remoteFile.version || 0),
                    };
                }
                return remoteFile;
            });

            const fallbackLocalFiles: OperatorFile[] =
                filesList.length === 0 && (localBackup?.files?.length || 0) > 0
                    ? (localBackup?.files || []).map((localFile, index) => ({
                        id: localFile.id || `local-${index}`,
                        filename: localFile.filename,
                        content: localFile.content,
                        version: localFile.version || 0,
                    }))
                    : [];

            const effectiveFiles = mergedFiles.length > 0 ? mergedFiles : fallbackLocalFiles;
            setFiles(effectiveFiles);
            if (effectiveFiles.length > 0 && !currentFile) {
                setCurrentFile(effectiveFiles[0]);
            }
            if (effectiveFiles === fallbackLocalFiles && fallbackLocalFiles.length > 0) {
                setLocalSaveNotice('Loaded local backup (server files unavailable)');
                setTimeout(() => setLocalSaveNotice(''), 2200);
            }
        } catch (err) {
            const localBackup = loadLocalBackup();
            const localFiles: OperatorFile[] = (localBackup?.files || []).map((localFile, index) => ({
                id: localFile.id || `local-${index}`,
                filename: localFile.filename,
                content: localFile.content,
                version: localFile.version || 0,
            }));
            setFiles(localFiles);
            if (localFiles.length > 0) {
                setCurrentFile((prev) => prev || localFiles[0]);
                setLocalSaveNotice('Loaded local backup (server offline)');
                setTimeout(() => setLocalSaveNotice(''), 2200);
            }
        }
    }, [apiBase, operatorId, currentFile, loadLocalBackup]);

    // Load messages
    const loadMessages = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/messages/get_operator_messages/?operator_id=${operatorId}`);
            const data = await parseJsonResponse(res);
            setMessages(data.results || data || []);
        } catch (err) {
            setMessages([]);
        }
    }, [apiBase, operatorId]);

    const loadSessionInfo = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/sessions/${sessionId}/`);
            const data = await parseJsonResponse(res);
            setSessionInfo({
                leaderboard_visible: !!data?.leaderboard_visible,
                admin_name: data?.admin_name,
                allow_operator_download: !!data?.allow_operator_download,
            });
        } catch {
            setSessionInfo(null);
        }
    }, [apiBase, parseJsonResponse, sessionId]);

    const loadBroadcastFiles = useCallback(async () => {
        try {
            const res = await fetch(`${apiBase}/broadcasts/get_session_files/?session_id=${sessionId}`);
            const data: BroadcastFile[] = await parseJsonResponse(res);
            const nextFiles = data || [];
            setBroadcastFiles((prev) => {
                if (prev.length !== nextFiles.length) {
                    return nextFiles;
                }

                const unchanged = prev.every((item, index) => {
                    const next = nextFiles[index];
                    if (!next) {
                        return false;
                    }
                    return (
                        item.id === next.id &&
                        item.file_url === next.file_url &&
                        item.file_type === next.file_type &&
                        item.description === next.description &&
                        item.is_active === next.is_active &&
                        item.uploaded_at === next.uploaded_at
                    );
                });

                return unchanged ? prev : nextFiles;
            });
        } catch {
            // Keep existing broadcast content on transient connectivity errors.
            setBroadcastFiles((prev) => prev);
        }
    }, [apiBase, parseJsonResponse, sessionId]);

    const loadAnalyticsReport = useCallback(async () => {
        if (!sessionInfo?.leaderboard_visible) {
            setAnalyticsReport(null);
            return;
        }

        try {
            const res = await fetch(`${apiBase}/sessions/${sessionId}/public_analytics_report/`);
            const data = await parseJsonResponse(res);
            setAnalyticsReport(data);
        } catch {
            setAnalyticsReport(null);
        }
    }, [apiBase, parseJsonResponse, sessionId, sessionInfo?.leaderboard_visible]);

    const sendHeartbeat = useCallback(async () => {
        try {
            await fetch(`${apiBase}/operators/${operatorId}/heartbeat/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch (err) {
            return;
        }
    }, [apiBase, operatorId]);

    // Auto-save file content
    const autoSaveFile = useCallback(async (file: OperatorFile) => {
        if (!file || !file.id) return;

        try {
            const res = await fetch(`${apiBase}/files/${file.id}/update_content/`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: file.content,
                    language: 'python',
                    client_id: clientIdRef.current,
                }),
            });
            return res.ok;
        } catch (err) {
            return false;
        }
    }, [apiBase]);

    const saveCurrentFile = useCallback(async () => {
        if (!currentFile) {
            return;
        }

        const localFiles = files.length > 0
            ? files.map((file) => (file.id === currentFile.id ? { ...file, content: currentFile.content } : file))
            : [{ ...currentFile }];
        const localOk = saveLocalBackupWithNotice(localFiles, 'Saved locally on this device');
        const backendOk = await autoSaveFile(currentFile);
        if (backendOk && localOk) {
            setLocalSaveNotice('Saved locally + server');
            setTimeout(() => setLocalSaveNotice(''), 1800);
        } else if (!backendOk && localOk) {
            setLocalSaveNotice('Saved locally only (server save failed)');
            setTimeout(() => setLocalSaveNotice(''), 1800);
        } else if (!backendOk && !localOk) {
            setLocalSaveNotice('Save failed (local + server)');
            setTimeout(() => setLocalSaveNotice(''), 1800);
        }
    }, [autoSaveFile, currentFile, files, saveLocalBackupWithNotice]);

    const exitSession = useCallback(async () => {
        try {
            const localFiles = currentFile
                ? files.map((file) => (file.id === currentFile.id ? { ...file, content: currentFile.content } : file))
                : files;
            saveFilesToLocalBackup(localFiles);
            await saveCurrentFile();
            await fetch(`${apiBase}/operators/${operatorId}/leave_session/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch {
            // Ignore navigation errors.
        } finally {
            router.push('/');
        }
    }, [apiBase, currentFile, files, router, saveCurrentFile, saveFilesToLocalBackup, operatorId]);

    // Debounced save on content change
    const handleEditorChange = (value: string | undefined) => {
        if (!currentFile || value === undefined) return;
        if (value === currentFile.content) return;

        const updatedFile = { ...currentFile, content: value };

        setActivityStatus('green');
        setActivityMessage('Actively Coding');
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            setActivityStatus((prev) => (prev === 'green' ? 'yellow' : prev));
            setActivityMessage('Idle');
        }, 15000);

        lastLocalEditAtRef.current = Date.now();
        setCurrentFile(updatedFile);

        if (localBackupTimerRef.current) {
            clearTimeout(localBackupTimerRef.current);
        }
        localBackupTimerRef.current = setTimeout(() => {
            const localFiles = files.length > 0
                ? files.map((file) => (file.id === updatedFile.id ? { ...file, content: value } : file))
                : [{ ...updatedFile, content: value }];
            saveFilesToLocalBackup(localFiles);
        }, 500);

        if (!applyingRemoteRef.current && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            if (wsSendTimerRef.current) {
                clearTimeout(wsSendTimerRef.current);
            }

            const flush = () => {
                wsRef.current?.send(JSON.stringify({
                    type: 'code_update',
                    filename: updatedFile.filename,
                    content: value,
                    client_id: clientIdRef.current,
                }));
            };

            // Word-wise sync: flush immediately on whitespace/newline, else tiny debounce.
            if (/\s$/.test(value)) {
                flush();
            } else {
                wsSendTimerRef.current = setTimeout(flush, 60);
            }
        }

        // Clear existing timer
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
        }

        // Set new timer for 500ms debounce
        const saveDelay = isWsConnected ? 220 : 180;
        autoSaveTimerRef.current = setTimeout(() => {
            autoSaveFile(updatedFile);
        }, saveDelay);
    };

    // Create new file
    const handleCreateFile = async () => {
        if (!newFileName.trim()) {
            alert('Enter filename');
            return;
        }

        try {
            const res = await fetch(`${apiBase}/files/create_file/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    operator_id: operatorId,
                    filename: newFileName,
                    content: '# Start coding here\n',
                    language: 'python',
                }),
            });
            const newFile = await parseJsonResponse(res);
            if (!res.ok) {
                throw new Error(newFile?.error || newFile?.detail || 'Failed to create file');
            }
            setFiles([...files, newFile]);
            setCurrentFile(newFile);
            setNewFileName('');
            setShowNewFile(false);
        } catch (err) {
            alert('Failed to create file: ' + (err as any).message);
        }
    };

    // Delete file
    const handleDeleteFile = async (fileId: string) => {
        if (!confirm('Delete this file?')) return;

        try {
            const res = await fetch(`${apiBase}/files/delete_file/`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: fileId }),
            });
            await parseJsonResponse(res);
            const updatedFiles = files.filter((f) => f.id !== fileId);
            setFiles(updatedFiles);
            if (currentFile?.id === fileId) {
                setCurrentFile(updatedFiles.length > 0 ? updatedFiles[0] : null);
            }
        } catch (err) {
            alert('Failed to delete file: ' + (err as any).message);
        }
    };

    // Execute code
    const handleExecuteCode = async () => {
        if (!currentFile) {
            alert('No file selected');
            return;
        }

        setExecuting(true);
        setOutput('Running...');

        try {
            const res = await fetch(`${apiBase}/executions/execute/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: currentFile.content,
                    operator_id: operatorId,
                    file_id: currentFile.id,
                }),
            });
            const result: ExecutionResult = await parseJsonResponse(res);

            if (result.return_code === 0 && !result.stderr) {
                setActivityStatus('green');
                setActivityMessage('Execution successful');
            } else {
                setActivityStatus('red');
                setActivityMessage('Execution error');
            }

            setOutput(
                `${result.stdout}${result.stderr ? '\nERROR:\n' + result.stderr : ''}\n\nReturn Code: ${result.return_code} (${result.execution_time}ms)`
            );
        } catch (err) {
            setActivityStatus('red');
            setActivityMessage('Execution failed');
            setOutput('Execution failed: ' + (err as any).message);
        } finally {
            setExecuting(false);
        }
    };

    const handleRunTerminalCommand = async () => {
        if (!terminalCommand.trim()) {
            return;
        }

        const command = terminalCommand.trim();
        setOutput((prev) => `${prev}\n\n$ ${command}\nRunning...`);

        try {
            const res = await fetch(`${apiBase}/executions/run_terminal/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    operator_id: operatorId,
                    command,
                }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                setOutput((prev) => `${prev}\nERROR: ${data?.error || 'Terminal command failed'}`);
                return;
            }

            const commandOutput = `${data.stdout || ''}${data.stderr ? `\nERROR:\n${data.stderr}` : ''}`;
            setOutput((prev) => `${prev}\n${commandOutput}\n\nReturn Code: ${data.return_code} (${data.execution_time}ms)`);
            setTerminalCommand('');
        } catch (err) {
            setOutput((prev) => `${prev}\nExecution failed: ${(err as Error).message}`);
        }
    };

    // Send message
    const handleSendMessage = async () => {
        if (!newMessage.trim()) return;

        try {
            await fetch(`${apiBase}/messages/send_message/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sender: 'operator',
                    content: newMessage,
                    operator_id: operatorId,
                }),
            });
            setNewMessage('');
            loadMessages();
        } catch (err) {
            alert('Failed to send message: ' + (err as any).message);
        }
    };

    const renderBroadcastPreview = (file: BroadcastFile) => {
        const normalizedUrl = resolveBroadcastUrl(file.file_url);
        if (!normalizedUrl) {
            return null;
        }

        if (file.file_type === 'image') {
            return <img className={styles.broadcastPreview} src={normalizedUrl} alt={file.filename} />;
        }

        if (file.file_type === 'pdf') {
            return (
                <div className={styles.pdfPreviewWrap}>
                    <PdfWhiteboard
                        isAdmin={false}
                        pdfUrl={normalizedUrl}
                        pdfTitle={file.filename}
                        currentPage={pdfCurrentPages[file.id] || 1}
                        initialWhiteboardData={pdfWhiteboardData[file.id] || {}}
                        showMaximizeButton={false}
                    />
                    <div className={styles.pdfControls}>
                        <button
                            className={styles.pdfActionBtn}
                            onClick={() => setMaximizedPdf({ url: normalizedUrl, title: file.filename, fileId: file.id })}
                        >
                            Open PDF (Maximize)
                        </button>
                        <a className={styles.pdfActionBtn} href={normalizedUrl} target="_blank" rel="noreferrer" download>
                            Download PDF
                        </a>
                    </div>
                </div>
            );
        }

        return sessionInfo?.allow_operator_download ? (
            <a className={styles.broadcastDownload} href={normalizedUrl} target="_blank" rel="noreferrer">
                Download shared file
            </a>
        ) : null;
    };

    // Initial load
    useEffect(() => {
        loadFiles();
        loadMessages();
        loadSessionInfo();
        loadBroadcastFiles();
        loadAnalyticsReport();
        sendHeartbeat();

        const messageInterval = setInterval(loadMessages, 3000);
        const heartbeatInterval = setInterval(sendHeartbeat, 10000);
        const sessionRefreshInterval = setInterval(() => {
            loadSessionInfo();
            loadBroadcastFiles();
            loadAnalyticsReport();
        }, 15000);

        return () => {
            clearInterval(messageInterval);
            clearInterval(heartbeatInterval);
            clearInterval(sessionRefreshInterval);
        };
    }, [loadAnalyticsReport, loadBroadcastFiles, loadFiles, loadMessages, loadSessionInfo, sendHeartbeat]);

    useEffect(() => {
        if (!sessionId) {
            return;
        }

        let disposed = false;

        const connectSessionSocket = () => {
            if (disposed) {
                return;
            }

            if (sessionWsRef.current) {
                sessionWsRef.current.close();
                sessionWsRef.current = null;
            }

            const socket = new WebSocket(`${wsBase}/ws/session/${sessionId}/`);
            sessionWsRef.current = socket;

            socket.onopen = () => {
                loadBroadcastFiles();
            };

            socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload.type === 'file_broadcast') {
                        loadBroadcastFiles();
                    }
                    if (payload.type === 'admin_code_update') {
                        setAdminBroadcastCode(payload.code || '');
                    }
                    if (payload.type === 'whiteboard_update') {
                        setWhiteboardData({ elements: payload.elements, appState: payload.appState });
                    }
                    if (payload.type === 'pdf_whiteboard_update') {
                        setPdfWhiteboardData(prev => ({
                            ...prev,
                            [payload.file_id]: {
                                ...(prev[payload.file_id] || {}),
                                [payload.page]: { elements: payload.elements, appState: payload.appState }
                            }
                        }));
                    }
                    if (payload.type === 'pdf_page_change') {
                        setPdfCurrentPages(prev => ({ ...prev, [payload.file_id]: payload.page }));
                    }
                    if (payload.type === 'operator_added' || payload.type === 'activity_update' || payload.type === 'ai_status_changed') {
                        loadSessionInfo();
                        loadAnalyticsReport();
                    }
                } catch (err) {
                    console.error('Session WS parse error:', err);
                }
            };

            socket.onclose = () => {
                if (disposed) {
                    return;
                }
                sessionWsReconnectTimerRef.current = setTimeout(connectSessionSocket, 900);
            };

            socket.onerror = () => {
                // Fallback polling continues via intervals.
            };
        };

        connectSessionSocket();

        return () => {
            disposed = true;
            if (sessionWsReconnectTimerRef.current) {
                clearTimeout(sessionWsReconnectTimerRef.current);
                sessionWsReconnectTimerRef.current = null;
            }
            if (sessionWsRef.current) {
                sessionWsRef.current.close();
                sessionWsRef.current = null;
            }
        };
    }, [loadAnalyticsReport, loadBroadcastFiles, loadSessionInfo, sessionId, wsBase]);

    useEffect(() => {
        const connectSocket = () => {
            wsManualCloseRef.current = false;
            const socket = new WebSocket(`${wsBase}/ws/operator/${operatorId}/`);
            wsRef.current = socket;

            socket.onopen = () => {
                setIsWsConnected(true);
            };

            socket.onclose = () => {
                setIsWsConnected(false);
                if (!wsManualCloseRef.current) {
                    wsReconnectTimerRef.current = setTimeout(connectSocket, 700);
                }
            };

            socket.onerror = () => {
                setIsWsConnected(false);
            };

            socket.onmessage = (event) => {
                try {
                    const payload = JSON.parse(event.data);
                    if (payload.type === 'code_update' && payload.filename) {
                        if (payload.source_client_id && payload.source_client_id === clientIdRef.current) {
                            return;
                        }

                        const payloadVersion = Number(payload.version || 0);
                        if (payloadVersion && payloadVersion <= lastAppliedRemoteVersionRef.current) {
                            return;
                        }

                        if (Date.now() - lastLocalEditAtRef.current < 60) {
                            return;
                        }

                        const activeFile = currentFileRef.current;
                        if (!activeFile) {
                            return;
                        }
                        if (activeFile.filename === payload.filename && payload.content !== activeFile.content) {
                            applyingRemoteRef.current = true;
                            setCurrentFile({
                                ...activeFile,
                                content: payload.content ?? '',
                                version: payloadVersion || activeFile.version,
                            });
                            if (payloadVersion) {
                                lastAppliedRemoteVersionRef.current = payloadVersion;
                            }
                            setTimeout(() => {
                                applyingRemoteRef.current = false;
                            }, 0);
                        }
                    }
                } catch (err) {
                    console.error('WS parse error:', err);
                }
            };
        };

        connectSocket();

        return () => {
            wsManualCloseRef.current = true;
            setIsWsConnected(false);
            if (wsBroadcastTimerRef.current) {
                clearTimeout(wsBroadcastTimerRef.current);
            }
            if (wsSendTimerRef.current) {
                clearTimeout(wsSendTimerRef.current);
                wsSendTimerRef.current = null;
            }
            if (wsReconnectTimerRef.current) {
                clearTimeout(wsReconnectTimerRef.current);
                wsReconnectTimerRef.current = null;
            }
            if (wsRef.current) {
                wsRef.current.close();
            }
            wsRef.current = null;
        };
    }, [operatorId, wsBase]);

    // Heartbeat loop
    useEffect(() => {
        if (!operatorId || !apiBase) return;
        const interval = setInterval(() => {
            fetch(`${apiBase}/operators/${operatorId}/heartbeat/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: activityStatus, message: activityMessage }),
            }).catch(() => {
                // Ignore heartbeat network errors; fallback loops will retry.
            });
        }, 10000);
        return () => clearInterval(interval);
    }, [apiBase, operatorId, activityStatus, activityMessage]);

    useEffect(() => {
        if (!operatorId || !currentFile || isWsConnected) {
            return;
        }

        const pollCurrentFile = async () => {
            try {
                if (Date.now() < fallbackPollBackoffUntilRef.current) {
                    return;
                }

                if (Date.now() - lastLocalEditAtRef.current < 600) {
                    return;
                }

                if (Date.now() - lastRemoteSyncAtRef.current < 1000) {
                    return;
                }
                lastRemoteSyncAtRef.current = Date.now();

                const res = await fetch(`${apiBase}/operators/${operatorId}/get_files/`);
                const data = await parseJsonResponse(res);
                const filesList: OperatorFile[] = data.results || data || [];

                const latestCurrentFile = filesList.find((f) => f.id === currentFileRef.current?.id);
                if (!latestCurrentFile || !currentFileRef.current) {
                    setFiles(filesList);
                    return;
                }

                setFiles(filesList);

                if (latestCurrentFile.version <= Math.max(lastAppliedRemoteVersionRef.current, currentFileRef.current.version || 0)) {
                    return;
                }

                if (latestCurrentFile.content !== currentFileRef.current.content) {
                    applyingRemoteRef.current = true;
                    setCurrentFile(latestCurrentFile);
                    lastAppliedRemoteVersionRef.current = latestCurrentFile.version || lastAppliedRemoteVersionRef.current;
                    setTimeout(() => {
                        applyingRemoteRef.current = false;
                    }, 0);
                }
            } catch (err) {
                fallbackPollBackoffUntilRef.current = Date.now() + 5000;
            }
        };

        const interval = setInterval(pollCurrentFile, 1000);
        return () => clearInterval(interval);
    }, [apiBase, currentFile, isWsConnected, operatorId]);

    useEffect(() => {
        if (!terminalRef.current || xtermRef.current) {
            return;
        }

        const term = new Terminal({
            cursorBlink: false,
            theme: {
                background: '#0b1320',
                foreground: '#c8d6e5',
                red: '#ff6b6b',
                green: '#1dd1a1',
                yellow: '#feca57',
            },
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: 12,
            rows: 18,
            disableStdin: true,
            convertEol: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(terminalRef.current);
        fitAddon.fit();
        term.writeln('EduSync Terminal Ready');

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        const handleResize = () => fitAddon.fit();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!xtermRef.current) {
            return;
        }

        const term = xtermRef.current;
        term.clear();
        const lines = output.split('\n');
        lines.forEach((line) => term.writeln(line));
        fitAddonRef.current?.fit();
    }, [output]);

    useEffect(() => {
        return () => {
            if (localBackupTimerRef.current) {
                clearTimeout(localBackupTimerRef.current);
                localBackupTimerRef.current = null;
            }
        };
    }, []);

    if (!sessionId || !operatorId) {
        return (
            <div className={styles.container}>
                <div className={styles.error}>
                    <p>Invalid session or operator ID</p>
                </div>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <h2>📝 Operator Editor</h2>
                <div className={styles.sessionInfo}>
                    <span title={sessionId}>Session: {sessionId.substring(0, 12)}...</span>
                    <span title={operatorId}>Operator: {operatorId.substring(0, 12)}...</span>
                </div>
            </div>

            <div className={styles.sessionActions}>
                <button className={styles.runBtn} onClick={saveCurrentFile}>Save File</button>
                {sessionInfo?.allow_operator_download && (
                    <button
                        className={styles.runBtn}
                        onClick={() => {
                            const localFiles = currentFile
                                ? files.map((file) => (file.id === currentFile.id ? { ...file, content: currentFile.content } : file))
                                : files;
                            const localOk = saveLocalBackupWithNotice(localFiles, 'Saved locally');
                            const downloadOk = exportFilesToComputer(localFiles);
                            if (!downloadOk && localOk) {
                                setLocalSaveNotice('Saved locally. Download failed');
                                setTimeout(() => setLocalSaveNotice(''), 1800);
                            } else if (downloadOk) {
                                setLocalSaveNotice('Saved locally + downloaded backup file');
                                setTimeout(() => setLocalSaveNotice(''), 1800);
                            }
                        }}
                    >
                        Save to Computer
                    </button>
                )}
                <button className={styles.exitBtn} onClick={exitSession}>Exit Session</button>
            </div>
            {localSaveNotice ? <div className={styles.localNotice}>{localSaveNotice}</div> : null}
            <div className={styles.pathHint}>
                Downloaded files are in your browser Downloads folder. Check: {downloadsPathHint}
            </div>

            {maximizedPdf ? (
                <div className={styles.pdfModalOverlay} role="dialog" aria-modal="true" aria-label="Maximized PDF view">
                    <div className={styles.pdfModalCard}>
                        <div className={styles.pdfModalHeader}>
                            <strong>{maximizedPdf.title}</strong>
                            <button className={styles.exitBtn} onClick={() => setMaximizedPdf(null)}>Close</button>
                        </div>
                        <div className={styles.pdfModalContent}>
                            <PdfWhiteboard
                                isAdmin={false}
                                pdfUrl={maximizedPdf.url}
                                pdfTitle={maximizedPdf.title}
                                currentPage={pdfCurrentPages[maximizedPdf.fileId] || 1}
                                initialWhiteboardData={pdfWhiteboardData[maximizedPdf.fileId] || {}}
                                onClose={() => setMaximizedPdf(null)}
                                showMaximizeButton={false}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {sessionInfo?.leaderboard_visible && analyticsReport?.top_10?.length ? (
                <div className={styles.leaderboardPanel}>
                    <div className={styles.panelHeader}>
                        <h3>Weekly Top Operators</h3>
                        <span>{analyticsReport.weekly_activity_total} activity events</span>
                    </div>
                    <div className={styles.leaderboardList}>
                        {analyticsReport.top_10.map((operator, index) => (
                            <div key={operator.operator_id} className={styles.leaderboardCard}>
                                <strong>#{index + 1} {operator.name}</strong>
                                <span>Score {operator.score}</span>
                                <span>Accuracy {operator.accuracy}%</span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}

            <div className={styles.editor}>
                {/* Sidebar - Files */}
                <div className={styles.sidebar}>
                    <h3>Files</h3>
                    {files.length === 0 ? (
                        <p className={styles.noFiles}>No files yet</p>
                    ) : (
                        <div className={styles.filesList}>
                            {renderTree(fileTree)}
                        </div>
                    )}

                    {!showNewFile ? (
                        <button
                            onClick={() => setShowNewFile(true)}
                            className={styles.newFileBtn}
                        >
                            + New File
                        </button>
                    ) : (
                        <div className={styles.newFileInput}>
                            <input
                                type="text"
                                placeholder="filename.py or src/utils/main.py"
                                value={newFileName}
                                onChange={(e) => setNewFileName(e.target.value)}
                                autoFocus
                            />
                            <button onClick={handleCreateFile}>Create</button>
                            <button onClick={() => setShowNewFile(false)}>Cancel</button>
                        </div>
                    )}
                </div>

                {/* Editor */}
                <div className={styles.editorPanel}>
                    {currentFile ? (
                        <>
                            <div className={styles.editorHeader}>
                                <span className={styles.folderItem}>{currentFile.filename}</span>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                    <button
                                        className={styles.runBtn}
                                        style={{ background: 'transparent', border: '1px solid #42a5f5', color: '#42a5f5' }}
                                        onClick={() => setUseBasicEditor(!useBasicEditor)}
                                    >
                                        {useBasicEditor ? 'Use Advanced Editor' : 'Use Basic Editor'}
                                    </button>
                                    <button
                                        onClick={handleExecuteCode}
                                        disabled={executing}
                                        className={styles.runBtn}
                                    >
                                        {executing ? '⏳ Running...' : '▶ Run Code'}
                                    </button>
                                    <button className={styles.runBtn} onClick={saveCurrentFile}>Save</button>
                                </div>
                            </div>
                            <div className={styles.messageInput}>
                                <input
                                    type="text"
                                    placeholder="Terminal command (example: pip install requests)"
                                    value={terminalCommand}
                                    onChange={(e) => setTerminalCommand(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            handleRunTerminalCommand();
                                        }
                                    }}
                                />
                                <button onClick={handleRunTerminalCommand}>Run Terminal</button>
                            </div>
                            <div className={styles.editorSurface}>
                                {useBasicEditor ? (
                                    <textarea
                                        className={styles.mobileEditor}
                                        style={{ display: 'block' }}
                                        value={currentFile.content}
                                        onChange={(e) => handleEditorChange(e.target.value)}
                                        spellCheck={false}
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                        autoComplete="off"
                                    />
                                ) : (
                                    <>
                                        <div className={styles.editorFallback} style={{ display: isEditorReady ? 'none' : 'flex' }}>
                                            Loading editor...
                                        </div>
                                        <div className={styles.editorDesktop}>
                                            <MonacoEditor
                                                height="100%"
                                                language="python"
                                                theme="vs-dark"
                                                value={currentFile.content}
                                                onChange={handleEditorChange}
                                                onMount={() => setIsEditorReady(true)}
                                                loading="Loading editor..."
                                                options={{
                                                    minimap: { enabled: false },
                                                    fontSize: 14,
                                                    lineNumbers: 'on',
                                                    automaticLayout: true,
                                                    scrollBeyondLastLine: false,
                                                }}
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                            {broadcastFiles.some((file) => file.is_active) && (
                                <div className={styles.broadcastPanel}>
                                    <div className={styles.panelHeader}>
                                        <h4>Live Admin Broadcast</h4>
                                        <span>{sessionInfo?.admin_name || 'Admin'}</span>
                                    </div>
                                    {broadcastFiles.filter((file) => file.is_active).map((file) => (
                                        <div key={file.id} className={styles.broadcastCard}>
                                            <strong>{file.filename}</strong>
                                            <p>{file.description || file.file_type}</p>
                                            {renderBroadcastPreview(file)}
                                        </div>
                                    ))}
                                </div>
                            )}
                            {whiteboardData && (
                                <div className={styles.broadcastPanel}>
                                    <div className={styles.panelHeader}>
                                        <h4>Live Admin Whiteboard</h4>
                                        <span>Live drawing stream</span>
                                    </div>
                                    <div style={{ padding: '16px' }}>
                                        <Whiteboard
                                            isAdmin={false}
                                            initialData={whiteboardData}
                                        />
                                    </div>
                                </div>
                            )}
                            {adminBroadcastCode && (
                                <div className={styles.broadcastPanel}>
                                    <div className={styles.panelHeader}>
                                        <h4>Admin Broadcast Code</h4>
                                        <span>Live admin editor stream</span>
                                    </div>
                                    <pre className={styles.codePreview}>{adminBroadcastCode}</pre>
                                </div>
                            )}

                            <OperatorTests
                                apiBase={apiBase}
                                sessionId={sessionId}
                                operatorId={operatorId}
                            />
                        </>
                    ) : (
                        <div className={styles.noEditor}>
                            <p>No file selected. Create a new file to start coding.</p>
                        </div>
                    )}
                </div>

                {/* Output */}
                <div className={styles.output}>
                    <h4>Output</h4>
                    <div ref={terminalRef} className={styles.xtermContainer} />
                </div>

                {/* Chat */}
                <div className={styles.chat}>
                    <h4>Chat with Admin</h4>
                    <div className={styles.messagesList}>
                        {messages.map((msg) => (
                            <div
                                key={msg.id}
                                className={`${styles.message} ${msg.sender === 'operator' ? styles.operator : styles.admin
                                    }`}
                            >
                                <strong>{msg.sender}:</strong>
                                <p>{msg.content}</p>
                                <small>{new Date(msg.created_at).toLocaleTimeString()}</small>
                            </div>
                        ))}
                    </div>
                    <div className={styles.messageInput}>
                        <input
                            type="text"
                            placeholder="Type message..."
                            value={newMessage}
                            onChange={(e) => setNewMessage(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                        />
                        <button onClick={handleSendMessage}>Send</button>
                    </div>
                </div>
            </div>
        </div>
    );
}