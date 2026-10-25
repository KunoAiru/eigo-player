"""pages/*.json（extract.py の結果）を 1 つの vocab.json にまとめる。

  py tools/build_vocab.py                     # ../toefl3800/pages → ../toefl3800/vocab.json
  py tools/build_vocab.py <pages> --out <vocab.json>

- ページをまたいだエントリをつなぎ、RANK と音声トラック（CD 1-4 など）を前のページから引き継ぐ
- 番号の抜け・重複、訳語が空の語を一覧表示する（読み取りミスの確認用）
vocab.json は教材フォルダ（mp3 と同じ場所）に置くと、アプリが自動で読み込みます。
本の内容なので、GitHub などには公開しないでください。
"""
import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIST_KEYS = ('senses', 'synonyms', 'antonyms', 'related', 'examples')


def merge_into(entry, part):
    for k in ('word', 'pron'):
        if part.get(k) and not entry.get(k):
            entry[k] = part[k]
    examples = list(part.get('examples', []))
    if examples and not examples[0].get('en') and entry.get('examples') and not entry['examples'][-1].get('ja'):
        # The translation of the last example was printed at the top of the next page.
        entry['examples'][-1] = {**entry['examples'][-1], 'ja': examples.pop(0)['ja']}
    part = {**part, 'examples': examples}
    for k in LIST_KEYS:
        entry[k] = entry.get(k, []) + part.get(k, [])
    if part.get('note'):
        entry['note'] = '\n'.join(filter(None, [entry.get('note', ''), part['note']]))


SPLIT_KANJI = [  # Windows OCR reads 言-radical kanji as two pieces: 語 -> "三ロ-五ロ"
    (r'三[ロ口][-一ー]?五[ロ口]', '語'), (r'三[ロ口][-一ー]?舌', '話'), (r'三[ロ口][-一ー]?士[ロ口]', '詰'),
]


def fix_ja(text):
    for pat, rep in SPLIT_KANJI:
        text = re.sub(pat, rep, text)
    # Katakana ロ next to a kanji is the kanji 口 ("ロ笛" -> "口笛"), unless it is part of a katakana word.
    return re.sub(r'(?<![ァ-ヺー])ロ(?![ァ-ヺー])', '口', text)


# Letters Windows OCR confuses in English text ("lmpatient", "asslgned", "100k", "Siim").
# Letters Windows OCR confuses in English text ("lmpatient", "asslgned", "100k", "Siim").
OCR_SUBS = [('l', 'i'), ('i', 'l'), ('1', 'l'), ('1', 'i'), ('0', 'o'), ('rn', 'm'), ('m', 'rn'), ('cl', 'd'),
            ('ii', 'u'), ('ii', 'n'), ('ti', 'u'), ('vv', 'w'), ('c', 'e'), ('e', 'c'), ('h', 'b'),
            ('fl', 'fi'), ('f', 'fi'), ('l<', 'k')]
CONFUSABLE = set('il10')


def english_words():
    """An English word-frequency list (pip install pyspellchecker); without it English is left as read."""
    try:
        from spellchecker import SpellChecker
    except ImportError:
        print('（pyspellchecker が無いので、英文のつづりの自動修正は行いません）')
        return None
    return SpellChecker().word_frequency


def make_english_fixer(freq):
    cache = {}

    def candidates(word, depth):
        """Dictionary words reachable by OCR substitutions, best first: frequent words, few edits,
        same length ("Siim" -> "slim" rather than "sum", "AII" -> "all", "IIS" -> "us")."""
        scores = {}
        frontier = {word}
        for d in range(1, depth + 1):
            nxt = set()
            for w in frontier:
                for a, b in OCR_SUBS:
                    i = w.find(a)
                    while i >= 0:
                        nxt.add(w[:i] + b + w[i + len(a):])
                        i = w.find(a, i + 1)
            for v in nxt:
                if v in freq and v not in scores:
                    scores[v] = freq[v] * (0.01 if len(v) != len(word) else 1) * 0.1 ** (d - 1)
            frontier = nxt
        return sorted(scores, key=scores.get, reverse=True)

    def fix_word(tok, first):
        key = (tok, first)
        if key in cache:
            return cache[key]
        low = tok.lower()
        res = tok
        acronym = tok.isupper() and not CONFUSABLE & set(low)  # "ABC", "CEO"
        if re.search('[a-z]', low) and low not in freq and len(low) > 2 and not acronym:
            cands = candidates(low, 3 if re.search(r'\d', low) else 2)
            if cands:
                best = cands[0]
                # Capitalize at the start of a sentence, or when the word was capitalized with a letter
                # that is not itself an OCR confusion ("Yoti" -> "You", but "lsland" -> "island").
                upper = first or (tok[0].isupper() and tok[0] not in 'IL')
                res = best.capitalize() if upper else best
        cache[key] = res
        return res

    def fix(sentence):
        out, first = [], True
        for part in re.split(r"([A-Za-z0-9<][A-Za-z0-9<]*)", sentence):
            if re.match(r'[A-Za-z0-9<]', part or ' '):
                out.append(fix_word(part, first))
                first = False
            else:
                out.append(part)
                if re.search(r'[.!?]\s*$', part):
                    first = True
        return re.sub(r'\s*-$', '.', ''.join(out))  # a final period read as "-"

    return fix


def clean(entry):
    for s in entry['senses']:
        s['meanings'] = [fix_ja(m) for m in s['meanings']]
    for x in entry['examples']:
        x['ja'] = fix_ja(x.get('ja', ''))
        x['en'] = re.sub(r'(^|[.!?] )lt', r'It', x.get('en', ''))  # "lt is" -> "It is"
    for k in ('synonyms', 'antonyms', 'related'):
        for x in entry[k]:
            x['meaning'] = fix_ja(x.get('meaning', ''))
    entry['note'] = fix_ja(entry.get('note', ''))
    for s in entry['senses']:
        s['meanings'] = [m.strip() for m in s['meanings'] if m.strip()]
    entry['senses'] = [s for s in entry['senses'] if s['meanings']]
    for k in ('synonyms', 'antonyms'):
        entry[k] = [x for x in entry[k] if x.get('word', '').strip()]
    # An English sentence has real words; garbled pronunciation lines ("「d3 Å st") do not.
    entry['examples'] = [x for x in entry['examples']
                         if len(re.findall(r'[A-Za-z]{2,}', x.get('en', ''))) >= 3 and not re.search('[぀-鿿]', x['en'])
                         and re.match(r'^["“‘(]?[A-Z0-9]', x['en'])]  # a sentence starts with a capital, a note line does not
    entry['word'] = re.sub(r'\s+', ' ', entry['word']).strip()
    return entry


def build(pages_dir):
    words = []
    seen = set()
    rank, cd = None, ''
    for path in sorted(pages_dir.glob('p*.json')):
        page = json.loads(path.read_text(encoding='utf-8'))
        cont = page.get('continuation') or {}
        if cont.get('present') and words:
            merge_into(words[-1], cont)
        for e in page.get('entries', []):
            rank = e.get('rank') or rank
            cd = e.get('cd') or cd
            prev = words[-1] if words else None
            if e.get('no') is None and prev and not e.get('word'):
                merge_into(prev, e)
                continue
            if prev and e.get('no') is not None and e['no'] == prev.get('no'):
                merge_into(prev, e)  # the same entry cut at a column or page break
                continue
            if e.get('no') is not None and e['no'] in seen:
                continue  # e.g. an index at the back of the book repeating the numbers
            seen.add(e.get('no'))
            words.append({
                'no': e.get('no'), 'word': e.get('word', ''), 'pron': e.get('pron', ''),
                'rank': rank, 'cd': cd,
                **{k: list(e.get(k, [])) for k in LIST_KEYS}, 'note': e.get('note', ''),
                'page': page.get('image', path.stem),
            })
    for w in words:
        if not w.get('word') and w['senses']:
            w['word'] = '（見出し語を読み取れず）'  # keep the meanings; the number still links it to its track
    words = [clean(w) for w in words if w.get('word')]
    # Missing numbers: fill from the neighbours so every word can still be linked to a track.
    for i, w in enumerate(words):
        if w['no'] is None and i and words[i - 1]['no'] is not None:
            w['no'] = words[i - 1]['no'] + 1
    return words


def common_prefix(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


def fix_refs(words):
    """Derived forms and synonyms often start with a letter that is really the edge of the mark box
    ("lformal") or lost their first letter ("ubtraction"). Check them against the book's own words."""
    known = {w['word'].lower() for w in words}
    for w in words:
        for x in w['examples']:
            known.update(t.lower() for t in re.findall(r"[A-Za-z][A-Za-z\-']+", x['en']))

    def fix(ref, head):
        r = ref.strip()
        if not r or ' ' in r or r.lower() in known:
            return r
        for a, b in (('fl', 'fi'), ('fi', 'fl'), ('rn', 'm'), ('0', 'o'), ('1', 'l'), ('ii', 'ü')):
            c = r.replace(a, b)  # letters OCR commonly confuses
            if c != r and c.lower() in known:
                return c
        junk = 'lIij|1'
        cands = []
        if r[0] in junk:
            cands.append(r[1:])
            if len(r) > 1 and r[1] in junk:
                cands.append(r[2:])
        for c in cands:
            if len(c) > 2 and c.lower() in known and c.lower() != head:
                return c
        if head:  # a derived form shares its stem with the headword: "ubtraction" -> "subtraction"
            for c in [head[0] + x for x in [r] + cands]:
                if common_prefix(c.lower(), head) >= 4:
                    return c
        # English words do not start with "lf", "ld", "jj"…: the first letter is the box edge.
        while len(r) > 3 and (r[0] in 'I|1j' or (r[0] in 'li' and r[1].lower() not in 'aeiouyl')):
            r = r[1:]
        return r

    for w in words:
        head = w['word'].lower()
        for r in w['related']:
            r['word'] = fix(r['word'], head)
        for k in ('synonyms', 'antonyms'):
            for r in w[k]:
                r['word'] = fix(r['word'], '')
                if r['word'].lower() == head:
                    r['word'] = ''
            w[k] = [r for r in w[k] if len(r['word']) > 1]


def report(words):
    nos = [w['no'] for w in words if w['no'] is not None]
    seen, dup = set(), []
    for n in nos:
        if n in seen:
            dup.append(n)
        seen.add(n)
    gaps = sorted(set(range(min(nos), max(nos) + 1)) - seen) if nos else []
    print(f'単語数: {len(words)}（番号 {min(nos, default=0)}〜{max(nos, default=0)}）')
    by_cd = {}
    for w in words:
        by_cd[w['cd'] or '?'] = by_cd.get(w['cd'] or '?', 0) + 1
    print('トラックごとの語数: ' + ', '.join(f'CD{k}:{v}' for k, v in by_cd.items()))
    if gaps:
        print(f'番号の抜け ({len(gaps)}): {short(gaps)}')
    if dup:
        print(f'番号の重複 ({len(dup)}): {short(dup)}')
    empty = [f"{w['no']} {w['word']}" for w in words if not w['senses']]
    if empty:
        print(f'訳語が読み取れなかった語 ({len(empty)}): {short(empty)}')


def short(items, n=30):
    items = [str(x) for x in items]
    return ', '.join(items[:n]) + (f' …ほか {len(items) - n}' if len(items) > n else '')


def apply_corrections(words, path):
    """Hand-made fixes, kept apart from the OCR output so re-reading never loses them.
    corrections.json: {"0247": {"senses": [...]}, "1002": {"word": ..., ...}, "0956": {"delete": true}}
    Each listed field replaces the read one; a number that was not read becomes a new entry."""
    if not path.exists():
        return 0
    fixes = json.loads(path.read_text(encoding='utf-8'))
    by_no = {w['no']: w for w in words}
    for key, fix in fixes.items():
        if key.startswith('_'):
            continue  # comments
        no = int(key)
        if fix.get('delete'):
            words[:] = [w for w in words if w['no'] != no]
            continue
        w = by_no.get(no)
        if w is None:
            prev = max((x for x in words if x['no'] is not None and x['no'] < no), key=lambda x: x['no'], default={})
            w = {'no': no, 'word': '', 'pron': '', 'rank': prev.get('rank'), 'cd': prev.get('cd', ''),
                 **{k: [] for k in LIST_KEYS}, 'note': '', 'page': prev.get('page', '')}
            words.append(w)
        for k, v in fix.items():
            if k in LIST_KEYS and k != 'senses':
                v = [{'word': x, 'meaning': ''} if isinstance(x, str) else x for x in v]
            if k == 'senses':
                v = [{'pron': '', **s} for s in v]
            w[k] = v
        w['corrected'] = True
    words.sort(key=lambda w: (w['no'] is None, w['no'] or 0))
    return len(fixes)


def read_words(pages_dir, fix):
    words = build(pages_dir)
    fix_refs(words)
    if fix:
        for w in words:
            for x in w['examples']:
                x['en'] = fix(x['en'])
            for k in ('synonyms', 'antonyms', 'related'):
                for r in w[k]:
                    r['word'] = fix(r['word'])
    return words


def fill_from(words, other):
    """Fill what one reading missed from another reading of the same book (e.g. light and dark mode):
    whole entries, unread headwords, meanings, parts of speech, examples, translations, references."""
    by_no = {w['no']: w for w in words if w['no'] is not None}
    filled = 0
    for o in other:
        w = by_no.get(o['no'])
        if w is None:
            words.append(o)
            filled += 1
            continue
        before = json.dumps(w, ensure_ascii=False)
        if w['word'].startswith('（') and not o['word'].startswith('（'):
            w['word'] = o['word']
        squash = lambda t: re.sub(r'\s', '', t).lower()
        if squash(w['word']) == squash(o['word']) and o['word'].count(' ') < w['word'].count(' '):
            w['word'] = o['word']  # "a Chi eve" -> "achieve"
        if not w['senses'] or all(not s['meanings'] for s in w['senses']):
            w['senses'] = o['senses']
        for s in w['senses']:
            if not s['pos']:  # take the part of speech of the other reading's sense with the same meaning
                match = next((t for t in o['senses'] if t['pos'] and set(t['meanings']) & set(s['meanings'])), None)
                if match:
                    s['pos'] = match['pos']
        if not w['examples']:
            w['examples'] = o['examples']
        for x in w['examples']:
            if not x['ja']:
                same = next((y for y in o['examples'] if y['ja'] and y['en'][:12].lower() == x['en'][:12].lower()), None)
                if same:
                    x['ja'] = same['ja']
        for k in ('synonyms', 'antonyms', 'related'):
            if not w[k]:
                w[k] = o[k]
        if not w['note']:
            w['note'] = o['note']
        for k in ('rank', 'cd'):
            if not w.get(k) and o.get(k):
                w[k] = o[k]
        filled += json.dumps(w, ensure_ascii=False) != before
    words.sort(key=lambda w: (w['no'] is None, w['no'] or 0))
    return filled


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pages', nargs='?', default=str(HERE.parents[1] / 'toefl3800' / 'pages'))
    ap.add_argument('--out', help='既定: pages と同じ階層の vocab.json')
    ap.add_argument('--corrections', help='手で直した内容（既定: pages と同じ階層の corrections.json）')
    ap.add_argument('--fallback', help='別に撮った読み取り結果（pages フォルダ）。読めなかった所をそこから補う')
    ap.add_argument('--book', default='TOEFLテスト英単語3800', help='教材名（mp3 のアルバム名と同じにする）')
    args = ap.parse_args()
    pages_dir = Path(args.pages)
    if not any(pages_dir.glob('p*.json')):
        sys.exit(f'ページの JSON がありません: {pages_dir}')
    freq = english_words()
    fix = make_english_fixer(freq) if freq else None
    words = read_words(pages_dir, fix)
    if args.fallback:
        n = fill_from(words, read_words(Path(args.fallback), fix))
        print(f'{n} 語を {args.fallback} の読み取りで補いました')
    corrections = Path(args.corrections) if args.corrections else pages_dir.parent / 'corrections.json'
    if n := apply_corrections(words, corrections):
        print(f'手での修正 {n} 件を反映しました（{corrections.name}）')
    for prev, w in zip(words, words[1:]):  # a word nobody read the RANK of sits in its neighbour's RANK
        w['rank'] = w.get('rank') or prev.get('rank')
    report(words)
    out = Path(args.out) if args.out else pages_dir.parent / 'vocab.json'
    data = {'book': args.book, 'version': 1, 'generated': date.today().isoformat(), 'words': words}
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'→ {out}（{out.stat().st_size // 1024} KB）')


if __name__ == '__main__':
    main()
