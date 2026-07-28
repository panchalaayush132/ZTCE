import type { Metadata } from 'next';
import './globals.css';
import '@excalidraw/excalidraw/index.css';

export const metadata: Metadata = {
    title: 'ZTCE — Zero-Trust Collaborative Execution Engine',
    description: 'Enterprise-grade air-gapped collaborative development platform with zero-trust AI assistance',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <head>
                <meta charSet="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            </head>
            <body>{children}</body>
        </html>
    );
}
