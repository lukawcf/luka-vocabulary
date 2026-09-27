"""Generate US pronunciations for every word in the app's word list and pack them for the page.

Input : word list, one "word<TAB>meaning" per line (argv[1])
Output: argv[2]/a00.json .. a1f.json, each {"word": "<base64 mp3>", ...}
Bucketing must match audioBucket() in the page: 32-bit (h*31 + code) hash over the lowercase word, mod 32.
"""
import base64, io, json, os, sys
import soundfile as sf
from kokoro_onnx import Kokoro

AUDIO_BUCKETS = 32
HERE = os.path.dirname(os.path.abspath(__file__))

def bucket(w):
    h = 0
    for ch in w.lower():
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return format(h % AUDIO_BUCKETS, "02x")

words = [l.split("\t")[0].strip() for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
out_dir = sys.argv[2]
os.makedirs(out_dir, exist_ok=True)

kokoro = Kokoro(os.path.join(HERE, "kokoro-v1.0.onnx"), os.path.join(HERE, "voices-v1.0.bin"))
packs = {format(i, "02x"): {} for i in range(AUDIO_BUCKETS)}
total = 0
for n, w in enumerate(words, 1):
    samples, rate = kokoro.create(w, voice="am_michael", speed=1.0, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="MP3", bitrate_mode="VARIABLE", compression_level=0.6)
    data = buf.getvalue()
    total += len(data)
    packs[bucket(w)][w] = base64.b64encode(data).decode("ascii")
    if n % 250 == 0:
        print(f"{n}/{len(words)}  avg {total // n} bytes", flush=True)

for k, p in packs.items():
    with open(os.path.join(out_dir, f"a{k}.json"), "w", encoding="utf-8") as f:
        json.dump(p, f, separators=(",", ":"))
print("done", len(words), "words,", total, "bytes of mp3")
