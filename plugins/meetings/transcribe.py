"""Transcribes a meeting recording. A stereo recording has you on the left channel and everyone else (the
computer's sound) on the right, so each side is transcribed on its own and the two are merged by time, which says
who said what without guessing. A mono one comes out as one voice. Prints JSON: language, duration and timed segments.

  transcribe.py <audio> [model]
  transcribe.py --serve [model]     one request per line on stdin, {"id", "file", "from", "names"}, one JSON answer
                                    per line; names are the left, right and mono speakers

Serving keeps the model loaded, so a meeting being recorded can be transcribed every few seconds from where the last
pass got to.
"""
import glob, json, os, re, subprocess, sys, tempfile, wave

# the CUDA libraries come from pip wheels inside the venv; the loader has to be told before anything imports them
if "COCKPIT_CUDA" not in os.environ:
    libs = glob.glob(os.path.join(sys.prefix, "lib", "python3*", "site-packages", "nvidia", "*", "lib"))
    env = {**os.environ, "COCKPIT_CUDA": "1", "LD_LIBRARY_PATH": ":".join(libs + [os.environ.get("LD_LIBRARY_PATH", "")])}
    os.execve(sys.executable, [sys.executable, *sys.argv], env)

from faster_whisper import WhisperModel


def channels(path):
    info = subprocess.run(["ffmpeg", "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    return 2 if re.search(r"Audio: .*\b(stereo|2 channels)\b", info) else 1


def to_wav(path, out, channel=None, start=0):
    pan = ["-af", f"pan=mono|c0=c{channel}"] if channel is not None else ["-ac", "1"]
    # a file still being written ends mid-way, which ffmpeg reports but reads up to
    subprocess.run(["ffmpeg", "-y", "-v", "quiet", "-i", path, "-ss", str(start), *pan, "-ar", "16000", out], check=False)


def load(name):
    try:
        return WhisperModel(name, device="cuda", compute_type="float16")
    except Exception as e:
        print(f"no GPU ({e}), using the CPU", file=sys.stderr)
        return WhisperModel(name, device="cpu", compute_type="int8")


# ffmpeg already made 16 kHz mono 16-bit, so the samples go straight in without another decoder
def samples(wav):
    import numpy as np
    with wave.open(wav) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def run(model, wav, speaker):
    segs, info = model.transcribe(samples(wav), vad_filter=True, beam_size=5, condition_on_previous_text=False)
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "speaker": speaker, "text": s.text.strip()} for s in segs if s.text.strip()]
    return out, info


def transcribe(model, path, start=0.0, names=("You", "Others", "")):
    """Everything said from `start` seconds on, with times from the start of the recording."""
    with tempfile.TemporaryDirectory() as tmp:
        who = [(0, names[0]), (1, names[1])] if channels(path) == 2 else [(None, names[2])]
        parts, langs, duration = [], [], start
        for ch, name in who:
            wav = os.path.join(tmp, f"{ch}.wav")
            to_wav(path, wav, ch, start)
            if not os.path.exists(wav) or os.path.getsize(wav) < 1000:
                continue
            segs, info = run(model, wav, name)
            for s in segs:
                s["start"] = round(s["start"] + start, 2)
                s["end"] = round(s["end"] + start, 2)
            parts += segs
            langs.append(info.language)
            duration = max(duration, start + info.duration)
        parts.sort(key=lambda s: s["start"])
    return {"language": langs[-1] if langs else None, "duration": round(duration, 1), "segments": parts}


def serve(model):
    for line in sys.stdin:
        req = {}
        try:
            req = json.loads(line)
            out = transcribe(model, req["file"], float(req.get("from") or 0), req.get("names") or ("You", "Others", ""))
            print(json.dumps({"id": req.get("id"), **out}), flush=True)
        except Exception as e:
            print(json.dumps({"id": req.get("id"), "error": str(e)}), flush=True)


def main():
    if sys.argv[1] == "--serve":
        serve(load(sys.argv[2] if len(sys.argv) > 2 else "large-v3-turbo"))
        return
    model = load(sys.argv[2] if len(sys.argv) > 2 else "large-v3-turbo")
    print(json.dumps(transcribe(model, sys.argv[1])))


if __name__ == "__main__":
    main()
