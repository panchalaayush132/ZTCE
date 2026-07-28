'use client';

import React, { useEffect, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';

const Excalidraw = dynamic(
    () => import('@excalidraw/excalidraw').then((mod) => mod.Excalidraw),
    { ssr: false }
);

interface WhiteboardProps {
    isAdmin: boolean;
    initialData?: any;
    onUpdate?: (elements: any, appState: any) => void;
}

export default function Whiteboard({ isAdmin, initialData, onUpdate }: WhiteboardProps) {
    const excalidrawAPIRef = useRef<any>(null);
    const lastUpdateSentRef = useRef<number>(0);

    const onChange = (elements: readonly any[], appState: any) => {
        if (!isAdmin || !onUpdate) return;

        const now = Date.now();
        // Throttle updates to ~10 per second
        if (now - lastUpdateSentRef.current > 100) {
            onUpdate(elements, appState);
            lastUpdateSentRef.current = now;
        }
    };

    useEffect(() => {
        const excalidrawAPI = excalidrawAPIRef.current;
        if (!isAdmin && excalidrawAPI && initialData) {
            const sceneData: any = {
                elements: initialData.elements || []
            };
            // Ensure appState has collaborators as a Map
            if (initialData.appState) {
                sceneData.appState = {
                    ...initialData.appState,
                    collaborators: initialData.appState.collaborators instanceof Map
                        ? initialData.appState.collaborators
                        : new Map()
                };
            }
            excalidrawAPI.updateScene(sceneData);
        }
    }, [initialData, isAdmin]);

    // Preprocess initialData to ensure collaborators is always a Map
    const processedInitialData = useMemo(() => {
        if (initialData && initialData.appState) {
            return {
                ...initialData,
                appState: {
                    ...initialData.appState,
                    collaborators: initialData.appState.collaborators instanceof Map
                        ? initialData.appState.collaborators
                        : new Map(),
                },
            };
        }
        return {
            elements: [],
            appState: {
                collaborators: new Map(),
            },
        };
    }, [initialData]);

    const handleExcalidrawAPI = (api: any) => {
        if (api && excalidrawAPIRef.current !== api) {
            excalidrawAPIRef.current = api;
        }
    };

    return (
        <div style={{ height: '500px', width: '100%', border: '1px solid #2a3f4f', borderRadius: '8px' }}>
            <Excalidraw
                excalidrawAPI={handleExcalidrawAPI}
                onChange={onChange}
                viewModeEnabled={!isAdmin}
                zenModeEnabled={!isAdmin}
                initialData={processedInitialData}
                theme="dark"
            />
        </div>
    );
}
