#!/usr/bin/env python
"""Offline acoustic echo cancellation for murmur's ownscribe capture.

usage: aec.py SYS.wav MIC.wav OUT.wav

SYS/MIC are the two aligned 24 kHz mono float tracks written by
`ownscribe-audio capture --keep-tracks`; OUT = SYS + (MIC - estimated echo of SYS).
On speakers the mic re-captures the system audio 30-100 ms late through the room; the echo path
is a linear filter of SYS, so with the exact far-end signal in hand it can be estimated and
subtracted - the user's own words survive, even spoken over the remote party (the merge-time
mic gate mutes them). Two stages:
  1. Partitioned block frequency-domain NLMS, adapting only while the far end is active and no
     near-end speech is detected (Geigel); a warm-up pass first so the start of the file is
     cancelled by a converged filter too. The two tracks jitter ~1-2 ms against each other, which
     caps this linear stage at ~10 dB.
  2. Residual echo suppression: per STFT bin, a Wiener gain against rho*|Y|^2 (Y = the echo
     estimate, rho = the residual ratio learned on echo-only frames). ~23 dB total on echo-only
     audio; in double-talk the near-end voice is kept with the echo ~9 dB below it.
Any failure exits non-zero; the caller falls back to the gated merge.
"""
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate

B = 512        # block: 21 ms at 24 kHz
P = 16         # partitions -> 8192-tap filter = 341 ms of echo path
MU = 0.4       # NLMS step
FAR_ACTIVE = 3e-3   # far-end block RMS above this -> adapt (~-50 dBFS)
GEIGEL = 0.5        # near-end speech if |mic| peak > 0.5 * recent |far| peak (echo is >6 dB down)
WARMUP_S = 180      # warm-up pass length
GMIN = 0.1          # post-filter floor (-20 dB)


def read(path):
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # CoreAudio WAVs carry a FLLR chunk scipy does not know
        sr, x = wavfile.read(path)
    if x.dtype != np.float32:
        x = x.astype(np.float32) / np.iinfo(x.dtype).max
    if x.ndim > 1:
        x = x.mean(axis=1)
    return sr, x.astype(np.float64)


def coarse_delay(x, d, sr):
    """Median echo lag (samples) over loud 10 s windows; 0 if no echo is detectable (headphones)."""
    W, lo, hi = 10 * sr, int(-0.1 * sr), int(0.5 * sr)
    lags = []
    for s in range(0, len(x) - W, W):
        xs, ds = x[s:s + W], d[s:s + W]
        if np.sqrt((xs ** 2).mean()) < 0.01 or len(lags) >= 8:
            continue
        c = correlate(ds, xs, mode="full", method="fft")[len(xs) - 1 + lo:len(xs) - 1 + hi]
        k = int(np.argmax(np.abs(c)))
        if np.abs(c[k]) > 6 * np.abs(c).std():
            lags.append(lo + k)
    return int(np.median(lags)) if lags else 0


def run(x, d, W=None, nblocks=None):
    """One PBFDAF pass over the first nblocks blocks. Returns (e, y, W): error, echo estimate, filter."""
    n = len(d) // B if nblocks is None else nblocks
    nb = B + 1
    W = np.zeros((P, nb), complex) if W is None else W
    X = np.zeros((P, nb), complex)          # last P far-end spectra, newest first
    e = np.zeros(n * B)
    yhat = np.zeros(n * B)
    xprev = np.zeros(B)
    far_peak = 0.0
    for k in range(n):
        xb = x[k * B:(k + 1) * B]
        db = d[k * B:(k + 1) * B]
        X = np.roll(X, 1, axis=0)
        X[0] = np.fft.rfft(np.concatenate([xprev, xb]))
        xprev = xb
        y = np.fft.irfft((W * X).sum(axis=0))[B:]
        eb = db - y
        e[k * B:(k + 1) * B] = eb
        yhat[k * B:(k + 1) * B] = y
        far_peak = max(np.abs(xb).max(), far_peak * 0.9)  # ~200 ms decay
        far_rms = np.sqrt((xb ** 2).mean())
        near = np.abs(db).max() > GEIGEL * far_peak
        if far_rms > FAR_ACTIVE and not near:
            E = np.fft.rfft(np.concatenate([np.zeros(B), eb]))
            power = (np.abs(X) ** 2).sum(axis=0) + 1e-6
            W += MU * np.conj(X) * E / power
    return e, yhat, W


def postfilter(e, y):
    """Suppress residual echo: Wiener gain per STFT bin against rho*|Y|^2, rho learned on frames
    that look echo-only (error power close to what rho already predicts)."""
    N, hop = 512, 256
    w = np.sqrt(np.hanning(N + 1)[:N])
    out = np.zeros(len(e))
    rho = np.ones(N // 2 + 1)
    for i in range((len(e) - N) // hop):
        seg = slice(i * hop, i * hop + N)
        E = np.fft.rfft(w * e[seg])
        Y = np.fft.rfft(w * y[seg])
        pe, py = np.abs(E) ** 2, np.abs(Y) ** 2 + 1e-12
        if py.sum() > 1e-3:  # echo present in this frame
            if pe.sum() < 4 * (rho * py).sum() or i < 50:
                rho = 0.9 * rho + 0.1 * np.minimum(pe / py, 10)
            E *= np.maximum(GMIN, 1 - rho * py / (pe + 1e-12))
        out[seg] += w * np.fft.irfft(E)
    return out


def main():
    sys_path, mic_path, out_path = sys.argv[1:4]
    sr, x = read(sys_path)
    sr2, d = read(mic_path)
    if sr != sr2:
        raise SystemExit(f"sample rates differ: {sr} vs {sr2}")
    n = min(len(x), len(d))
    x, d = x[:n], d[:n]
    lag = coarse_delay(x, d, sr)
    # Shift the far end so the echo lands ~1 block into the filter span (room for jitter).
    shift = lag - B
    xs = np.roll(x, shift)
    if shift > 0:
        xs[:shift] = 0
    elif shift < 0:
        xs[shift:] = 0
    warm = min(n // B, int(WARMUP_S * sr) // B)
    _, _, W = run(xs, d, nblocks=warm)
    e, y, _ = run(xs, d, W=W)
    e = postfilter(e, y)
    e = np.concatenate([e, d[len(e):]])           # tail shorter than a block: pass through
    cancelled = 10 * np.log10(((d ** 2).sum() + 1e-12) / ((e ** 2).sum() + 1e-12))
    out = np.clip(x + e, -1, 1).astype(np.float32)
    wavfile.write(out_path, sr, out)
    print(f"aec: echo lag {lag / sr * 1000:.0f} ms, mic energy -{cancelled:.1f} dB after cancellation", file=sys.stderr)


if __name__ == "__main__":
    main()
