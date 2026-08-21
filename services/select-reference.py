from __future__ import annotations

import array
import io
import json
import math
import pathlib
import wave
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "services" / "voice-config.json"
OUTPUT_DIR = ROOT / "services" / "voice-reference"
OUTPUT_AUDIO = OUTPUT_DIR / "reference.wav"
OUTPUT_INFO = OUTPUT_DIR / "reference.json"


def inspect_wav(payload: bytes) -> dict | None:
    try:
        with wave.open(io.BytesIO(payload), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            frame_rate = wav.getframerate()
            frames = wav.getnframes()
            if sample_width != 2 or channels not in (1, 2) or frame_rate <= 0:
                return None
            duration = frames / frame_rate
            if not 3.0 <= duration <= 10.0:
                return None
            pcm = array.array("h", wav.readframes(frames))
    except (wave.Error, EOFError):
        return None

    if not pcm:
        return None
    if channels == 2:
        pcm = array.array("h", ((pcm[index] + pcm[index + 1]) // 2 for index in range(0, len(pcm) - 1, 2)))
    peak = max(abs(sample) for sample in pcm) / 32768
    rms = math.sqrt(sum(sample * sample for sample in pcm) / len(pcm)) / 32768
    quiet_ratio = sum(abs(sample) < 260 for sample in pcm) / len(pcm)
    clipped_ratio = sum(abs(sample) >= 32600 for sample in pcm) / len(pcm)
    if rms < 0.015 or peak < 0.08:
        return None

    score = 8.0
    score -= abs(duration - 5.5) * 0.55
    score -= abs(rms - 0.105) * 8.0
    score -= max(0.0, quiet_ratio - 0.35) * 4.0
    score -= clipped_ratio * 200.0
    return {
        "duration": round(duration, 3),
        "sampleRate": frame_rate,
        "channels": channels,
        "rms": round(rms, 5),
        "peak": round(peak, 5),
        "quietRatio": round(quiet_ratio, 5),
        "clippedRatio": round(clipped_ratio, 7),
        "score": round(score, 5),
    }


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    archive_path = pathlib.Path(config["referenceArchive"])
    best: tuple[float, str, bytes, dict] | None = None
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".wav"):
                continue
            payload = archive.read(info)
            metrics = inspect_wav(payload)
            if metrics is None:
                continue
            candidate = (metrics["score"], info.filename, payload, metrics)
            if best is None or candidate[0] > best[0]:
                best = candidate

    if best is None:
        raise RuntimeError("No suitable 3-10 second PCM WAV reference was found in Yukino.zip")
    _, archive_name, payload, metrics = best
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_AUDIO.write_bytes(payload)
    OUTPUT_INFO.write_text(
        json.dumps(
            {
                "sourceArchive": str(archive_path),
                "sourceEntry": archive_name,
                "output": str(OUTPUT_AUDIO),
                "promptText": "",
                "promptLanguage": "ja",
                "metrics": metrics,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"selected": archive_name, **metrics}, ensure_ascii=False))


if __name__ == "__main__":
    main()
