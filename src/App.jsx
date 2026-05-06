import { useEffect, useMemo, useState } from 'react';

const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const splitWords = (value) => normalizeText(value).split(' ').filter(Boolean);

const normalizeWord = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

const comparableWords = (value) => splitWords(value).map(normalizeWord).filter(Boolean);

const wordOverlap = (left, right) => {
    const maxLength = Math.min(left.length, right.length);

    for (let size = maxLength; size > 0; size -= 1) {
        let matches = true;

        for (let index = 0; index < size; index += 1) {
            if (left[left.length - size + index] !== right[index]) {
                matches = false;
                break;
            }
        }

        if (matches) {
            return size;
        }
    }

    return 0;
};

const appendChunk = (baseText, nextText) => {
    const base = normalizeText(baseText);
    const next = normalizeText(nextText);

    if (!base) {
        return next;
    }

    if (!next) {
        return base;
    }

    const baseWords = splitWords(base);
    const nextWords = splitWords(next);
    const baseComparable = comparableWords(base).join(' ');
    const nextComparable = comparableWords(next).join(' ');

    if (!baseComparable) {
        return next;
    }

    if (!nextComparable) {
        return base;
    }

    if (baseComparable === nextComparable) {
        return base;
    }

    if (baseComparable.includes(nextComparable) && nextWords.length >= 3) {
        return base;
    }

    if (nextComparable.includes(baseComparable) && baseWords.length >= 3) {
        return next;
    }

    const overlap = wordOverlap(comparableWords(base), comparableWords(next));
    if (overlap > 0) {
        return `${baseWords.join(' ')} ${nextWords.slice(overlap).join(' ')}`.trim();
    }

    return `${base} ${next}`;
};

const stripCommittedPrefix = (committedText, candidateText) => {
    const committed = normalizeText(committedText);
    const candidate = normalizeText(candidateText);

    if (!candidate) {
        return '';
    }

    if (!committed) {
        return candidate;
    }

    const committedWords = splitWords(committed);
    const candidateWords = splitWords(candidate);
    const committedComparable = comparableWords(committed);
    const candidateComparable = comparableWords(candidate);

    let sharedPrefix = 0;
    const maxPrefix = Math.min(committedComparable.length, candidateComparable.length);
    while (sharedPrefix < maxPrefix && committedComparable[sharedPrefix] === candidateComparable[sharedPrefix]) {
        sharedPrefix += 1;
    }

    if (sharedPrefix > 0) {
        return candidateWords.slice(sharedPrefix).join(' ');
    }

    const overlap = wordOverlap(committedComparable, candidateComparable);
    if (overlap > 0) {
        return candidateWords.slice(overlap).join(' ');
    }

    return candidate;
};

const isSameChunk = (leftText, rightText) => {
    const left = normalizeText(leftText);
    const right = normalizeText(rightText);

    if (!left || !right) {
        return false;
    }

    const leftComparable = comparableWords(left).join(' ');
    const rightComparable = comparableWords(right).join(' ');

    return leftComparable.startsWith(rightComparable) || rightComparable.startsWith(leftComparable) || wordOverlap(comparableWords(left), comparableWords(right)) > 0;
};

const api = async (path, options = {}) => {
    const response = await fetch(path, {
        headers: {
            'Content-Type': 'application/json'
        },
        ...options
    });

    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? 'Request failed');
    }

    return response.json();
};

export default function App() {
    const [state, setState] = useState({
        revision: 0,
        status: 'idle',
        events: [],
        error: null,
        resetCounter: 0
    });
    const [requestError, setRequestError] = useState('');
    const [connected, setConnected] = useState(false);
    const [frozenTranscriptView, setFrozenTranscriptView] = useState(null);
    const [isStopping, setIsStopping] = useState(false);

    const applyState = (nextState) => {
        setState((currentState) => {
            if ((nextState.revision ?? 0) < (currentState.revision ?? 0)) {
                return currentState;
            }

            return nextState;
        });
    };

    useEffect(() => {
        let mounted = true;

        api('/api/transcript/state')
            .then((payload) => {
                if (mounted) {
                    applyState(payload);
                }
            })
            .catch((error) => {
                if (mounted) {
                    setRequestError(error.message);
                }
            });

        const events = new EventSource('/api/transcript/events');

        events.addEventListener('open', () => {
            if (mounted) {
                setConnected(true);
            }
        });

        events.addEventListener('state', (event) => {
            if (mounted) {
                applyState(JSON.parse(event.data));
                setRequestError('');
            }
        });

        events.addEventListener('error', () => {
            if (mounted) {
                setConnected(false);
            }
        });

        return () => {
            mounted = false;
            events.close();
        };
    }, []);

    const transcriptView = useMemo(() => {
        let committedFlow = '';
        let draft = '';
        let lastTimestamp = null;
        let finalCount = 0;

        for (const event of state.events) {
            const text = normalizeText(event.text);
            if (!text) {
                continue;
            }

            lastTimestamp = event.timestamp;

            if (event.isFinal) {
                committedFlow = appendChunk(appendChunk(committedFlow, draft), text);
                draft = '';
                finalCount += 1;
            } else {
                const nextDraft = stripCommittedPrefix(committedFlow, text);

                if (!draft) {
                    draft = nextDraft;
                } else if (isSameChunk(draft, nextDraft)) {
                    draft = appendChunk(draft, nextDraft);
                } else {
                    committedFlow = appendChunk(committedFlow, draft);
                    draft = nextDraft;
                }
            }
        }

        const flow = appendChunk(committedFlow, draft);
        const committedDisplay = draft ? flow.slice(0, Math.max(0, flow.length - draft.length)).trimEnd() : flow;

        return {
            committedDisplay,
            count: finalCount,
            draft,
            flow,
            lastTimestamp
        };
    }, [state.events]);

    const visibleTranscriptView = frozenTranscriptView ?? transcriptView;

    const runAction = async (path) => {
        try {
            setRequestError('');

            if (path === '/api/transcript/start') {
                setFrozenTranscriptView(null);
                setIsStopping(false);
            }

            if (path === '/api/transcript/reset') {
                setFrozenTranscriptView(null);
                setIsStopping(false);
            }

            if (path === '/api/transcript/stop') {
                setFrozenTranscriptView(transcriptView);
                setIsStopping(true);
            }

            const payload = await api(path, { method: 'POST' });
            applyState(payload);

            if (path === '/api/transcript/stop') {
                setIsStopping(false);
            }
        } catch (error) {
            if (path === '/api/transcript/stop') {
                setFrozenTranscriptView(null);
                setIsStopping(false);
            }

            setRequestError(error.message);
        }
    };

    return (
        <main className="shell">
            <section className="hero">
                <p className="eyebrow">Foundry Local</p>
                <h1>Live Transcript Stream</h1>
                <p className="lede">
                    The backend owns microphone capture and streams transcript updates to this page over server-sent events.
                </p>
            </section>

            <section className="panel status-panel">
                <div>
                    <p className="label">Backend</p>
                    <strong>{connected ? 'Connected' : 'Reconnecting'}</strong>
                </div>
                <div>
                    <p className="label">Session</p>
                    <strong className={`status status-${state.status}`}>{state.status}</strong>
                </div>
                <div>
                    <p className="label">Final Segments</p>
                    <strong>{visibleTranscriptView.count}</strong>
                </div>
            </section>

            <section className="panel controls">
                <button type="button" onClick={() => runAction('/api/transcript/start')} disabled={state.status === 'running'}>
                    Start
                </button>
                <button type="button" onClick={() => runAction('/api/transcript/stop')} disabled={state.status !== 'running' || isStopping}>
                    {isStopping ? 'Stopping...' : 'Stop'}
                </button>
                <button type="button" className="ghost" onClick={() => runAction('/api/transcript/reset')}>
                    Clear
                </button>
            </section>

            {(state.error || requestError) && (
                <section className="panel error-panel">
                    <p className="label">Error</p>
                    <strong>{requestError || state.error}</strong>
                </section>
            )}

            <section className="panel transcript-panel">
                <div className="transcript-header">
                    <div>
                        <p className="label">Transcript</p>
                        <strong>Appended live flow</strong>
                    </div>
                </div>

                <div className="transcript-flow">
                    {visibleTranscriptView.flow ? (
                        <p>
                            {visibleTranscriptView.committedDisplay}
                            {visibleTranscriptView.draft && (
                                <span className="transcript-draft">
                                    {visibleTranscriptView.committedDisplay ? ' ' : ''}
                                    {visibleTranscriptView.draft}
                                </span>
                            )}
                        </p>
                    ) : (
                        <p className="empty">Transcript text will accumulate here as you speak.</p>
                    )}
                </div>

                {visibleTranscriptView.lastTimestamp && (
                    <div className="transcript-meta">
                        <time>
                            Last update {new Date(visibleTranscriptView.lastTimestamp).toLocaleTimeString()}
                        </time>
                    </div>
                )}
            </section>
        </main>
    );
}