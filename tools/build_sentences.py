"""Builds public/sentences.json (short Japanese-English sentence pairs) from the Tatoeba corpus.

Tatoeba (https://tatoeba.org) sentences are licensed CC BY 2.0 FR; the app shows the source and
links each sentence back to its Tatoeba page.

    py tools/build_sentences.py                 # downloads the exports into tools/.tatoeba/
    py tools/build_sentences.py --src DIR       # use exports you already downloaded
    py tools/build_sentences.py --per-level 800

Needed files (from https://downloads.tatoeba.org/exports/per_language/):
    jpn/jpn_sentences.tsv.bz2, eng/eng_sentences.tsv.bz2, jpn/jpn-eng_links.tsv.bz2
"""
from __future__ import annotations

import argparse
import bz2
import collections
import datetime
import json
import random
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = 'https://downloads.tatoeba.org/exports/per_language/'
FILES = {
    'jpn': 'jpn/jpn_sentences.tsv.bz2',
    'eng': 'eng/eng_sentences.tsv.bz2',
    'links': 'jpn/jpn-eng_links.tsv.bz2',
}

# level: (min words, max words, max frequency rank of the rarest word)
LEVELS = {1: (3, 6, 1500), 2: (7, 9, 3000), 3: (10, 13, 5000)}

WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
EN_OK = re.compile(r"^[A-Z][A-Za-z0-9 ,.'?!-]*[.?!]$")
JA_OK = re.compile(r"^[^A-Za-zＡ-Ｚａ-ｚ\"「」『』（）()]{4,40}[。？！?!]$")
NAMES = re.compile(r"\b(Tom|Mary|John|Alice)\b")


def fetch(src: Path) -> dict[str, Path]:
    src.mkdir(parents=True, exist_ok=True)
    paths = {}
    for key, rel in FILES.items():
        path = src / Path(rel).name
        if not path.exists():
            print(f'downloading {BASE + rel}')
            part = path.with_name(path.name + '.part')  # a cut-off download never looks finished
            urllib.request.urlretrieve(BASE + rel, part)
            part.replace(path)
        paths[key] = path
    return paths


def read_tsv(path: Path):
    with bz2.open(path, 'rt', encoding='utf-8') as f:
        for line in f:
            yield line.rstrip('\n').split('\t')


def words(en: str) -> list[str]:
    return WORD.findall(en.lower().replace('’', "'"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', type=Path, default=ROOT / 'tools' / '.tatoeba')
    ap.add_argument('--out', type=Path, default=ROOT / 'public' / 'sentences.json')
    ap.add_argument('--per-level', type=int, default=700)
    ap.add_argument('--seed', type=int, default=20261117)
    args = ap.parse_args()

    paths = fetch(args.src)
    print('reading sentences…')
    eng = {int(r[0]): r[2] for r in read_tsv(paths['eng']) if len(r) >= 3}
    jpn = {int(r[0]): r[2] for r in read_tsv(paths['jpn']) if len(r) >= 3}

    # How common each word is, counted over every English sentence on Tatoeba.
    freq = collections.Counter(w for s in eng.values() for w in words(s))
    rank = {w: i for i, (w, _) in enumerate(freq.most_common())}

    def info(en: str):
        en = en.strip()
        if not EN_OK.match(en) or '  ' in en:
            return None
        ws = words(en)
        if not ws:
            return None
        return len(ws), max(rank.get(w, 10 ** 6) for w in ws)

    pairs = collections.defaultdict(list)  # ja id -> [(en id, en)]
    for r in read_tsv(paths['links']):
        if len(r) < 2:
            continue
        ja_id, en_id = int(r[0]), int(r[1])
        if ja_id in jpn and en_id in eng:
            pairs[ja_id].append(en_id)

    by_level = collections.defaultdict(list)
    seen_en = set()
    for ja_id, en_ids in pairs.items():
        ja = jpn[ja_id].strip()
        if not JA_OK.match(ja):
            continue
        scored = []
        for en_id in en_ids:
            meta = info(eng[en_id])
            if meta:
                scored.append((meta[1], meta[0], en_id))
        if not scored:
            continue
        scored.sort()
        rarest, count, en_id = scored[0]
        en = eng[en_id].strip()
        key = ' '.join(words(en))
        if key in seen_en:
            continue
        level = next((lv for lv, (lo, hi, r) in LEVELS.items() if lo <= count <= hi and rarest <= r), None)
        if level is None:
            continue
        seen_en.add(key)
        alts = [eng[e].strip() for _, _, e in scored[1:3] if ' '.join(words(eng[e])) != key]
        by_level[level].append({'i': en_id, 'j': ja_id, 'l': level, 'e': en, 'ja': ja, **({'a': alts} if alts else {})})

    rng = random.Random(args.seed)
    items = []
    for level in sorted(by_level):
        pool = by_level[level]
        rng.shuffle(pool)
        # Tatoeba leans heavily on "Tom" and "Mary"; keep them to a small share.
        named = [p for p in pool if NAMES.search(p['e'])]
        plain = [p for p in pool if not NAMES.search(p['e'])]
        n_named = min(len(named), args.per_level // 8)
        chosen = plain[:args.per_level - n_named] + named[:n_named]
        chosen.sort(key=lambda p: (len(words(p['e'])), p['i']))
        items += chosen
        print(f'level {level}: {len(pool)} candidates, {len(chosen)} chosen')

    out = {
        'source': 'Tatoeba',
        'url': 'https://tatoeba.org',
        'license': 'CC BY 2.0 FR',
        'built': datetime.date.today().isoformat(),
        'items': items,
    }
    args.out.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {args.out} ({len(items)} pairs, {args.out.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
