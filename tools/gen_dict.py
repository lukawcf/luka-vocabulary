"""Build dict.json: Chinese meanings for words outside the built-in IELTS 3000, used when the
learner's word list comes from MaiMemo. Source: ECDICT (https://github.com/skywind3000/ECDICT,
Copyright (c) skywind3000, MIT License).

Kept: every word tagged for a common exam (zk/gk/cet4/cet6/ky/toefl/ielts/gre), plus the
TOP most frequent words by COCA/BNC rank. Meanings are shortened the same way as the built-in
list: the first two parts of speech, at most three meanings each.

Usage: python tools/gen_dict.py path/to/ecdict.csv
"""
import csv, json, re, sys

TOP = 25000
EXAMS = {"zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"}
POS = {"a.": "adj.", "ad.": "adv."}

def short(translation):
    parts = []
    for line in re.split(r"\\n|\n", translation):  # ECDICT stores line breaks as a literal \n
        line = line.strip()
        m = re.match(r"^([a-z]+\.)\s*(.+)$", line)
        if not m:
            continue
        pos, rest = POS.get(m.group(1), m.group(1)), m.group(2)
        items = [x.strip() for x in re.split(r"[,，;；]", rest) if x.strip()][:3]
        if items:
            parts.append(pos + " " + "；".join(items))
        if len(parts) == 2:
            break
    return "  ".join(parts)

def main(src):
    csv.field_size_limit(10**9)
    rows = []
    for r in csv.DictReader(open(src, encoding="utf-8")):
        w = r["word"]
        if not re.fullmatch(r"[a-z][a-z' -]*[a-z]", w):
            continue
        m = short(r["translation"])
        if not m:
            continue
        ranks = [int(x) for x in (r["frq"], r["bnc"]) if x and x != "0"]
        rank = min(ranks) if ranks else 10**9
        exam = bool(EXAMS & set(r["tag"].split()))
        rows.append((w, m, rank, exam))
    by_rank = sorted(rows, key=lambda x: x[2])
    top = {w for w, _, rank, _ in by_rank[:TOP] if rank < 10**9}
    out = {w: m for w, m, _, exam in rows if exam or w in top}
    json.dump(dict(sorted(out.items())), open("dict.json", "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(len(out), "words")

if __name__ == "__main__":
    main(sys.argv[1])
