import { useRef, useState, useCallback } from 'react';
import socket from '../socket';
import { io as llmIo } from 'socket.io-client';

// ─────────────────────────────────────────────────────────────────────────────
// TIMING CONSTANTS
//
// CHUNK_INTERVAL_MS — how often MediaRecorder slices the mic audio and sends
//   a blob to the LLM server.  30 s gives Whisper enough context per chunk to
//   produce accurate transcriptions while still feeling "live" to the host.
//
// SYNC_INTERVAL_MS  — how often the *completed* (text-filled) segments are
//   pushed to the SFU server so participants can follow along.  Keep this
//   shorter than CHUNK_INTERVAL_MS so the SFU always has the latest data.
// ─────────────────────────────────────────────────────────────────────────────
const CHUNK_INTERVAL_MS = 30_000;   // 30 s — wide enough window for good STT
const SYNC_INTERVAL_MS  =  5_000;   //  5 s — lightweight text-only SFU sync

/**
 * useTranscript — manages host audio capture and transcript state.
 *
 * HOST flow:
 *   1. startTranscription()
 *        → connects to LLM server via Socket.IO
 *        → opens MediaRecorder on the host mic audio track only
 *   2. Every 30 s → MediaRecorder fires ondataavailable
 *        → blob sent to LLM server as 'audioChunk'
 *        → a { status: 'processing' } UI placeholder is pushed to state
 *   3. LLM server finishes Whisper on that chunk → emits 'transcriptSegment'
 *        → placeholder is replaced with real text; status → 'complete'
 *   4. Every 5 s → completed segments are synced to the SFU server
 *   5. stopTranscription()
 *        → MediaRecorder stopped (final ondataavailable fires for the tail)
 *        → LLM server told to end session (flush + clean up)
 *        → SFU server told transcript is complete
 *
 * PARTICIPANT flow:
 *   1. fetchTranscript() → requests completed transcript from SFU server
 *
 * @param {{ roomId: string, role: string, localStream: MediaStream|null }} opts
 */
export function useTranscript({ roomId, role, localStream }) {
    const [segments, setSegments]               = useState([]);
    const [isRecording, setIsRecording]         = useState(false);
    const [transcriptStatus, setTranscriptStatus] = useState('idle');
    // 'idle' | 'live' | 'complete'

    const mediaRecorderRef  = useRef(null);
    const segmentsRef       = useRef([]);   // mirror of state — safe inside callbacks
    const syncIntervalRef   = useRef(null);
    const meetingStartRef   = useRef(null);
    const segmentIdRef      = useRef(0);
    const chunkCounterRef   = useRef(0);    // tracks how many chunks have been sent

    // Socket connection to the LLM transcription server
    const llmSocketRef = useRef(null);

    // ── helpers ────────────────────────────────────────────────────────────────

    const buildFullText = (segs) =>
        segs
            .filter((s) => s.status === 'complete' && s.text)
            .map((s) => s.text)
            .join(' ');

    /** Push the current completed-segment list to the SFU server. */
    const syncToSFU = useCallback(
        (segs) => {
            socket.emit('syncTranscript', {
                roomId,
                segments: segs,
                fullText: buildFullText(segs),
            });
        },
        [roomId]
    );

    // ── startTranscription (host only) ─────────────────────────────────────────

    const startTranscription = useCallback(async () => {
        if (!localStream || role !== 'host') return;

        // Reset all session state
        segmentsRef.current  = [];
        segmentIdRef.current = 0;
        chunkCounterRef.current = 0;
        meetingStartRef.current = Date.now();

        setIsRecording(true);
        setTranscriptStatus('live');
        setSegments([]);

        // Tell SFU to create a transcript record for this room
        socket.emit('startTranscription', { roomId });

        // ── Connect to LLM transcription server ──────────────────────────────
        //
        // Replace 'http://localhost:4000' with your actual LLM server address
        // (e.g. process.env.REACT_APP_LLM_SERVER_URL) before deploying.
        //
        llmSocketRef.current = llmIo('http://localhost:4000', {
            timeout: 60_000,
        });

        // ── CRITICAL: wait for the socket to actually connect before emitting
        // startSession.  llmIo() is non-blocking — the socket is not connected
        // the moment the call returns.  Emitting before 'connect' fires means
        // the server never receives the event and silently drops every audioChunk
        // for this session.
        llmSocketRef.current.once('connect', () => {
            console.log('[LLM Server] connected, starting session');
            llmSocketRef.current.emit('startSession', { sessionId: roomId });
        });

        // ── Handle incoming transcript segments from the LLM server ──────────
        //
        // The LLM server emits one 'transcriptSegment' event per Whisper segment
        // inside a chunk.  A single 30-second audio chunk may produce several
        // Whisper segments (e.g. sentence-level splits).
        //
        // Strategy:
        //   • Find the placeholder we created in ondataavailable for the chunk
        //     that owns this segment (matched by chunkIndex on the payload).
        //   • Replace the placeholder text / status in-place.
        //   • If the server sends extra sub-segments beyond the first, insert
        //     them immediately after the placeholder.
        //
        llmSocketRef.current.on('transcriptSegment', ({
            text,
            startOffset,
            endOffset,
            chunkIndex,
        }) => {
            // NOTE: do NOT early-return on empty text here.
            // An empty text means "no speech in this chunk" — we still need
            // to clear the 'processing' placeholder so it doesn't spin forever.
            const trimmedText = text?.trim() ?? '';

            setSegments((prev) => {
                const updated = [...prev];

                // Find the placeholder for this chunk
                const placeholderIdx = updated.findIndex(
                    (s) => s.chunkIndex === chunkIndex && s.status === 'processing'
                );

                if (placeholderIdx !== -1) {
                    if (!trimmedText) {
                        // No speech detected — remove the placeholder entirely
                        // so the UI doesn't show an empty bubble.
                        updated.splice(placeholderIdx, 1);
                    } else {
                        // Replace placeholder with real transcribed text
                        updated[placeholderIdx] = {
                            ...updated[placeholderIdx],
                            text:        trimmedText,
                            startOffset,
                            endOffset,
                            timestamp:   meetingStartRef.current + startOffset * 1000,
                            status:      'complete',
                        };
                    }
                } else if (trimmedText) {
                    // Additional sub-segment for a chunk whose placeholder was
                    // already filled — insert in chronological order.
                    const newSeg = {
                        id:          ++segmentIdRef.current,
                        chunkIndex,
                        text:        trimmedText,
                        startOffset,
                        endOffset,
                        timestamp:   meetingStartRef.current + startOffset * 1000,
                        status:      'complete',
                    };
                    const insertAt = updated.findIndex(
                        (s) => s.startOffset > startOffset
                    );
                    if (insertAt === -1) {
                        updated.push(newSeg);
                    } else {
                        updated.splice(insertAt, 0, newSeg);
                    }
                }

                segmentsRef.current = updated;
                return updated;
            });
        });

        llmSocketRef.current.on('connect_error', (err) => {
            console.error('[LLM Server] Connection error:', err.message);
        });

        // ── Set up MediaRecorder on the host mic audio track only ────────────
        const audioOnlyStream = new MediaStream(localStream.getAudioTracks());

        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';

        const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
        mediaRecorderRef.current = recorder;

        // Track the start time of the CURRENT chunk window.
        // ondataavailable fires at the END of each 30-second window, so
        // Date.now() at that point is the chunk's END time, not its start.
        // We record the start time when each window opens instead.
        let currentChunkStartTime = Date.now(); // start of chunk 0

        recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;

            const chunkIndex       = chunkCounterRef.current++;
            const thisChunkStart   = currentChunkStartTime;   // snapshot before advancing
            const startOffset      = parseFloat(
                ((thisChunkStart - meetingStartRef.current) / 1000).toFixed(2)
            );

            // Advance the window start for the NEXT chunk
            currentChunkStartTime = Date.now();

            // ── Send the 30-second audio blob to the LLM server ──────────────
            //
            // We pass chunkIndex so the server can echo it back on
            // 'transcriptSegment', letting us match segments to placeholders.
            //
            llmSocketRef.current?.emit('audioChunk', {
                sessionId:   roomId,
                chunk:       event.data,   // Blob — audio/webm;codecs=opus, ~30 s
                startOffset,               // seconds from meeting start (float)
                chunkIndex,                // monotonically increasing chunk number
            });

            // ── Add a UI placeholder so the host sees "Processing…" ──────────
            //
            // The placeholder is replaced with real text when the LLM server
            // responds with 'transcriptSegment' carrying the same chunkIndex.
            //
            const placeholder = {
                id:          ++segmentIdRef.current,
                chunkIndex,
                text:        '',
                startOffset,
                endOffset:   null,
                timestamp:   thisChunkStart,   // epoch ms when this chunk's audio began
                status:      'processing',
            };

            segmentsRef.current = [...segmentsRef.current, placeholder];
            setSegments([...segmentsRef.current]);
        };

        // Produce one blob every CHUNK_INTERVAL_MS (30 s)
        recorder.start(CHUNK_INTERVAL_MS);

        // Periodic sync of completed text segments to the SFU server
        syncIntervalRef.current = setInterval(() => {
            syncToSFU(segmentsRef.current);
        }, SYNC_INTERVAL_MS);
    }, [localStream, role, roomId, syncToSFU]);

    // ── stopTranscription (host only) ──────────────────────────────────────────

    const stopTranscription = useCallback(() => {
        // Stopping the recorder triggers a final ondataavailable for the tail
        // audio (the partial chunk since the last 30-second boundary).
        mediaRecorderRef.current?.stop();
        clearInterval(syncIntervalRef.current);

        // Final SFU sync before marking the transcript complete
        syncToSFU(segmentsRef.current);
        socket.emit('endTranscription', { roomId });

        setIsRecording(false);
        setTranscriptStatus('complete');

        // Tell the LLM server to flush any buffered audio and clean up
        llmSocketRef.current?.emit('endSession', { sessionId: roomId });
        llmSocketRef.current?.disconnect();
        llmSocketRef.current = null;
    }, [roomId, syncToSFU]);

    // ── fetchTranscript (participant) ──────────────────────────────────────────

    const fetchTranscript = useCallback(() => {
        socket.emit('getTranscript', { roomId }, (res) => {
            if (res.error) {
                console.warn('[Transcript] Fetch error:', res.error);
                return;
            }
            setSegments(res.segments || []);
            setTranscriptStatus(res.status);
        });
    }, [roomId]);

    return {
        segments,
        isRecording,
        transcriptStatus,
        startTranscription,
        stopTranscription,
        fetchTranscript,
    };
}