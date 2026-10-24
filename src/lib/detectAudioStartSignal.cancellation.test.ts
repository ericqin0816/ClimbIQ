import { afterEach, describe, it, expect, vi } from 'vitest';
import { detectAudioStartSignal } from './detectAudioStartSignal';
const observations: unknown[] = [], sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T>() {
    let resolve!: (x: T) => void, reject!: (e: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {
        promise, resolve, reject
    };
}
function observe<T>(promise: Promise<T>) {
    const status: {
        state: string;
        errorName?: string;
        message?: string;
        value?: T;
    } = {
        state: 'pending'
    };
    const drained = promise.then(value => {
        status.state = 'fulfilled';
        status.value = value;
    }, error => {
        status.state = 'rejected';
        status.errorName = error.name;
        status.message = error.message;
    });
    return {
        status, drained
    };
}
function file() {
    return new File(['actual original encoded byte handle'], 'same-name.mp4');
}
function empty(rate = 8000): AudioBuffer {
    return {
        sampleRate: rate, numberOfChannels: 0, length: 0, duration: 0, getChannelData: () => {
            throw Error('No channel exists');
        }
    } as unknown as AudioBuffer;
}
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
describe('primary cancellation held-operation independent reproduction', () => {
    it('preaborted-noIO: rejects before reading or creating a decoder', async () => {
        const f = file(), read = vi.spyOn(f, 'arrayBuffer'), Constructor = vi.fn(), controller = new AbortController();
        vi.stubGlobal('window', {
            AudioContext: Constructor
        });
        controller.abort();
        await expect(detectAudioStartSignal({
            file: f, searchStart: 0, searchEnd: 2, signal: controller.signal
        })).rejects.toMatchObject({
            name: 'AbortError'
        });
        expect(read).not.toHaveBeenCalled();
        expect(Constructor).not.toHaveBeenCalled();
        observations.push({
            id: 'preaborted-noIO', reads: read.mock.calls.length, constructs: Constructor.mock.calls.length
        });
    });
    for (const lateReject of [false, true])
        it(lateReject ? 'heldread-late-reject: stops before late read rejection' : 'heldread-abort: rejects while original read remains pending', async () => {
            const id = lateReject ? 'heldread-late-reject' : 'heldread-abort', f = file(), bytes = deferred<ArrayBuffer>(), read = vi.spyOn(f, 'arrayBuffer').mockReturnValue(bytes.promise), Constructor = vi.fn(), controller = new AbortController();
            vi.stubGlobal('window', {
                AudioContext: Constructor
            });
            const pending = observe(detectAudioStartSignal({
                file: f, searchStart: 0, searchEnd: 2, signal: controller.signal
            }));
            controller.abort();
            const trace: {
                id: string;
                beforeRelease?: unknown;
                afterCleanup?: unknown;
            } = {
                id
            };
            observations.push(trace);
            try {
                await sleep(50);
                trace.beforeRelease = {
                    ...pending.status, reads: read.mock.calls.length, constructs: Constructor.mock.calls.length, readStillHeld: true
                };
                expect(trace.beforeRelease).toMatchObject({
                    state: 'rejected', errorName: 'AbortError', constructs: 0, readStillHeld: true
                });
            }
            finally {
                if (lateReject)
                    bytes.reject(Error('Original read failed after owner cancelled'));
                else
                    bytes.resolve(new ArrayBuffer(1));
                await pending.drained;
                await sleep();
                trace.afterCleanup = {
                    ...pending.status, constructs: Constructor.mock.calls.length
                };
                expect(Constructor).not.toHaveBeenCalled();
            }
        });
    for (const condition of [{
            id: 'helddecode-unsettled-after-close', fallback: false, lateReject: false
        }, {
            id: 'helddecode-late-reject', fallback: false, lateReject: true
        }, {
            id: 'fallback-helddecode-abort', fallback: true, lateReject: false
        }])
        it(condition.id + ': cancellation closes once without waiting for native decoder settlement', async () => {
            const f = file(), decoding = deferred<AudioBuffer>(), decode = vi.fn(() => decoding.promise), close = vi.fn(async () => undefined), controller = new AbortController(), attempts: Array<{
                requested: number | null;
                created: boolean;
            }> = [];
            const Constructor = vi.fn(function (options?: AudioContextOptions) {
                if (condition.fallback && options?.sampleRate === 8000) {
                    attempts.push({
                        requested: 8000, created: false
                    });
                    throw new DOMException('Registered unsupported8k', 'NotSupportedError');
                }
                attempts.push({
                    requested: options?.sampleRate ?? null, created: true
                });
                return {
                    decodeAudioData: decode, close
                };
            });
            vi.stubGlobal('window', {
                AudioContext: Constructor
            });
            const pending = observe(detectAudioStartSignal({
                file: f, searchStart: 0, searchEnd: 2, signal: controller.signal
            }));
            await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce(), {
                interval: 1, timeout: 1000
            });
            controller.abort();
            controller.abort();
            const trace: {
                id: string;
                beforeRelease?: unknown;
                afterCleanup?: unknown;
            } = {
                id: condition.id
            };
            observations.push(trace);
            try {
                await sleep(50);
                trace.beforeRelease = {
                    ...pending.status, closeCalls: close.mock.calls.length, decodeStillHeld: true, attempts: [...attempts]
                };
                expect(trace.beforeRelease).toMatchObject({
                    state: 'rejected', errorName: 'AbortError', closeCalls: 1, decodeStillHeld: true
                });
                if (condition.fallback)
                    expect(attempts).toEqual([{
                            requested: 8000, created: false
                        }, {
                            requested: null, created: true
                        }]);
            }
            finally {
                if (condition.lateReject)
                    decoding.reject(Error('Native decoder rejected after cancellation'));
                else
                    decoding.resolve(empty(condition.fallback ? 48000 : 8000));
                await pending.drained;
                await sleep();
                trace.afterCleanup = {
                    ...pending.status, closeCalls: close.mock.calls.length, decodeCalls: decode.mock.calls.length, attempts
                };
                expect(close).toHaveBeenCalledOnce();
            }
        });
    it('progress-abort-prevents-read: observes callback cancellation before beginning file work', async () => {
        const f = file(), read = vi.spyOn(f, 'arrayBuffer'), Constructor = vi.fn(), controller = new AbortController();
        vi.stubGlobal('window', {
            AudioContext: Constructor
        });
        await expect(detectAudioStartSignal({
            file: f, searchStart: 0, searchEnd: 2, signal: controller.signal, onProgress: () => controller.abort()
        })).rejects.toMatchObject({
            name: 'AbortError'
        });
        observations.push({
            id: 'progress-abort-prevents-read', reads: read.mock.calls.length, constructs: Constructor.mock.calls.length
        });
        expect(read).not.toHaveBeenCalled();
        expect(Constructor).not.toHaveBeenCalled();
    });
});
describe('primary existing non-cancellation behavior controls', () => {
    it('missing-decoder: preserves existing None reason without reading', async () => {
        const f = file(), read = vi.spyOn(f, 'arrayBuffer');
        vi.stubGlobal('window', {});
        const result = await detectAudioStartSignal({
            file: f, searchStart: 0, searchEnd: 2
        });
        expect(result).toMatchObject({
            found: false, confidence: 'None', reason: "This browser cannot decode the video's audio track."
        });
        expect(read).not.toHaveBeenCalled();
        observations.push({
            id: 'missing-decoder', result
        });
    });
    it('read-error-noabort: preserves reason and does not create a context', async () => {
        const f = file(), Constructor = vi.fn();
        vi.spyOn(f, 'arrayBuffer').mockRejectedValue(Error('Read disk failure'));
        vi.stubGlobal('window', {
            AudioContext: Constructor
        });
        const result = await detectAudioStartSignal({
            file: f, searchStart: 0, searchEnd: 2
        });
        expect(result).toMatchObject({
            found: false, confidence: 'None', reason: 'The audio track could not be analyzed: Read disk failure'
        });
        expect(Constructor).not.toHaveBeenCalled();
        observations.push({
            id: 'read-error-noabort', result
        });
    });
    it('decode-error-noabort: preserves reason, closes once, absorbs rejected close', async () => {
        const f = file(), close = vi.fn(async () => {
            throw Error('Close failure must not override analysis error');
        }), decode = vi.fn(async () => {
            throw Error('Actual decode failure');
        });
        vi.stubGlobal('window', {
            AudioContext: vi.fn(function () {
                return {
                    close, decodeAudioData: decode
                };
            })
        });
        const result = await detectAudioStartSignal({
            file: f, searchStart: 0, searchEnd: 2
        });
        await sleep();
        expect(result).toMatchObject({
            found: false, confidence: 'None', reason: 'The audio track could not be analyzed: Actual decode failure'
        });
        expect(close).toHaveBeenCalledOnce();
        observations.push({
            id: 'decode-error-noabort', result, closeCalls: close.mock.calls.length
        });
    });
    for (const fallback of [false, true])
        it(fallback ? 'fallback-empty-audio: preserves unsupported8k fallback and one actual owned context' : 'normal-empty-audio-closeonce: preserves empty result and one close', async () => {
            const close = vi.fn(async () => undefined), attempts: Array<number | null> = [], decode = vi.fn(async () => empty(fallback ? 48000 : 8000));
            const Constructor = vi.fn(function (options?: AudioContextOptions) {
                attempts.push(options?.sampleRate ?? null);
                if (fallback && options?.sampleRate === 8000)
                    throw new DOMException('Unsupported8k', 'NotSupportedError');
                return {
                    close, decodeAudioData: decode
                };
            });
            vi.stubGlobal('window', {
                AudioContext: Constructor
            });
            const result = await detectAudioStartSignal({
                file: file(), searchStart: 0, searchEnd: 2
            });
            await sleep();
            expect(result).toMatchObject({
                found: false, confidence: 'None', reason: 'The uploaded video has no usable audio samples.'
            });
            expect(attempts).toEqual(fallback ? [8000, null] : [8000]);
            expect(close).toHaveBeenCalledOnce();
            observations.push({
                id: fallback ? 'fallback-empty-audio' : 'normal-empty-audio-closeonce', attempts, result, closeCalls: close.mock.calls.length
            });
        });
    it('constructor-other-error: does not reinterpret arbitrary construction error as fallback', async () => {
        const Constructor = vi.fn(function () {
            throw Error('Decoder construction failed');
        });
        vi.stubGlobal('window', {
            AudioContext: Constructor
        });
        const result = await detectAudioStartSignal({
            file: file(), searchStart: 0, searchEnd: 2
        });
        expect(result).toMatchObject({
            found: false, confidence: 'None', reason: 'The audio track could not be analyzed: Decoder construction failed'
        });
        expect(Constructor).toHaveBeenCalledOnce();
        observations.push({
            id: 'constructor-other-error', result, attempts: Constructor.mock.calls.length
        });
    });
});
