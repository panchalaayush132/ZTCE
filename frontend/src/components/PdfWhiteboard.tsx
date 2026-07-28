'use client';

import React, { useEffect, useState, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Initialize PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const Excalidraw = dynamic(
    () => import('@excalidraw/excalidraw').then((mod) => mod.Excalidraw),
    { ssr: false }
);

interface PdfWhiteboardProps {
    isAdmin: boolean;
    pdfUrl: string;
    pdfTitle?: string;
    currentPage?: number;
    initialWhiteboardData?: Record<number, { elements: any; appState: any }>;
    onPageChange?: (page: number) => void;
    onWhiteboardUpdate?: (page: number, elements: any, appState: any) => void;
    onClose?: () => void;
    showMaximizeButton?: boolean;
    allowWheelPageSwitch?: boolean;
}

export default function PdfWhiteboard({
    isAdmin,
    pdfUrl,
    pdfTitle,
    currentPage: externalCurrentPage,
    initialWhiteboardData,
    onPageChange,
    onWhiteboardUpdate,
    onClose,
    showMaximizeButton = true,
    allowWheelPageSwitch = false,
}: PdfWhiteboardProps) {
    const [numPages, setNumPages] = useState<number | null>(null);
    const [internalPage, setInternalPage] = useState<number>(1);
    const [pdfError, setPdfError] = useState('');
    const [isMaximized, setIsMaximized] = useState(false);

    const pageNumber = isAdmin ? internalPage : (externalCurrentPage || internalPage);

    // Store whiteboard data per page
    const [whiteboardCache, setWhiteboardCache] = useState<Record<number, { elements: any; appState: any }>>(
        initialWhiteboardData || {}
    );
    const excalidrawAPIRef = useRef<any>(null);
    const lastUpdateSentRef = useRef<number>(0);
    const lastWheelPageTurnRef = useRef<number>(0);
    const [loadedPage, setLoadedPage] = useState<number>(0);

    const operatorUIOptions = useMemo(
        () => ({
            canvasActions: {
                clearCanvas: false,
                export: false as const,
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
                changeViewBackgroundColor: false,
            },
        }),
        []
    );

    const excalidrawInitialData = useMemo(
        () => ({
            elements: [],
            appState: {
                viewBackgroundColor: 'transparent',
                viewModeEnabled: !isAdmin,
                zenModeEnabled: !isAdmin,
                collaborators: new Map(),
            },
        }),
        [isAdmin]
    );

    const handleExcalidrawAPI = (api: any) => {
        if (api && excalidrawAPIRef.current !== api) {
            excalidrawAPIRef.current = api;
        }
    };

    // When operator receives new initialWhiteboardData, update cache
    useEffect(() => {
        if (!isAdmin && initialWhiteboardData) {
            setWhiteboardCache(initialWhiteboardData);
        }
    }, [initialWhiteboardData, isAdmin]);

    useEffect(() => {
        setPdfError('');
        setNumPages(null);
        setInternalPage(1);
        setLoadedPage(0);
    }, [pdfUrl]);

    // Update Excalidraw when page changes or cache changes (for operator)
    useEffect(() => {
        const excalidrawAPI = excalidrawAPIRef.current;
        if (excalidrawAPI) {
            if (isAdmin) {
                // Admin only loads scene when turning the page
                if (loadedPage !== pageNumber) {
                    const pageData = whiteboardCache[pageNumber];
                    const sceneData: any = {
                        elements: pageData ? pageData.elements : []
                    };
                    // Only include appState if it exists and is valid
                    if (pageData?.appState) {
                        sceneData.appState = {
                            ...pageData.appState,
                            // Ensure collaborators is a Map
                            collaborators: pageData.appState.collaborators instanceof Map
                                ? pageData.appState.collaborators
                                : new Map()
                        };
                    }
                    excalidrawAPI.updateScene(sceneData);
                    setLoadedPage(pageNumber);
                }
            } else {
                // Operator updates scene whenever they receive new data from socket
                const pageData = whiteboardCache[pageNumber];
                const sceneData: any = {
                    elements: pageData ? pageData.elements : []
                };
                // Only include appState if it exists and is valid
                if (pageData?.appState) {
                    sceneData.appState = {
                        ...pageData.appState,
                        // Ensure collaborators is a Map
                        collaborators: pageData.appState.collaborators instanceof Map
                            ? pageData.appState.collaborators
                            : new Map()
                    };
                }
                excalidrawAPI.updateScene(sceneData);
            }
        }
    }, [pageNumber, whiteboardCache, isAdmin, loadedPage]);

    function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
        setPdfError('');
        setNumPages(numPages);
    }

    const changePage = (offset: number) => {
        if (!isAdmin) return; // Operators can't change pages
        const next = internalPage + offset;
        const validNext = Math.min(Math.max(1, next), numPages || 1);
        if (validNext !== internalPage) {
            setInternalPage(validNext);
            if (onPageChange) {
                onPageChange(validNext);
            }
        }
    };

    const previousPage = () => changePage(-1);
    const nextPage = () => changePage(1);

    const onWhiteboardChange = (elements: readonly any[], appState: any) => {
        if (!isAdmin || !onWhiteboardUpdate) return;

        const now = Date.now();
        // Throttle updates
        if (now - lastUpdateSentRef.current > 150) {
            onWhiteboardUpdate(pageNumber, elements, appState);
            lastUpdateSentRef.current = now;

            // Update local cache
            setWhiteboardCache(prev => ({
                ...prev,
                [pageNumber]: { elements, appState }
            }));
        }
    };

    const onPdfWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const isCanvasWheel = target?.tagName === 'CANVAS';

        // Never allow wheel-based panning on tutor canvas (it moves shapes relative to PDF).
        if (isAdmin && isCanvasWheel) {
            event.preventDefault();
            event.stopPropagation();
        }

        if (!allowWheelPageSwitch) {
            return;
        }
        if (!isAdmin || !numPages || numPages <= 1) return;

        // Ignore wheel gestures coming from Excalidraw toolbars/popovers/sliders.
        if (target?.closest(
            '.App-menu_top, .App-menu_bottom, .App-toolbar, .dropdown-menu, .popover, .color-picker, .Modal, .LayerUI, .Island, .mobile-misc-tools-container'
        )) {
            return;
        }

        // Only allow wheel-based page switching from the drawing canvas itself.
        if (!target || target.tagName !== 'CANVAS') {
            return;
        }

        if (Math.abs(event.deltaY) < 24) return;

        const now = Date.now();
        if (now - lastWheelPageTurnRef.current < 280) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        lastWheelPageTurnRef.current = now;

        if (event.deltaY > 0) {
            nextPage();
        } else {
            previousPage();
        }
    };

    const closeSubTools = () => {
        // Excalidraw closes most sub-panels on Escape.
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#1c2b36', padding: '16px', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: '12px', color: '#fff', alignItems: 'center' }}>
                <h4 style={{ margin: 0 }}>
                    {pdfTitle || 'PDF Document'}
                </h4>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <p style={{ margin: 0 }}>
                        Page {pageNumber || (numPages ? 1 : '--')} of {numPages || '--'}
                    </p>

                    {isAdmin && (
                        <div style={{ display: 'flex', gap: '8px' }}>
                            <button
                                onClick={previousPage}
                                disabled={pageNumber <= 1}
                                style={{ padding: '6px 12px', background: '#2a3f4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: pageNumber <= 1 ? 'not-allowed' : 'pointer' }}
                            >
                                Previous
                            </button>
                            <button
                                onClick={nextPage}
                                disabled={pageNumber >= (numPages || 1)}
                                style={{ padding: '6px 12px', background: '#2a3f4f', color: '#fff', border: 'none', borderRadius: '4px', cursor: pageNumber >= (numPages || 1) ? 'not-allowed' : 'pointer' }}
                            >
                                Next
                            </button>
                        </div>
                    )}

                    {onClose && (
                        <button
                            onClick={onClose}
                            style={{
                                padding: '6px 12px',
                                background: '#d32f2f',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                            }}
                        >
                            Close
                        </button>
                    )}

                    {isAdmin && (
                        <button
                            onClick={closeSubTools}
                            style={{
                                padding: '6px 12px',
                                background: '#4f5d75',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                            }}
                        >
                            Close Stroke
                        </button>
                    )}

                    {showMaximizeButton && (
                        <button
                            onClick={() => setIsMaximized(true)}
                            style={{
                                padding: '6px 12px',
                                background: '#3b6ea8',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                            }}
                        >
                            Maximize PDF
                        </button>
                    )}
                </div>
            </div>

            <div
                onWheelCapture={onPdfWheel}
                style={{ position: 'relative', border: '1px solid #2a3f4f', borderRadius: '4px', minHeight: '800px' }}
            >
                <Document
                    file={pdfUrl}
                    onLoadSuccess={onDocumentLoadSuccess}
                    onLoadError={(error) => {
                        setPdfError(error?.message || 'Failed to load PDF');
                    }}
                    loading={<div style={{ padding: '20px', color: '#fff' }}>Loading PDF...</div>}
                >
                    {pdfError ? (
                        <div style={{ padding: '20px', color: '#ffb4b4' }}>{pdfError}</div>
                    ) : (
                        <Page
                            pageNumber={pageNumber}
                            renderTextLayer={true}
                            renderAnnotationLayer={true}
                            width={800}
                        />
                    )}
                </Document>

                {/* Excalidraw Overlay */}
                {numPages && (
                    <div
                        className={isAdmin ? 'pdfOverlayAdmin' : 'pdfOverlayOperator'}
                        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, pointerEvents: isAdmin ? 'auto' : 'none' }}
                    >
                        <Excalidraw
                            key={`excalidraw-pdf-${pdfUrl}-${isAdmin}`}
                            excalidrawAPI={handleExcalidrawAPI}
                            onChange={onWhiteboardChange}
                            viewModeEnabled={!isAdmin}
                            zenModeEnabled={!isAdmin}
                            UIOptions={!isAdmin ? operatorUIOptions : undefined}
                            initialData={excalidrawInitialData}
                            theme="light"
                        />
                    </div>
                )}
            </div>

            {isMaximized && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Maximized PDF"
                    style={{
                        position: 'fixed',
                        inset: 0,
                        zIndex: 9999,
                        background: 'rgba(4, 9, 16, 0.9)',
                        display: 'flex',
                        flexDirection: 'column',
                    }}
                >
                    <div
                        style={{
                            padding: '12px 16px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            background: '#1c2b36',
                            borderBottom: '1px solid #2a3f4f',
                            color: '#fff',
                        }}
                    >
                        <strong>{pdfTitle || 'PDF Document'}</strong>
                        <button
                            onClick={() => setIsMaximized(false)}
                            style={{
                                padding: '6px 10px',
                                background: '#d32f2f',
                                color: '#fff',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                            }}
                        >
                            Close
                        </button>
                    </div>
                    <iframe
                        src={pdfUrl}
                        title={pdfTitle || 'PDF Document'}
                        style={{ flex: 1, width: '100%', border: 'none', background: '#fff' }}
                    />
                </div>
            )}

            {!isAdmin && (
                <style jsx global>{`
                    .pdfOverlayOperator .App-menu_top,
                    .pdfOverlayOperator .App-menu_bottom,
                    .pdfOverlayOperator .MobileMenu {
                        display: none !important;
                    }
                `}</style>
            )}
        </div>
    );
}
