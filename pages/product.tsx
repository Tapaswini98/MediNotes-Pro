"use client"

import { useState, useRef, FormEvent } from 'react';
import { useAuth } from '@clerk/nextjs';
import DatePicker from 'react-datepicker';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { Show, PricingTable, UserButton } from '@clerk/nextjs';

function ConsultationForm() {
    const { getToken } = useAuth();

    // Form state
    const [patientName, setPatientName] = useState('');
    const [visitDate, setVisitDate] = useState<Date | null>(new Date());
    const [notes, setNotes] = useState('');
    const [practiceEmail, setPracticeEmail] = useState('');

    // Streaming state
    const [output, setOutput] = useState('');
    const [loading, setLoading] = useState(false);

    // Voice recording state
    const [isRecording, setIsRecording] = useState(false);
    const [transcribing, setTranscribing] = useState(false);
    const [transcribeError, setTranscribeError] = useState('');
    const [recordingSeconds, setRecordingSeconds] = useState(0);
    const [audioLevels, setAudioLevels] = useState<number[]>(new Array(24).fill(0.08));
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    function watchAudioLevel() {
        const analyser = analyserRef.current;
        if (!analyser) return;

        const data = new Uint8Array(analyser.frequencyBinCount);

        function tick() {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(data);
            // Collapse the frequency bins into a fixed-width bar chart, like a live waveform.
            const bars = 24;
            const chunk = Math.max(1, Math.floor(data.length / bars));
            const next: number[] = [];
            for (let i = 0; i < bars; i++) {
                let sum = 0;
                for (let j = i * chunk; j < i * chunk + chunk && j < data.length; j++) sum += data[j];
                const avg = sum / chunk / 255; // normalize to 0-1
                next.push(Math.min(1, 0.08 + avg * 1.4)); // floor so idle bars stay visible
            }
            setAudioLevels(next);
            animationFrameRef.current = requestAnimationFrame(tick);
        }
        animationFrameRef.current = requestAnimationFrame(tick);
    }

    async function startRecording() {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        audioChunksRef.current = [];

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 128;
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        watchAudioLevel();

        setRecordingSeconds(0);
        timerRef.current = setInterval(() => setRecordingSeconds((s) => s + 1), 1000);

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunksRef.current.push(e.data);
        };

        recorder.onstop = async () => {
            stream.getTracks().forEach((track) => track.stop());
            const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
            await transcribeAudio(audioBlob);
        };

        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
    }

    function stopRecording() {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);

        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
        analyserRef.current = null;
        audioContextRef.current?.close();
        audioContextRef.current = null;
        setAudioLevels(new Array(24).fill(0.08));

        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
    }

    function formatDuration(totalSeconds: number) {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    async function transcribeAudio(audioBlob: Blob) {
        setTranscribing(true);
        setTranscribeError('');
        try {
            const jwt = await getToken();
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');

            const res = await fetch('/api/transcribe', {
                method: 'POST',
                headers: { Authorization: `Bearer ${jwt}` },
                body: formData,
            });

            // Read as text first so a non-JSON or truncated body shows up
            // clearly instead of failing silently inside res.json().
            const raw = await res.text();
            console.log('[transcribe] status:', res.status, 'raw:', raw);

            if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${raw.slice(0, 200)}`);

            let parsed: { text?: string };
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(`Response wasn't valid JSON: ${raw.slice(0, 200)}`);
            }

            if (!parsed.text) {
                throw new Error(`Response had no "text" field: ${raw.slice(0, 200)}`);
            }

            setNotes((prev) => (prev ? `${prev}\n${parsed.text}` : parsed.text!));
        } catch (err) {
            console.error('Transcription error:', err);
            setTranscribeError(err instanceof Error ? err.message : String(err));
        } finally {
            setTranscribing(false);
        }
    }

    async function runConsultation(jwt: string, signal: AbortSignal): Promise<'ok' | 'auth-failed'> {
        let buffer = '';
        let authFailed = false;

        try {
            await fetchEventSource('/api/consultation', {
                signal,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
                body: JSON.stringify({
                    patient_name: patientName,
                    date_of_visit: visitDate?.toISOString().slice(0, 10),
                    notes,
                    practice_email: practiceEmail || null,
                }),
                async onopen(response) {
                    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
                        return;
                    }
                    if (response.status === 403) {
                        authFailed = true;
                    }
                    throw new Error(`Unexpected response: ${response.status}`);
                },
                onmessage(ev) {
                    buffer += ev.data;
                    setOutput(buffer);
                },
                onerror(err) {
                    console.error('SSE error:', err);
                    // Re-throw so fetchEventSource stops retrying instead of
                    // resending the same (now possibly stale) JWT in a loop —
                    // we handle the one retry we want ourselves, with a fresh token.
                    throw err;
                },
            });
        } catch (err) {
            if (!authFailed) {
                console.error('Consultation request failed:', err);
                setOutput('Something went wrong generating the summary. Please try again.');
            }
        }

        return authFailed ? 'auth-failed' : 'ok';
    }

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setOutput('');
        setLoading(true);

        const controller = new AbortController();

        let jwt = await getToken();
        if (!jwt) {
            setOutput('Authentication required');
            setLoading(false);
            return;
        }

        let result = await runConsultation(jwt, controller.signal);

        // A Lambda cold start can take longer than the Clerk session token's
        // short lifespan, so the token can expire between being fetched and
        // reaching the server. On an auth failure, grab a brand-new token
        // and retry exactly once (not an unbounded loop).
        if (result === 'auth-failed') {
            jwt = await getToken({ skipCache: true });
            if (jwt) {
                setOutput('');
                result = await runConsultation(jwt, controller.signal);
            }
        }

        if (result === 'auth-failed') {
            setOutput('Authentication expired. Please try again.');
        }

        setLoading(false);
    }

    return (
        <div className="container mx-auto px-4 py-12 max-w-3xl">
            <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-8">
                Consultation Notes
            </h1>

            <form onSubmit={handleSubmit} className="space-y-6 bg-white dark:bg-gray-800 rounded-xl shadow-lg p-8">
                <div className="space-y-2">
                    <label htmlFor="patient" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Patient Name
                    </label>
                    <input
                        id="patient"
                        type="text"
                        required
                        value={patientName}
                        onChange={(e) => setPatientName(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="Enter patient's full name"
                    />
                </div>

                <div className="space-y-2">
                    <label htmlFor="date" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Date of Visit
                    </label>
                    <DatePicker
                        id="date"
                        selected={visitDate}
                        onChange={(d: Date | null) => setVisitDate(d)}
                        dateFormat="yyyy-MM-dd"
                        placeholderText="Select date"
                        required
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                    />
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <label htmlFor="notes" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Consultation Notes
                        </label>
                        <button
                            type="button"
                            onClick={isRecording ? stopRecording : startRecording}
                            disabled={transcribing}
                            className={`text-sm font-medium py-1.5 px-4 rounded-lg transition-colors ${
                                isRecording
                                    ? 'bg-red-600 hover:bg-red-700 text-white'
                                    : 'bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200'
                            } disabled:opacity-50`}
                        >
                            {isRecording ? '⏹ Stop Recording' : transcribing ? 'Transcribing…' : '🎙 Record Visit'}
                        </button>
                    </div>

                    {isRecording && (
                        <div className="flex items-center gap-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-4 py-3">
                            <span className="relative flex h-2.5 w-2.5 shrink-0">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                            </span>
                            <div className="flex items-end gap-0.5 h-6 flex-1">
                                {audioLevels.map((level, i) => (
                                    <span
                                        key={i}
                                        className="flex-1 min-w-0.5 rounded-full bg-red-500 dark:bg-red-400 transition-[height] duration-75"
                                        style={{ height: `${Math.round(level * 100)}%` }}
                                    />
                                ))}
                            </div>
                            <span className="text-sm font-mono text-red-700 dark:text-red-300 tabular-nums shrink-0">
                                {formatDuration(recordingSeconds)}
                            </span>
                        </div>
                    )}

                    {transcribeError && (
                        <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-4 py-2 break-words">
                            Transcription error: {transcribeError}
                        </div>
                    )}

                    <textarea
                        id="notes"
                        required
                        rows={8}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="Enter detailed consultation notes, or record the visit above..."
                    />
                </div>

                <div className="space-y-2">
                    <label htmlFor="practice-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                        Practice Email (optional — sends the summary here when ready)
                    </label>
                    <input
                        id="practice-email"
                        type="email"
                        value={practiceEmail}
                        onChange={(e) => setPracticeEmail(e.target.value)}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent dark:bg-gray-700 dark:text-white"
                        placeholder="practice@example.com"
                    />
                </div>

                <button
                    type="submit" 
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
                >
                    {loading ? 'Generating Summary...' : 'Generate Summary'}
                </button>
            </form>

            {output && (
                <section className="mt-8 bg-gray-50 dark:bg-gray-800 rounded-xl shadow-lg p-8">
                    <div className="markdown-content prose prose-blue dark:prose-invert max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                            {output}
                        </ReactMarkdown>
                    </div>
                </section>
            )}
        </div>
    );
}

export default function Product() {
    return (
        <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
            {/* User Menu in Top Right */}
            <div className="absolute top-4 right-4">
                <UserButton showName={true} />
            </div>

            {/* Subscription Protection */}
            <Show
                when={{ plan: 'premium_subscription' }}
                fallback={
                    <div className="container mx-auto px-4 py-12">
                        <header className="text-center mb-12">
                            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent mb-4">
                                Healthcare Professional Plan
                            </h1>
                            <p className="text-gray-600 dark:text-gray-400 text-lg mb-8">
                                Streamline your patient consultations with AI-powered summaries
                            </p>
                        </header>
                        <div className="max-w-4xl mx-auto">
                            <PricingTable />
                        </div>
                    </div>
                }
            >
                <ConsultationForm />
            </Show>
        </main>
    );
}