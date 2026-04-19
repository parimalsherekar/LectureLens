import { useRef, useState, useCallback } from 'react';
import socket from '../socket';
import { io as llmIo } from 'socket.io-client';

const CHUNK_INTERVAL_MS = 30_000;
const SYNC_INTERVAL_MS = 5_000;

export function useTranscript({ roomId, role, localStream }) {
    const [segments, setSegments] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [transcriptStatus, setTranscriptStatus] = useState('idle');

    const mediaRecorderRef = useRef(null);
    const segmentsRef = useRef([]);
    const syncIntervalRef = useRef(null);
    const meetingStartRef = useRef(null);
    const segmentIdRef = useRef(0);
    const chunkCounterRef = useRef(0);
    const llmSocketRef = useRef(null);
    const llmSessionActiveRef = useRef(false);
    const shouldSendAudioRef = useRef(false);

    const hasPendingSegments = useCallback(
        () => segmentsRef.current.some((segment) => segment.status === 'processing'),
        []
    );

    const buildFullText = (segs) =>
        segs
            .filter((segment) => segment.status === 'complete' && segment.text)
            .map((segment) => segment.text)
            .join(' ');

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

    const teardownLLMSocket = useCallback(() => {
        llmSocketRef.current?.disconnect();
        llmSocketRef.current = null;
    }, []);

    const closeLLMSession = useCallback(
        ({ disconnect = false } = {}) => {
            if (llmSessionActiveRef.current) {
                llmSocketRef.current?.emit('endSession', { sessionId: roomId });
                llmSessionActiveRef.current = false;
            }

            if (disconnect) {
                teardownLLMSocket();
            }
        },
        [roomId, teardownLLMSocket]
    );

    const waitForPendingSegments = useCallback(
        (timeoutMs = 10_000) =>
            new Promise((resolve) => {
                if (!hasPendingSegments()) {
                    resolve();
                    return;
                }

                const startedAt = Date.now();
                const intervalId = setInterval(() => {
                    if (!hasPendingSegments() || Date.now() - startedAt >= timeoutMs) {
                        clearInterval(intervalId);
                        resolve();
                    }
                }, 250);
            }),
        [hasPendingSegments]
    );

    const ensureLLMSocket = useCallback(() => {
        if (llmSocketRef.current) {
            return llmSocketRef.current;
        }

        const llmSocket = llmIo('http://localhost:4000', {
            timeout: 60_000,
        });

        llmSocket.on('transcriptSegment', ({
            text,
            startOffset,
            endOffset,
            chunkIndex,
        }) => {
            const trimmedText = text?.trim() ?? '';

            setSegments((prev) => {
                const updated = [...prev];
                const placeholderIdx = updated.findIndex(
                    (segment) => segment.chunkIndex === chunkIndex && segment.status === 'processing'
                );

                if (placeholderIdx !== -1) {
                    if (!trimmedText) {
                        updated.splice(placeholderIdx, 1);
                    } else {
                        updated[placeholderIdx] = {
                            ...updated[placeholderIdx],
                            text: trimmedText,
                            startOffset,
                            endOffset,
                            timestamp: meetingStartRef.current + startOffset * 1000,
                            status: 'complete',
                        };
                    }
                } else if (trimmedText) {
                    const newSeg = {
                        id: ++segmentIdRef.current,
                        chunkIndex,
                        text: trimmedText,
                        startOffset,
                        endOffset,
                        timestamp: meetingStartRef.current + startOffset * 1000,
                        status: 'complete',
                    };

                    const insertAt = updated.findIndex(
                        (segment) => segment.startOffset > startOffset
                    );

                    if (insertAt === -1) {
                        updated.push(newSeg);
                    } else {
                        updated.splice(insertAt, 0, newSeg);
                    }
                }

                segmentsRef.current = updated;
                syncToSFU(updated);
                return updated;
            });
        });

        llmSocket.on('connect_error', (err) => {
            console.error('[LLM Server] Connection error:', err.message);
        });

        llmSocketRef.current = llmSocket;
        return llmSocket;
    }, [syncToSFU]);

    const startTranscription = useCallback(async () => {
        if (!localStream || role !== 'host' || mediaRecorderRef.current) return;

        if (!meetingStartRef.current) {
            meetingStartRef.current = Date.now();
        }

        shouldSendAudioRef.current = true;

        setIsRecording(true);
        setTranscriptStatus('live');
        socket.emit('startTranscription', { roomId });

        const llmSocket = ensureLLMSocket();

        if (llmSessionActiveRef.current) {
            // Reuse the same session while the host stays in the room.
        } else if (llmSocket.connected) {
            // Each LLM session must start its chunk numbering from 0 so the
            // transcript server can rebuild the WebM header for that session.
            chunkCounterRef.current = 0;
            llmSocket.emit('startSession', { sessionId: roomId });
            llmSessionActiveRef.current = true;
        } else {
            llmSocket.once('connect', () => {
                console.log('[LLM Server] connected, starting session');
                chunkCounterRef.current = 0;
                llmSocket.emit('startSession', { sessionId: roomId });
                llmSessionActiveRef.current = true;
            });
        }

        const audioOnlyStream = new MediaStream(localStream.getAudioTracks());
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';

        const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
        mediaRecorderRef.current = recorder;

        let currentChunkStartTime = Date.now();

        recorder.ondataavailable = (event) => {
            if (event.data.size === 0) return;
            if (!shouldSendAudioRef.current) return;

            const chunkIndex = chunkCounterRef.current++;
            const thisChunkStart = currentChunkStartTime;
            const startOffset = parseFloat(
                ((thisChunkStart - meetingStartRef.current) / 1000).toFixed(2)
            );

            currentChunkStartTime = Date.now();

            llmSocketRef.current?.emit('audioChunk', {
                sessionId: roomId,
                chunk: event.data,
                startOffset,
                chunkIndex,
            });

            const placeholder = {
                id: ++segmentIdRef.current,
                chunkIndex,
                text: '',
                startOffset,
                endOffset: null,
                timestamp: thisChunkStart,
                status: 'processing',
            };

            segmentsRef.current = [...segmentsRef.current, placeholder];
            setSegments([...segmentsRef.current]);
        };

        recorder.start(CHUNK_INTERVAL_MS);

        syncIntervalRef.current = setInterval(() => {
            syncToSFU(segmentsRef.current);
        }, SYNC_INTERVAL_MS);
    }, [ensureLLMSocket, localStream, role, roomId, syncToSFU]);

    const stopTranscription = useCallback(async () => {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;

        const recorder = mediaRecorderRef.current;
        if (!recorder) {
            shouldSendAudioRef.current = false;
            setIsRecording(false);
            setTranscriptStatus('live');
            syncToSFU(segmentsRef.current);
            return;
        }

        shouldSendAudioRef.current = false;
        setIsRecording(false);
        setTranscriptStatus('live');

        await new Promise((resolve) => {
            recorder.onstop = () => {
                mediaRecorderRef.current = null;
                resolve();
            };

            recorder.stop();
        });

        syncToSFU(segmentsRef.current);
        await waitForPendingSegments();
        syncToSFU(segmentsRef.current);
    }, [syncToSFU, waitForPendingSegments]);

    const finalizeMeeting = useCallback(async () => {
        if (role !== 'host' || !roomId) return;

        if (mediaRecorderRef.current) {
            await stopTranscription();
        } else {
            shouldSendAudioRef.current = false;
            syncToSFU(segmentsRef.current);
            await waitForPendingSegments(2_000);
        }

        closeLLMSession({ disconnect: true });

        const response = await new Promise((resolve, reject) => {
            socket.timeout(10_000).emit('finalizeMeeting', { roomId }, (err, res) => {
                if (err) {
                    reject(new Error('Timed out while ending the meeting'));
                    return;
                }

                if (res?.error) {
                    reject(new Error(res.error));
                    return;
                }

                resolve(res);
            });
        });

        setTranscriptStatus('completed');
        return response;
    }, [closeLLMSession, role, roomId, stopTranscription, syncToSFU, waitForPendingSegments]);

    const fetchTranscript = useCallback(() => {
        socket.emit('getTranscript', { roomId }, (res) => {
            if (res.error) {
                console.warn('[Transcript] Fetch error:', res.error);
                return;
            }

            segmentsRef.current = res.segments || [];
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
        finalizeMeeting,
        fetchTranscript,
    };
}
