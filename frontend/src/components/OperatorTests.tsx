'use client';

import React, { useEffect, useMemo, useState } from 'react';

interface TestQuestion {
    id: string | number;
    type: string;
    prompt: string;
    choices?: string[];
    points?: number;
    correct_answer?: string | boolean;
    rubric?: string;
}

interface TestItem {
    id: string;
    title: string;
    created_at?: string;
    content: {
        title?: string;
        questions?: TestQuestion[];
    };
}

interface Props {
    apiBase: string;
    sessionId: string;
    operatorId: string;
}

export default function OperatorTests({ apiBase, sessionId, operatorId }: Props) {
    const [tests, setTests] = useState<TestItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedTestId, setSelectedTestId] = useState('');
    const [answers, setAnswers] = useState<Record<string, any>>({});
    const [submitting, setSubmitting] = useState(false);
    const [result, setResult] = useState<any | null>(null);
    const [error, setError] = useState('');

    const selectedTest = useMemo(
        () => tests.find((test) => test.id === selectedTestId) || null,
        [tests, selectedTestId]
    );

    const parseJson = async (res: Response) => {
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await res.text();
            throw new Error(text.slice(0, 200));
        }
        return res.json();
    };

    const loadTests = async () => {
        if (!sessionId) return;
        setLoading(true);
        setError('');
        try {
            const res = await fetch(`${apiBase}/tests/?session_id=${encodeURIComponent(sessionId)}`);
            const data = await parseJson(res);
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to load tests');
            }
            const list = Array.isArray(data) ? data : data?.results || [];
            setTests(list);
            if (!selectedTestId && list.length > 0) {
                setSelectedTestId(String(list[0].id));
            }
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTests();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, apiBase]);

    useEffect(() => {
        if (!selectedTest) return;
        const initialAnswers: Record<string, any> = {};
        (selectedTest.content.questions || []).forEach((question) => {
            initialAnswers[String(question.id)] = '';
        });
        setAnswers(initialAnswers);
        setResult(null);
    }, [selectedTest]);

    const handleAnswerChange = (questionId: string, value: any) => {
        setAnswers((prev) => ({ ...prev, [questionId]: value }));
    };

    const submitTest = async () => {
        if (!selectedTest) return;
        setSubmitting(true);
        setError('');
        try {
            const res = await fetch(`${apiBase}/tests/submit/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    test_id: selectedTest.id,
                    operator_id: operatorId,
                    answers,
                }),
            });
            const data = await parseJson(res);
            if (!res.ok) {
                throw new Error(data?.error || 'Submission failed');
            }
            setResult(data.grade || data);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div style={{ border: '1px solid #2a3f4f', borderRadius: 8, marginTop: 16, padding: 12, background: '#17232d' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                <div>
                    <h4 style={{ margin: 0 }}>Operator Tests</h4>
                    <div style={{ fontSize: 12, opacity: 0.8 }}>Load, answer, submit, and view your grade.</div>
                </div>
                <button onClick={loadTests} disabled={loading} style={{ padding: '8px 12px' }}>
                    {loading ? 'Loading...' : 'Refresh'}
                </button>
            </div>

            {error ? <div style={{ color: '#ffb4b4', marginBottom: 12 }}>{error}</div> : null}

            <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12 }}>
                <div style={{ border: '1px solid #2a3f4f', borderRadius: 8, padding: 10 }}>
                    <strong>Available Tests</strong>
                    <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                        {tests.length === 0 ? (
                            <div style={{ opacity: 0.7 }}>No tests published for this session yet.</div>
                        ) : tests.map((test) => (
                            <button
                                key={test.id}
                                onClick={() => setSelectedTestId(test.id)}
                                style={{
                                    textAlign: 'left',
                                    padding: 10,
                                    borderRadius: 6,
                                    border: selectedTestId === test.id ? '1px solid #42a5f5' : '1px solid #2a3f4f',
                                    background: selectedTestId === test.id ? '#223447' : '#13212b',
                                    color: '#fff',
                                }}
                            >
                                <div style={{ fontWeight: 700 }}>{test.title}</div>
                                <div style={{ fontSize: 12, opacity: 0.75 }}>{test.created_at ? new Date(test.created_at).toLocaleString() : ''}</div>
                            </button>
                        ))}
                    </div>
                </div>

                <div style={{ border: '1px solid #2a3f4f', borderRadius: 8, padding: 10, background: '#111b24' }}>
                    {selectedTest ? (
                        <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 10, alignItems: 'center' }}>
                                <div>
                                    <h4 style={{ margin: 0 }}>{selectedTest.title}</h4>
                                    <div style={{ fontSize: 12, opacity: 0.8 }}>{selectedTest.content.questions?.length || 0} questions</div>
                                </div>
                                <button onClick={submitTest} disabled={submitting} style={{ padding: '8px 12px' }}>
                                    {submitting ? 'Submitting...' : 'Submit Test'}
                                </button>
                            </div>

                            <div style={{ display: 'grid', gap: 10 }}>
                                {(selectedTest.content.questions || []).map((question) => (
                                    <div key={String(question.id)} style={{ border: '1px solid #243646', borderRadius: 8, padding: 10 }}>
                                        <div style={{ fontWeight: 700, marginBottom: 6 }}>
                                            Q{question.id} ({question.type})
                                            {typeof question.points === 'number' ? ` - ${question.points} pts` : ''}
                                        </div>
                                        <div style={{ marginBottom: 8 }}>{question.prompt}</div>

                                        {question.type === 'mcq' && Array.isArray(question.choices) && (
                                            <select
                                                value={answers[String(question.id)] || ''}
                                                onChange={(e) => handleAnswerChange(String(question.id), e.target.value)}
                                                style={{ width: '100%', padding: 8, borderRadius: 6 }}
                                            >
                                                <option value="">-- choose --</option>
                                                {question.choices.map((choice, index) => (
                                                    <option key={index} value={choice}>{choice}</option>
                                                ))}
                                            </select>
                                        )}

                                        {['tf', 'truefalse'].includes(question.type) && (
                                            <select
                                                value={answers[String(question.id)] || ''}
                                                onChange={(e) => handleAnswerChange(String(question.id), e.target.value)}
                                                style={{ width: '100%', padding: 8, borderRadius: 6 }}
                                            >
                                                <option value="">-- choose --</option>
                                                <option value="true">True</option>
                                                <option value="false">False</option>
                                            </select>
                                        )}

                                        {question.type === 'practical' && (
                                            <textarea
                                                value={answers[String(question.id)] || ''}
                                                onChange={(e) => handleAnswerChange(String(question.id), e.target.value)}
                                                placeholder="Write your answer here"
                                                style={{ width: '100%', minHeight: 100, padding: 8, borderRadius: 6 }}
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>

                            {result && (
                                <div style={{ marginTop: 12, border: '1px solid #2f4f3a', background: '#10231a', borderRadius: 8, padding: 10 }}>
                                    <h4 style={{ marginTop: 0 }}>Result</h4>
                                    <div style={{ marginBottom: 6 }}>
                                        Score: {result.earned ?? result.score ?? 0} / {result.total_points ?? result.points ?? 0}
                                    </div>
                                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(result, null, 2)}</pre>
                                </div>
                            )}
                        </>
                    ) : (
                        <div style={{ opacity: 0.75 }}>Select a test from the left to begin.</div>
                    )}
                </div>
            </div>
        </div>
    );
}
