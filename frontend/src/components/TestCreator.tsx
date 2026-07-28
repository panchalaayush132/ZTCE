import React, { useState } from 'react';

interface Props {
    apiBase: string;
    authHeaders: Record<string, string>;
    sessionId: string;
    operatorId?: string;
    model: string;
}
        
export default function TestCreator({ apiBase, authHeaders, sessionId, operatorId, model }: Props) {
    const [topic, setTopic] = useState('');
    const [mcqCount, setMcqCount] = useState(3);
    const [tfCount, setTfCount] = useState(2);
    const [practicalCount, setPracticalCount] = useState(1);
    const [difficulty, setDifficulty] = useState('medium');
    const [generating, setGenerating] = useState(false);
    const [testJson, setTestJson] = useState<any | null>(null);
    const [gradingResult, setGradingResult] = useState<any | null>(null);
    const [savedTestId, setSavedTestId] = useState<string | null>(null);
    const [answers, setAnswers] = useState<Record<string, any>>({});

    const parseJsonResponse = async (res: Response) => {
        let data: any = null;
        try {
            data = await res.json();
        } catch (e) {
            data = { error: 'Invalid JSON response' };
        }
        return data;
    };

    const generateTest = async () => {
        if (!sessionId || !topic.trim()) return alert('Provide session and topic');
        setGenerating(true);
        try {
            const res = await fetch(`${apiBase}/suggestions/generate_test/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({
                    session_id: sessionId,
                    topic: topic.trim(),
                    mcq_count: mcqCount,
                    tf_count: tfCount,
                    practical_count: practicalCount,
                    difficulty,
                    model,
                }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                alert(data?.error || 'Generation failed');
            } else {
                setTestJson(data);
                // initialize answers map
                const initialAnswers: Record<string, any> = {};
                (data.questions || []).forEach((q: any) => {
                    initialAnswers[String(q.id)] = '';
                });
                setAnswers(initialAnswers);
                setSavedTestId(null);
                setGradingResult(null);
            }
        } catch (err) {
            alert('Generation failed: ' + (err as Error).message);
        } finally {
            setGenerating(false);
        }
    };

    const saveTestToServer = async () => {
        if (!sessionId || !testJson) return alert('No test to save');
        try {
            const res = await fetch(`${apiBase}/tests/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ session_id: sessionId, title: testJson.title || topic, content: testJson }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                alert(data?.error || 'Save failed');
            } else {
                setSavedTestId(data.id || null);
                alert('Test saved');
            }
        } catch (err) {
            alert('Save failed: ' + (err as Error).message);
        }
    };

    const submitAnswers = async (useSavedTest = true) => {
        if (!sessionId || !testJson) return alert('No test to submit');
        const test_id = useSavedTest && savedTestId ? savedTestId : (testJson.id || null);
        if (!test_id) return alert('No test id. Save the test first or use generated test that includes id');
        if (!operatorId) return alert('operatorId not provided');

        try {
            const res = await fetch(`${apiBase}/tests/submit/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders },
                body: JSON.stringify({ test_id, operator_id: operatorId, answers, model }),
            });
            const data = await parseJsonResponse(res);
            if (!res.ok) {
                alert(data?.error || 'Submit failed');
            } else {
                setGradingResult(data.grade || data);
                alert('Submitted. Grade received');
            }
        } catch (err) {
            alert('Submit failed: ' + (err as Error).message);
        }
    };

    const handleAnswerChange = (qid: string, value: any) => {
        setAnswers((prev) => ({ ...prev, [qid]: value }));
    };

    return (
        <div style={{ border: '1px solid #ddd', padding: 12, marginTop: 12 }}>
            <h4>AI Test Creator</h4>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic (required)" style={{ flex: 1 }} />
                <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
                    <option value="easy">Easy</option>
                    <option value="medium">Medium</option>
                    <option value="hard">Hard</option>
                </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <label>MCQ <input type="number" value={mcqCount} min={0} onChange={(e) => setMcqCount(Number(e.target.value))} style={{ width: 60 }} /></label>
                <label>TF <input type="number" value={tfCount} min={0} onChange={(e) => setTfCount(Number(e.target.value))} style={{ width: 60 }} /></label>
                <label>Practical <input type="number" value={practicalCount} min={0} onChange={(e) => setPracticalCount(Number(e.target.value))} style={{ width: 60 }} /></label>
                <button onClick={generateTest} disabled={generating} style={{ marginLeft: 'auto' }}>{generating ? 'Generating...' : 'Generate'}</button>
            </div>

            {testJson && (
                <div style={{ marginTop: 8 }}>
                    <h5>Generated Test</h5>
                    <div style={{ marginBottom: 8 }}>
                        <strong>Title:</strong> {testJson.title || topic}
                    </div>
                    {(testJson.questions || []).map((q: any) => (
                        <div key={q.id} style={{ border: '1px solid #eee', padding: 8, marginBottom: 6 }}>
                            <div><strong>Q{q.id} ({q.type})</strong></div>
                            <div style={{ marginTop: 6 }}>{q.prompt}</div>
                            {q.type === 'mcq' && Array.isArray(q.choices) && (
                                <select value={answers[String(q.id)] || ''} onChange={(e) => handleAnswerChange(String(q.id), e.target.value)}>
                                    <option value="">-- choose --</option>
                                    {q.choices.map((c: string, idx: number) => (<option key={idx} value={c}>{c}</option>))}
                                </select>
                            )}
                            {['tf', 'truefalse'].includes(q.type) && (
                                <select value={answers[String(q.id)] || ''} onChange={(e) => handleAnswerChange(String(q.id), e.target.value)}>
                                    <option value="">-- choose --</option>
                                    <option value="true">True</option>
                                    <option value="false">False</option>
                                </select>
                            )}
                            {q.type === 'practical' && (
                                <textarea value={answers[String(q.id)] || ''} onChange={(e) => handleAnswerChange(String(q.id), e.target.value)} style={{ width: '100%', minHeight: 80 }} />
                            )}
                        </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button onClick={() => navigator.clipboard.writeText(JSON.stringify(testJson))}>Copy JSON</button>
                        <button onClick={saveTestToServer}>Save Test</button>
                        <button onClick={() => submitAnswers(false)}>Submit Answers (generated test)</button>
                        <button onClick={() => submitAnswers(true)} disabled={!savedTestId}>Submit Answers (saved test)</button>
                        <a href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(testJson))}`} download={`test-${(topic || 'test').replace(/\s+/g, '-')}.json`}>Download JSON</a>
                    </div>
                </div>
            )}

            {gradingResult && (
                <div style={{ marginTop: 8 }}>
                    <h5>Grading Result</h5>
                    <pre style={{ maxHeight: 300, overflow: 'auto', background: '#fafafa', padding: 8 }}>{JSON.stringify(gradingResult, null, 2)}</pre>
                </div>
            )}
        </div>
    );
}
