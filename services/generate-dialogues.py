from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import sys
import unicodedata
import wave

import numpy as np
import torch


ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT / "services" / "GPT-SoVITS-main"
GPT_ROOT = REPO / "GPT_SoVITS"
VOICE_CONFIG_PATH = ROOT / "services" / "voice-config.json"
DIALOGUES_PATH = ROOT / "app" / "assets" / "voice" / "dialogues.json"
REFERENCE_PATH = ROOT / "services" / "voice-reference" / "reference.wav"
OUTPUT_DIR = ROOT / "app" / "assets" / "voice" / "generated"
PRETRAINED_DIR = GPT_ROOT / "pretrained_models"
PUNCTUATION = set("、。！？!?，,．.;；：:…—-「」『』（）()【】[]")


def write_wav(path: pathlib.Path, sample_rate: int, audio: np.ndarray) -> None:
    samples = np.asarray(audio).reshape(-1)
    if samples.dtype != np.int16:
        samples = np.clip(samples, -32768, 32767).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(samples.tobytes())


def write_wav_atomic(path: pathlib.Path, sample_rate: int, audio: np.ndarray) -> None:
    temporary_path = path.with_suffix(path.suffix + ".tmp")
    write_wav(temporary_path, sample_rate, audio)
    os.replace(temporary_path, path)


def count_spoken_units(text: str) -> int:
    return sum(
        1
        for character in text
        if not character.isspace()
        and character not in PUNCTUATION
        and not unicodedata.category(character).startswith("P")
    )


def analyze_audio_quality(text: str, sample_rate: int, audio: np.ndarray, settings: dict) -> dict:
    samples = np.asarray(audio).reshape(-1).astype(np.float32)
    duration = len(samples) / sample_rate
    if not len(samples) or duration <= 0:
        return {"accepted": False, "score": float("inf"), "duration": 0.0}

    window = max(1, int(sample_rate * 0.005))
    rms = np.array(
        [
            np.sqrt(np.mean(samples[index : index + window] ** 2) + 1e-12)
            for index in range(0, len(samples), window)
        ]
    )
    peak_rms = max(float(rms.max()), 1e-12)
    quiet = 20.0 * np.log10((rms + 1e-12) / peak_rms) < -35.0
    gaps: list[tuple[float, float, float]] = []
    run_start: int | None = None
    for index, is_quiet in enumerate(quiet):
        if is_quiet and run_start is None:
            run_start = index
        if run_start is not None and (not is_quiet or index == len(quiet) - 1):
            run_end = index if not is_quiet else index + 1
            gap_duration = (run_end - run_start) * 0.005
            if gap_duration >= 0.08:
                gaps.append((run_start * 0.005, run_end * 0.005, gap_duration))
            run_start = None

    internal_gaps = [
        gap for gap in gaps if gap[0] >= 0.12 and gap[1] <= duration - 0.12
    ]
    punctuation_count = sum(
        1
        for character in text
        if character in PUNCTUATION or unicodedata.category(character).startswith("P")
    )
    sorted_internal = sorted(internal_gaps, key=lambda gap: gap[2], reverse=True)
    unexpected_gaps = sorted_internal[min(punctuation_count, len(sorted_internal)) :]
    unexpected_gap_seconds = sum(gap[2] for gap in unexpected_gaps)
    gap_seconds = sum(gap[2] for gap in gaps)
    gap_ratio = gap_seconds / duration

    spoken_units = max(1, count_spoken_units(text))
    expected_duration = max(1.0, spoken_units / 7.0)
    duration_ratio = duration / expected_duration
    peak = max(float(np.max(np.abs(samples))), 1.0)
    clipped_ratio = float(np.mean(np.abs(samples) >= peak * 0.9999))

    quality_settings = settings.get("quality", {})
    max_duration_ratio = float(quality_settings.get("maxDurationRatio", 1.85))
    max_gap_ratio = float(quality_settings.get("maxGapRatio", 0.42))
    max_unexpected_gap_seconds = float(
        quality_settings.get("maxUnexpectedGapSeconds", 0.3)
    )
    accepted = (
        0.65 <= duration_ratio <= max_duration_ratio
        and gap_ratio <= max_gap_ratio
        and unexpected_gap_seconds <= max_unexpected_gap_seconds
        and clipped_ratio <= 0.001
    )
    score = (
        abs(math.log(max(duration_ratio, 1e-6))) * 2.0
        + unexpected_gap_seconds * 5.0
        + len(unexpected_gaps) * 0.35
        + max(0.0, gap_ratio - 0.30) * 8.0
        + clipped_ratio * 100.0
    )
    return {
        "accepted": accepted,
        "score": round(score, 5),
        "duration": round(duration, 3),
        "expectedDuration": round(expected_duration, 3),
        "durationRatio": round(duration_ratio, 4),
        "gapCount": len(gaps),
        "gapSeconds": round(gap_seconds, 3),
        "gapRatio": round(gap_ratio, 4),
        "unexpectedGapCount": len(unexpected_gaps),
        "unexpectedGapSeconds": round(unexpected_gap_seconds, 3),
        "clippedRatio": round(clipped_ratio, 7),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force", action="store_true", help="Regenerate and replace existing dialogue WAV files."
    )
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        help="Regenerate only the given dialogue id; may be supplied more than once.",
    )
    args = parser.parse_args()
    if not REFERENCE_PATH.exists():
        raise FileNotFoundError(f"Missing selected reference audio: {REFERENCE_PATH}")
    os.chdir(REPO)
    sys.path.insert(0, str(REPO))
    sys.path.insert(0, str(GPT_ROOT))

    from TTS_infer_pack.TTS import TTS, TTS_Config

    voice_config = json.loads(VOICE_CONFIG_PATH.read_text(encoding="utf-8"))
    all_dialogues = json.loads(DIALOGUES_PATH.read_text(encoding="utf-8"))["dialogues"]
    requested_ids = set(args.only)
    dialogues = [
        dialogue
        for dialogue in all_dialogues
        if not requested_ids or dialogue["id"] in requested_ids
    ]
    if requested_ids and len(dialogues) != len(requested_ids):
        missing_ids = requested_ids - {dialogue["id"] for dialogue in dialogues}
        raise ValueError(f"Unknown dialogue ids: {', '.join(sorted(missing_ids))}")
    profiles = voice_config["profiles"]
    settings = voice_config["tts"]

    first_profile = profiles[dialogues[0]["voiceProfile"]]
    runtime_config = {
        "custom": {
            "device": "cuda" if torch.cuda.is_available() else "cpu",
            "is_half": bool(torch.cuda.is_available()),
            "version": "v1",
            "t2s_weights_path": first_profile["gptWeights"],
            "vits_weights_path": first_profile["sovitsWeights"],
            "bert_base_path": str(PRETRAINED_DIR / "chinese-roberta-wwm-ext-large"),
            "cnhuhbert_base_path": str(PRETRAINED_DIR / "chinese-hubert-base"),
        }
    }
    pipeline = TTS(TTS_Config(runtime_config))
    active_profile = dialogues[0]["voiceProfile"]
    manifest_path = OUTPUT_DIR / "manifest.json"
    if manifest_path.exists():
        existing_entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        existing_entries = []
    manifest_by_id = {entry["id"]: entry for entry in existing_entries}

    for index, dialogue in enumerate(dialogues, start=1):
        profile_name = dialogue["voiceProfile"]
        profile = profiles[profile_name]
        output_path = ROOT / "app" / "assets" / "voice" / dialogue["file"]
        if not args.force and output_path.exists() and output_path.stat().st_size > 44:
            with wave.open(str(output_path), "rb") as existing_wav:
                sample_rate = existing_wav.getframerate()
                duration = existing_wav.getnframes() / sample_rate
            manifest_by_id[dialogue["id"]] = {
                "id": dialogue["id"],
                "profile": profile_name,
                "path": str(output_path),
                "sampleRate": sample_rate,
                "duration": round(duration, 3),
            }
            print(f"[{index}/{len(dialogues)}] 已存在，跳过：{dialogue['id']}")
            continue

        if profile_name != active_profile:
            pipeline.init_t2s_weights(profile["gptWeights"])
            pipeline.init_vits_weights(profile["sovitsWeights"])
            active_profile = profile_name

        attempts = int(settings.get("candidateAttempts", 1))
        candidates = []
        synthesis_text = dialogue.get("synthesisText", dialogue["text"])
        for attempt in range(attempts):
            seed = int(settings["seed"]) + index * 100 + attempt
            request = {
                "text": synthesis_text,
                "text_lang": settings["textLang"],
                "ref_audio_path": str(REFERENCE_PATH),
                "aux_ref_audio_paths": [],
                "prompt_text": settings.get("promptText", ""),
                "prompt_lang": settings["promptLang"],
                "top_k": settings["topK"],
                "top_p": settings["topP"],
                "temperature": settings["temperature"],
                "text_split_method": settings["textSplitMethod"],
                "batch_size": 1,
                "batch_threshold": 0.75,
                "split_bucket": bool(settings.get("splitBucket", False)),
                "speed_factor": settings["speedFactor"],
                "fragment_interval": float(settings.get("fragmentInterval", 0.08)),
                "seed": seed,
                "parallel_infer": False,
                "repetition_penalty": settings["repetitionPenalty"],
                "sample_steps": 32,
                "super_sampling": False,
                "streaming_mode": False,
                "return_fragment": False,
            }
            sample_rate, candidate_audio = next(pipeline.run(request))
            quality = analyze_audio_quality(
                synthesis_text, sample_rate, candidate_audio, settings
            )
            candidates.append((quality, seed, sample_rate, candidate_audio))
            print(
                f"[{index}/{len(dialogues)}] {dialogue['id']} candidate {attempt + 1}/{attempts} "
                f"seed={seed} duration={quality['duration']:.2f}s "
                f"gaps={quality.get('unexpectedGapCount', 0)} "
                f"accepted={quality['accepted']}"
            )

        accepted_candidates = [candidate for candidate in candidates if candidate[0]["accepted"]]
        selection_pool = accepted_candidates or candidates
        quality, selected_seed, sample_rate, audio = min(
            selection_pool, key=lambda candidate: candidate[0]["score"]
        )
        write_wav_atomic(output_path, sample_rate, audio)
        duration = len(np.asarray(audio).reshape(-1)) / sample_rate
        entry = {
            "id": dialogue["id"],
            "profile": profile_name,
            "path": str(output_path),
            "sampleRate": sample_rate,
            "duration": round(duration, 3),
            "seed": selected_seed,
            "quality": quality,
        }
        manifest_by_id[dialogue["id"]] = entry
        print(
            f"[{index}/{len(dialogues)}] selected {dialogue['id']} -> {duration:.2f}s "
            f"seed={selected_seed} accepted={quality['accepted']} score={quality['score']:.3f}"
        )

    manifest = [
        manifest_by_id[dialogue["id"]]
        for dialogue in all_dialogues
        if dialogue["id"] in manifest_by_id
    ]
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Generated {len(manifest)} dialogues in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
