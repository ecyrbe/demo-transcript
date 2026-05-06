import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FoundryLocalManager } from 'foundry-local-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT ?? 3001);
const modelAlias = 'nemotron-speech-streaming-en-0.6b';

const app = express();

app.use(express.json());

const state = {
    revision: 0,
    status: 'idle',
    events: [],
    error: null,
    resetCounter: 0
};

const clients = new Set();

let manager;
let model;
let session;
let audioInput;
let readPromise;
let startPromise;
let transcriptId = 0;

const broadcast = (event, payload) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
        client.write(message);
    }
};

const emitState = () => {
    state.revision += 1;
    broadcast('state', state);
};

const updateState = (patch) => {
    Object.assign(state, patch);
    emitState();
};

const pushTranscript = (entry) => {
    state.events = [...state.events, entry];
    emitState();
};

const ensureModelLoaded = async () => {
    if (!manager) {
        manager = FoundryLocalManager.create({
            appName: 'foundray_demo_transcript_web',
            logLevel: 'info'
        });
    }

    if (!model) {
        const locatedModel = await manager.catalog.getModel(modelAlias);
        if (!locatedModel) {
            throw new Error(`Model "${modelAlias}" not found in catalog.`);
        }

        updateState({ status: 'downloading', error: null });
        await locatedModel.download(() => {});
        updateState({ status: 'loading' });
        await locatedModel.load();
        model = locatedModel;
    }

    return model;
};

const stopAudioInput = () => {
    if (!audioInput) {
        return;
    }

    try {
        audioInput.quit();
    } catch {
        // Ignore teardown errors during shutdown.
    } finally {
        audioInput = null;
    }
};

const stopTranscription = async () => {
    stopAudioInput();

    if (session) {
        const currentSession = session;
        session = null;

        try {
            await currentSession.stop();
        } catch {
            // Ignore stop errors when session is already ending.
        }
    }

    if (readPromise) {
        try {
            await readPromise;
        } catch {
            // Stream reader errors are already reported through state.
        } finally {
            readPromise = null;
        }
    }

    updateState({ status: 'idle' });
};

const startTranscription = async () => {
    if (state.status === 'running') {
        return state;
    }

    if (startPromise) {
        await startPromise;
        return state;
    }

    startPromise = (async () => {
        updateState({ status: 'initializing', error: null });

        const activeModel = await ensureModelLoaded();
        const audioClient = activeModel.createAudioClient();
        const liveSession = audioClient.createLiveTranscriptionSession();

        liveSession.settings.sampleRate = 16000;
        liveSession.settings.channels = 1;
        liveSession.settings.bitsPerSample = 16;
        liveSession.settings.language = 'en';

        await liveSession.start();
        session = liveSession;

        readPromise = (async () => {
            try {
                for await (const result of liveSession.getStream()) {
                    const text = result.content?.[0]?.text?.trim();
                    if (!text) {
                        continue;
                    }

                    pushTranscript({
                        id: ++transcriptId,
                        text,
                        isFinal: Boolean(result.is_final),
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (error) {
                if (error.name !== 'AbortError') {
                    updateState({
                        status: 'error',
                        error: error.message
                    });
                    broadcast('error', { message: error.message });
                }
            }
        })();

        const { default: portAudio } = await import('naudiodon2');
        const appendQueue = [];
        let pumping = false;

        const pumpAudio = async () => {
            if (pumping || !session) {
                return;
            }

            pumping = true;

            try {
                while (appendQueue.length > 0 && session) {
                    const pcm = appendQueue.shift();
                    await session.append(pcm);
                }
            } finally {
                pumping = false;
                if (appendQueue.length > 0) {
                    void pumpAudio();
                }
            }
        };

        audioInput = portAudio.AudioIO({
            inOptions: {
                channelCount: liveSession.settings.channels,
                sampleFormat: portAudio.SampleFormat16Bit,
                sampleRate: liveSession.settings.sampleRate,
                framesPerBuffer: 3200,
                maxQueue: 64
            }
        });

        audioInput.on('data', (buffer) => {
            const copy = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();

            if (appendQueue.length >= 100) {
                appendQueue.shift();
            }

            appendQueue.push(copy);
            void pumpAudio();
        });

        audioInput.start();
        updateState({ status: 'running', error: null });
    })();

    try {
        await startPromise;
        return state;
    } catch (error) {
        await stopTranscription();
        updateState({ status: 'error', error: error.message });
        throw error;
    } finally {
        startPromise = null;
    }
};

app.get('/api/transcript/state', (_req, res) => {
    res.json(state);
});

app.post('/api/transcript/start', async (_req, res) => {
    try {
        await startTranscription();
        res.json(state);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/transcript/stop', async (_req, res) => {
    await stopTranscription();
    res.json(state);
});

app.post('/api/transcript/reset', (_req, res) => {
    state.events = [];
    state.error = null;
    transcriptId = 0;
    state.resetCounter += 1;
    emitState();
    res.json(state);
});

app.get('/api/transcript/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    clients.add(res);
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

    req.on('close', () => {
        clients.delete(res);
    });
});

if (existsSync(distDir)) {
    app.use(express.static(distDir));

    app.get(/^(?!\/api).*/, (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
    });
}

const server = app.listen(port, () => {
    console.log(`Transcript server listening on http://localhost:${port}`);
});

const shutdown = async () => {
    await stopTranscription();

    if (model) {
        try {
            await model.unload();
        } catch {
            // Ignore unload errors during shutdown.
        }
    }

    server.close(() => {
        process.exit(0);
    });
};

process.on('SIGINT', () => {
    void shutdown();
});

process.on('SIGTERM', () => {
    void shutdown();
});