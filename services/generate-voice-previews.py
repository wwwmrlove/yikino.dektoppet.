from __future__ import annotations

import json
import os
import pathlib
import sys
import wave

import numpy as np
import torch


ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT / "services" / "GPT-SoVITS-main"
GPT_ROOT = REPO / "GPT_SoVITS"
VOICE_CONFIG_PATH = ROOT / "services" / "voice-config.json"
REFERENCE_PATH = ROOT / "services" / "voice-reference" / "reference.wav"
OUTPUT_DIR = ROOT / "services" / "voice-previews"
PRETRAINED_DIR = GPT_ROOT / "pretrained_models"

TEXT = "おはよう、ねむそうね、まず顔を洗ってきたら？"
PROMPT_TEXT = "それに、不信任になるようなひどい演説は、一色さんにも迷惑がかかるわ。"

VARIANTS = [
    {
        "name": "r_strong_greedy",
        "profile": "strong",
        "speed_factor": 1.00,
        "top_k": 1,
        "top_p": 1.00,
        "temperature": 1.00,
        "repetition_penalty": 1.35,
        "seed": 20260825,
    },
    {
        "name": "s_strong_seed26",
        "profile": "strong",
        "speed_factor": 1.00,
        "top_k": 5,
        "top_p": 1.00,
        "temperature": 1.00,
        "repetition_penalty": 1.35,
        "seed": 20260826,
    },
    {
        "name": "t_strong_seed27",
        "profile": "strong",
        "speed_factor": 1.00,
        "top_k": 5,
        "top_p": 1.00,
        "temperature": 1.00,
        "repetition_penalty": 1.35,
        "seed": 20260827,
    },
]


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


def main() -> None:
    os.chdir(REPO)
    sys.path.insert(0, str(REPO))
    sys.path.insert(0, str(GPT_ROOT))

    from TTS_infer_pack.TTS import TTS, TTS_Config

    voice_config = json.loads(VOICE_CONFIG_PATH.read_text(encoding="utf-8"))
    profiles = voice_config["profiles"]
    first_profile = profiles[VARIANTS[0]["profile"]]
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

    print("Loading GPT-SoVITS preview pipeline...", flush=True)
    pipeline = TTS(TTS_Config(runtime_config))
    active_profile = VARIANTS[0]["profile"]
    manifest = []

    for index, variant in enumerate(VARIANTS, start=1):
        profile_name = variant["profile"]
        profile = profiles[profile_name]
        if profile_name != active_profile:
            pipeline.init_t2s_weights(profile["gptWeights"])
            pipeline.init_vits_weights(profile["sovitsWeights"])
            active_profile = profile_name

        request = {
            "text": TEXT,
            "text_lang": "ja",
            "ref_audio_path": str(REFERENCE_PATH),
            "aux_ref_audio_paths": [],
            "prompt_text": PROMPT_TEXT,
            "prompt_lang": "ja",
            "top_k": variant["top_k"],
            "top_p": variant["top_p"],
            "temperature": variant["temperature"],
            "text_split_method": "cut0",
            "batch_size": 1,
            "batch_threshold": 0.75,
            "split_bucket": False,
            "speed_factor": variant["speed_factor"],
            "fragment_interval": 0.08,
            "seed": variant["seed"],
            "parallel_infer": False,
            "repetition_penalty": variant["repetition_penalty"],
            "sample_steps": 32,
            "super_sampling": False,
            "streaming_mode": False,
            "return_fragment": False,
        }
        print(f"[{index}/{len(VARIANTS)}] Generating {variant['name']}...", flush=True)
        sample_rate, audio = next(pipeline.run(request))
        output_path = OUTPUT_DIR / f"{variant['name']}.wav"
        write_wav(output_path, sample_rate, audio)
        duration = len(np.asarray(audio).reshape(-1)) / sample_rate
        manifest.append(
            {
                **variant,
                "text": TEXT,
                "text_split_method": "cut0",
                "fragment_interval": 0.08,
                "sample_rate": sample_rate,
                "duration": round(duration, 3),
                "path": str(output_path),
            }
        )
        print(f"[{index}/{len(VARIANTS)}] Wrote {output_path.name}: {duration:.2f}s", flush=True)

    (OUTPUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"Generated {len(manifest)} preview files in {OUTPUT_DIR}", flush=True)


if __name__ == "__main__":
    main()
