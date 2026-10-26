"""pages/*.json（extract.py の結果）を 1 つの vocab.json にまとめる。

  py tools/build_vocab.py                     # ../toefl3800/pages → ../toefl3800/vocab.json
  py tools/build_vocab.py <pages> --out <vocab.json>

- ページをまたいだエントリをつなぎ、RANK と音声トラック（CD 1-4 など）を前のページから引き継ぐ
- 番号の抜け・重複、訳語が空の語を一覧表示する（読み取りミスの確認用）
vocab.json は教材フォルダ（mp3 と同じ場所）に置くと、アプリが自動で読み込みます。
本の内容なので、GitHub などには公開しないでください。
"""
import argparse
import difflib
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
    text = re.sub(r'(?<![ァ-ヺー])ロ(?![ァ-ヺー])', '口', text)
    # Same for ニ -> 二 ("ニ酸化炭素") and カ -> 力 after a kanji ("洞察カ").
    text = re.sub(r'(?<![ァ-ヺー])ニ(?![ァ-ヺー])', '二', text)
    text = re.sub(r'(?<=[一-鿿])カ(?![ァ-ヺー])', '力', text)
    # The other way round: kanji 工/力 starting a katakana word ("工ッセー", "力リスマ").
    text = re.sub(r'(?<![人加手大木着竣施細商化重])工(?=[ァ-ヺー])', 'エ', text)
    text = re.sub(r'力(?=[ァ-ヺ])', 'カ', text)
    text = re.sub(r'(?<=[一-鿿])ー(?=[一-鿿])', '一', text)  # long-vowel mark between kanji is 一 ("画ー性")
    text = text.replace('こっこっ', 'こつこつ').replace('しはしば', 'しばしば')
    # Usage labels: "(th。~)", "(the—)", "(通例e ~)" -> "(the ~)"; "(通例一)" -> "(通例~ s)"
    text = re.sub(r'\((通例|しばしば|ときに)?\s*(?:th[e。]|t|e|。)\s*[~〜—\-ー]\s*\)', r'(\1the ~)', text)
    text = re.sub(r'\((通例)?一\)', r'(\1~ s)', text)
    text = re.sub(r'\((通例|しばしば|ときに)?\(s\)', r'(\1~ s)', text)  # "(通例(s)資源"
    text = re.sub(r'\((通例|しばしば|ときに)\((?!s\))', r'(\1~ s) (', text)  # "(しばしば(行動などの)規範"
    text = re.sub(r'(?:(?<=[)\s])|^)ー(?=[一-鿿])', '一', text)  # "(風の)ー吹き"
    if text.count('(') > text.count(')'):  # "(通例~悲痛", "(通例資産": the "~ s)" was lost
        text = re.sub(r'\((通例|しばしば|ときに)~?\s*(?=[^\s)~])', r'(\1~ s)', text, count=1)
    # The ■ bullet in front of a translated example is read as 第.
    return re.sub(r'^第(?![一二三四五六七八九十0-9])', '', text)


# Letters Windows OCR confuses in English text ("lmpatient", "asslgned", "100k", "Siim").
# Letters Windows OCR confuses in English text ("lmpatient", "asslgned", "100k", "Siim").
OCR_SUBS = [('l', 'i'), ('i', 'l'), ('1', 'l'), ('1', 'i'), ('0', 'o'), ('rn', 'm'), ('m', 'rn'), ('cl', 'd'),
            ('ii', 'u'), ('ii', 'n'), ('ti', 'u'), ('vv', 'w'), ('c', 'e'), ('e', 'c'), ('h', 'b'),
            ('fl', 'fi'), ('f', 'fi'), ('l<', 'k'), ('m', 'ffi'), ('m', 'ff'), ('m', 'fi')]  # ffi/ff/fi ligatures read as m
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
            if not cands and len(low) >= 5:
                # two words run together ("ofthe" -> "of the"): the most common split into dictionary words
                splits = [(low[:i], low[i:]) for i in range(1, len(low)) if low[:i] in freq and low[i:] in freq
                          and (i > 1 or low[:i] in ('a', 'i'))]
                if splits:
                    cands = [' '.join(max(splits, key=lambda ab: min(freq[ab[0]], freq[ab[1]])))]
            if cands:
                best = cands[0]
                # Capitalize at the start of a sentence, or when the word was capitalized with a letter
                # that is not itself an OCR confusion ("Yoti" -> "You", but "lsland" -> "island").
                upper = first or (tok[0].isupper() and tok[0] not in 'IL')
                res = best.capitalize() if upper else best
        cache[key] = res
        return res

    def fix(sentence, sentence_case=True):
        out, first = [], sentence_case
        for part in re.split(r"([A-Za-z0-9<][A-Za-z0-9<]*)", sentence):
            if re.match(r'[A-Za-z0-9<]', part or ' '):
                fixed = fix_word(part, first)
                out.append(fixed if sentence_case or part[0].isupper() else fixed.lower())
                first = False
            else:
                out.append(part)
                if sentence_case and re.search(r'[.!?]\s*$', part):
                    first = True
        out = re.sub(r'\s*-$', '.', ''.join(out))  # a final period read as "-"
        return re.sub(r"(\w)['’]\s+(t|s|re|ve|ll|d|m)\b", r"\1'\2", out)  # "hasn' t" -> "hasn't"

    return fix


PRON_PREFIX = re.compile(r'^([^぀-ヿ㐀-鿿（(]+)(?=[぀-ヿ㐀-鿿（(])')


def strip_pron(m):
    """A misread pronunciation in front of a meaning: "kentr ékt]契約する" -> "契約する"."""
    head = PRON_PREFIX.match(m)
    if head and re.search('[A-Za-z]', head.group(1)) and re.search(r'[\]\[」:@]|[^\x00-]', head.group(1)):
        return m[head.end():]
    return m


def drop_derived_copies(entry):
    """A derived form also read as a meaning of the headword ("形 durable 耐久性のある" under duration): drop the copy."""
    rel = {m.strip() for r in entry['related'] for m in re.split('[,，、]', r.get('meaning', '')) if m.strip()}
    if len(entry['senses']) > 1 and rel:
        squash = lambda m: re.sub(r'[,，、\s]', '', m)
        rel_all = squash('|'.join(r.get('meaning', '') for r in entry['related']))
        keep = [s for s in entry['senses'] if not (s['meanings'] and all(squash(m) in rel_all for m in s['meanings']))]
        entry['senses'] = keep or entry['senses']


def unglue_note(entry):
    """A one-line note (*) right under a meaning is sometimes read as part of it: "帯水層地下水に満たされた…"."""
    note = entry['note'].strip()
    if len(note) >= 4:
        for s in entry['senses']:
            s['meanings'] = [m[:-len(note)].strip() if m.endswith(note) and len(m) > len(note) else m for m in s['meanings']]


def join_labels(meanings):
    """The "s" of a "(~ s)" label is read as a comma: ["方法(~", ")行儀"] -> ["方法", "(~ s)行儀"]."""
    out = []
    for m in meanings:
        head = re.match(r'(.*?)(\([^()]*~)\s*$', out[-1]) if out and m.startswith(')') else None
        if head:
            out[-1:] = [head[1]] if head[1] else []
            out.append(f'{head[2]} s{m}')
        else:
            out.append(m)
    return out


def clean(entry):
    # A derived-form line whose "word" is really a pronunciation is a meaning with its own pronunciation:
    # 動 [kəntrǽkt] 契約する -> read as related "kentr" / "ékt]契約する".
    for r in list(entry['related']):
        joined = f"{r['word']} {r.get('meaning', '')}"
        if re.search(r'[\]\[」]', joined) and re.search('[぀-鿿]', joined):
            meaning = strip_pron(joined)
            if meaning != joined:
                entry['senses'].append({'pos': r['pos'], 'meanings': [m for m in re.split('[,，、]', meaning) if m], 'pron': ''})
                entry['related'].remove(r)
        else:
            r['word'] = re.sub(r'\s*[\[［].*$', '', r['word'])  # "advise[advaiz]" -> "advise"
    for s in entry['senses']:
        s['meanings'] = join_labels([fix_ja(strip_pron(m)) for m in s['meanings']])
    for x in entry['examples']:
        x['ja'] = fix_ja(x.get('ja', ''))
        x['en'] = re.sub(r'(^|[.!?] )lt\b', r'\1It', x.get('en', ''))  # "lt is" -> "It is"
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
        for old, new in fix.get('replace', []):  # small text fixes anywhere in the entry: ["ロポット", "ロボット"]
            w.update(json.loads(json.dumps({k: v for k, v in w.items() if k != 'no'}, ensure_ascii=False)
                                .replace(json.dumps(old, ensure_ascii=False)[1:-1], json.dumps(new, ensure_ascii=False)[1:-1])))
        for k, v in fix.items():
            if k == 'replace':
                continue
            if k in LIST_KEYS and k != 'senses':
                v = [{'word': x, 'meaning': ''} if isinstance(x, str) else x for x in v]
            if k == 'senses':
                v = [{'pron': '', **s} for s in v]
            w[k] = v
        w['corrected'] = True
    words.sort(key=lambda w: (w['no'] is None, w['no'] or 0))
    return len(fixes)


def complete_prefix(ref, head, freq):
    """A reference word that lost its first letter or two to the mark box ("ncredible" -> "incredible")."""
    low = ref.lower()
    if not freq or len(low) < 4 or ' ' in low or low in freq:
        return ref
    cands = [p + low for p in ('i', 'in', 'un', 'di', 'de', 'ex', 'im', 'ir', 'il', 're', 'a', 'e', 'o', 'u', 'co', 'pr')
             if (p + low) in freq and (p + low) != head.lower()]
    return max(cands, key=lambda c: freq[c]) if cands else ref


def read_words(pages_dir, fix, freq=None):
    words = build(pages_dir)
    fix_refs(words)
    if fix:
        for w in words:
            if not w['word'].startswith('（'):
                w['word'] = fix(w['word'], sentence_case=False)  # "sumcient" -> "sufficient"
            for x in w['examples']:
                x['en'] = fix(x['en'])
            for k in ('synonyms', 'antonyms', 'related'):
                for r in w[k]:
                    r['word'] = complete_prefix(fix(r['word'], sentence_case=False), w['word'], freq)
    return words


JUNK = re.compile(r'[ⅰ-ⅿⅠ-ⅯÄÖÜäöüåÅæ@#^_|\{}=<>]|[A-Za-z]{1,2}\d|\d[A-Za-z]')


def make_scorer(freq):
    """How clean a piece of OCR text looks (higher is better): real English words, no junk characters."""
    def unknown(text):
        if not freq:
            return 0
        return sum(1 for t in re.findall(r"[A-Za-z][A-Za-z']+", text) if t.lower().strip("'") not in freq)

    def score(text):
        return -(unknown(text) * 2 + len(JUNK.findall(text)) * 3)
    return score


def fill_from(words, other, score=lambda t: 0):
    """Merge another reading of the same book (e.g. light and dark mode) into `words`:
    take whatever one reading missed, and wherever both read something, keep the cleaner one."""
    by_no = {w['no']: w for w in words if w['no'] is not None}
    filled = 0
    text = lambda items, *keys: ' '.join(str(x.get(k, '')) for x in items for k in keys)
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
        elif not o['word'].startswith('（') and score(o['word']) > score(w['word']):
            w['word'] = o['word']  # "sumcient" -> "sufficient"
        if not w['senses'] or all(not s['meanings'] for s in w['senses']):
            w['senses'] = o['senses']
        elif len(w['senses']) == len(o['senses']) and                 score(text(o['senses'], 'meanings')) > score(text(w['senses'], 'meanings')):
            w['senses'] = [{**t, 'pos': t['pos'] or s['pos']} for s, t in zip(w['senses'], o['senses'])]
        for s in w['senses']:
            if not s['pos']:  # take the part of speech of the other reading's sense with the same meaning
                match = next((t for t in o['senses'] if t['pos'] and set(t['meanings']) & set(s['meanings'])), None)
                if match:
                    s['pos'] = match['pos']
        if not w['examples']:
            w['examples'] = o['examples']
        elif len(w['examples']) == len(o['examples']):
            for x, y in zip(w['examples'], o['examples']):
                if y['en'] and score(y['en']) > score(x['en']):
                    x['en'] = y['en']
                if not x['ja'] or (y['ja'] and score(y['ja']) > score(x['ja'])):
                    x['ja'] = y['ja'] or x['ja']
        for x in w['examples']:
            if not x['ja']:
                same = next((y for y in o['examples'] if y['ja'] and y['en'][:12].lower() == x['en'][:12].lower()), None)
                if same:
                    x['ja'] = same['ja']
        for k in ('synonyms', 'antonyms', 'related'):
            if not w[k] or (o[k] and score(text(o[k], 'word', 'meaning')) > score(text(w[k], 'word', 'meaning'))):
                w[k] = o[k]  # "ncredible" -> "incredible"
        if not w['note'] or (o['note'] and score(o['note']) > score(w['note'])):
            w['note'] = o['note'] or w['note']
        for k in ('rank', 'cd'):
            if not w.get(k) and o.get(k):
                w[k] = o[k]
        filled += json.dumps(w, ensure_ascii=False) != before
    words.sort(key=lambda w: (w['no'] is None, w['no'] or 0))
    return filled


def make_ja_cost():
    """How unnatural a piece of Japanese is (MeCab path cost; lower is better), or None without MeCab.
    "野ウサキ" costs far more than "野ウサギ", "合六石亠" far more than "溶岩"."""
    try:
        import MeCab
        import unidic_lite
    except ImportError:
        print('MeCab がないので訳語の読み比べを省きます（py -m pip install mecab-python3 unidic-lite）')
        return None
    tagger = MeCab.Tagger('-d "%s"' % unidic_lite.DICDIR.replace('\\', '/'))

    def cost(text):
        node, last = tagger.parseToNode(text), None
        while node:
            last, node = node, node.next
        return last.cost
    return cost


def pick_japanese(words, other, cost):
    """Each reading misreads different Japanese ("ウサキ" in light mode, "ずぷぬれ" in dark mode):
    for every meaning, translation and note, keep whichever reading reads as more natural Japanese."""
    by_no = {o['no']: o for o in other if o['no'] is not None}
    bare = lambda t: re.sub(r'[\s,，、.。・/()（）~〜\-—A-Za-z\[\]]', '', t)
    length = lambda t: len(re.sub(r'[\s,，、]', '', t))
    balanced = lambda t: t.count('(') == t.count(')')
    plain = lambda t: re.sub(r'[\s\[\]()~〜A-Za-z\-]', '', t)
    junk = lambda t: cost(plain(t) or t) > 6500 * max(1, len(plain(t)))  # "合六石亠", "腫しゅ瘍よっ"

    def better(mine, theirs, similar=True, others=(), sentence=False):
        if not theirs or mine == theirs or not balanced(theirs) or theirs.count(mine) > 1 or theirs in others:
            return mine
        if re.fullmatch(r'[ぁ-ヺー]', theirs):  # "カ" for "力"
            return mine
        # A reading that dropped characters ("お仕事" for "お役所仕事", "瘍" for "胃潰瘍") or says something
        # else ("主要な" for "専攻科目") only wins over garbage.
        if (length(theirs) < length(mine) or not similar) and (not junk(mine) or theirs in mine):
            return mine
        # Commas cost something too; a reading is not better just for having lost one.
        # Small cost differences in a long sentence mean nothing ("テータ" can come out cheaper than "データ").
        words_only = lambda t: re.sub(r'[\s,，、。.!！?？・]', '', t)
        if words_only(theirs) == words_only(mine):
            return mine
        margin = 2000 + 300 * len(words_only(mine)) if sentence else 0
        return theirs if cost(words_only(theirs)) + margin < cost(words_only(mine)) else mine

    changed = 0
    for w in words:
        o = by_no.get(w['no'])
        if not o:
            continue
        before = json.dumps(w, ensure_ascii=False)
        theirs = [m for s in o['senses'] for m in s['meanings']]
        for s in w['senses']:
            out = []
            for m in s['meanings']:
                # Two meanings read as one ("支出経費") that the other reading kept apart ("支出", "(~ s)経費").
                split = next((theirs[i:j] for i in range(len(theirs)) for j in range(i + 2, len(theirs) + 1)
                              if bare(''.join(theirs[i:j])) == bare(m)
                              and all(bare(t) and balanced(t) for t in theirs[i:j])), None)
                out += split or [m]
            s['meanings'] = out
        mine = [(s, i) for s in w['senses'] for i in range(len(s['meanings']))]
        ratio = lambda a, b: difflib.SequenceMatcher(None, a, b).ratio()
        if len(mine) == len(theirs):
            pairs = [(s, i, t) for (s, i), t in zip(mine, theirs)]
        else:
            pairs = []
            for s, i in mine:
                t = max(theirs, key=lambda t: ratio(s['meanings'][i], t), default='')
                if t and ratio(s['meanings'][i], t) >= 0.5:
                    pairs.append((s, i, t))
        for s, i, t in pairs:
            s['meanings'][i] = better(s['meanings'][i], t, ratio(s['meanings'][i], t) >= 0.5,
                                      [m for u in w['senses'] for m in u['meanings']])
        if len(w['examples']) == len(o['examples']):
            for x, y in zip(w['examples'], o['examples']):
                if x['ja'] and y['ja'] and difflib.SequenceMatcher(None, x['ja'], y['ja']).ratio() >= 0.6:
                    x['ja'] = better(x['ja'], y['ja'], sentence=True)
        if w['note'] and o['note'] and not re.search('[A-Za-z]', w['note'] + o['note']) \
                and difflib.SequenceMatcher(None, w['note'], o['note']).ratio() >= 0.6:
            w['note'] = better(w['note'], o['note'])
        for k in ('synonyms', 'antonyms', 'related'):
            for x in w[k]:
                y = next((y for y in o[k] if y['word'].lower() == x['word'].lower()), None)
                if y and x.get('meaning') and y.get('meaning'):
                    x['meaning'] = better(x['meaning'], y['meaning'])
        changed += json.dumps(w, ensure_ascii=False) != before
    return changed


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
    words = read_words(pages_dir, fix, freq)
    if args.fallback:
        other = read_words(Path(args.fallback), fix, freq)
        n = fill_from(words, other, make_scorer(freq))
        print(f'{n} 語を {args.fallback} の読み取りで補いました')
        if cost := make_ja_cost():
            print(f'{pick_japanese(words, other, cost)} 語の訳を読み比べて直しました')
    corrections = Path(args.corrections) if args.corrections else pages_dir.parent / 'corrections.json'
    if n := apply_corrections(words, corrections):
        print(f'手での修正 {n} 件を反映しました（{corrections.name}）')
    for w in words:
        drop_derived_copies(w)
        unglue_note(w)
    for prev, w in zip(words, words[1:]):  # a word nobody read the RANK of sits in its neighbour's RANK
        w['rank'] = w.get('rank') or prev.get('rank')
    report(words)
    out = Path(args.out) if args.out else pages_dir.parent / 'vocab.json'
    data = {'book': args.book, 'version': 1, 'generated': date.today().isoformat(), 'words': words}
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'→ {out}（{out.stat().st_size // 1024} KB）')


if __name__ == '__main__':
    main()
