"""スクリーンショットから単語エントリを読み取り、ページごとの JSON を作る。

  py tools/extract.py ../toefl3800/screens --engine claude    # 高精度（Anthropic の API キーが必要・有料）
  py tools/extract.py ../toefl3800/screens --engine windows   # 無料・オフライン（Windows 標準 OCR、精度は低め）

出力: <screens の隣>/pages/p0001.json …（読み取り済みのページは飛ばす。やり直すときは --force）
次に build_vocab.py で 1 つの vocab.json にまとめます。
"""
import argparse
import base64
import io
import json
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------- page schema

_str_list = {'type': 'array', 'items': {'type': 'string'}}
_int_or_null = {'anyOf': [{'type': 'integer'}, {'type': 'null'}]}
_sense = {
    'type': 'object',
    'properties': {
        'pos': {'type': 'string', 'description': '品詞の記号そのまま（動, 名, 形, 副, 前, 接 など）。無ければ空文字'},
        'meanings': {**_str_list, 'description': '訳語を 1 つずつ。「，」「、」「；」で区切られた訳は別要素に'},
        'pron': {'type': 'string', 'description': 'この品詞だけ発音が違うときの発音記号（[] は除く）。無ければ空文字'},
    },
    'required': ['pos', 'meanings', 'pron'], 'additionalProperties': False,
}
_word_ref = {
    'type': 'object',
    'properties': {'word': {'type': 'string'}, 'meaning': {'type': 'string', 'description': '併記された訳。無ければ空文字'}},
    'required': ['word', 'meaning'], 'additionalProperties': False,
}
_related = {
    'type': 'object',
    'properties': {'pos': {'type': 'string'}, 'word': {'type': 'string'}, 'meaning': {'type': 'string'}},
    'required': ['pos', 'word', 'meaning'], 'additionalProperties': False,
}
_example = {
    'type': 'object',
    'properties': {'en': {'type': 'string'}, 'ja': {'type': 'string', 'description': '和訳。無ければ空文字'}},
    'required': ['en', 'ja'], 'additionalProperties': False,
}
_body = {
    'senses': {'type': 'array', 'items': _sense},
    'synonyms': {'type': 'array', 'items': _word_ref},
    'antonyms': {'type': 'array', 'items': _word_ref},
    'related': {'type': 'array', 'items': _related, 'description': '派生語・関連語（品詞違いの形など）'},
    'examples': {'type': 'array', 'items': _example},
    'note': {'type': 'string', 'description': '語法・コロケーション・補足など上記に入らない記載。無ければ空文字'},
}
_entry = {
    'type': 'object',
    'properties': {
        'no': {**_int_or_null, 'description': '見出し語番号（0001 なら 1）'},
        'word': {'type': 'string'},
        'pron': {'type': 'string', 'description': '発音記号（[] は除く）。無ければ空文字'},
        'rank': {**_int_or_null, 'description': 'このページでこの語より前に見える「RANK n」見出しの n。見えなければ null'},
        'cd': {'type': 'string', 'description': 'このページでこの語より前に見える音声トラック表示「CD 1-4」の "1-4"。見えなければ空文字'},
        **_body,
    },
    'required': ['no', 'word', 'pron', 'rank', 'cd', *_body], 'additionalProperties': False,
}
PAGE_SCHEMA = {
    'type': 'object',
    'properties': {
        'kind': {'type': 'string', 'enum': ['vocab', 'other'], 'description': '単語の見出し語が載るページなら vocab'},
        'continuation': {
            'type': 'object',
            'description': 'ページ先頭が前ページから続くエントリの続きなら present=true とし、その部分をここへ',
            'properties': {
                'present': {'type': 'boolean'},
                'word': {'type': 'string', 'description': '前ページ末尾が番号だけで終わり、見出し語がこのページ先頭にあるときの見出し語。それ以外は空文字'},
                'pron': {'type': 'string'},
                **_body,
            },
            'required': ['present', 'word', 'pron', *_body], 'additionalProperties': False,
        },
        'entries': {'type': 'array', 'items': _entry},
    },
    'required': ['kind', 'continuation', 'entries'], 'additionalProperties': False,
}

SYSTEM = """あなたは日本の英単語帳（TOEFLテスト英単語3800）の電子書籍ページのスクリーンショットを、構造化データに書き起こす担当です。

画面の作り:
- 画面は左右 2 段組み。左の段を上から下へ読み、続けて右の段を上から下へ読む。
- 1 エントリは「番号（0001 など）→ 見出し語 → [発音記号] → 点線 → 品詞の四角マーク（名 動 形 副 など）付きの訳語の行」。
  品詞マークの後ろがオレンジ色の日本語なら訳語（senses）。品詞マークの後ろが英単語なら派生語（related、訳が無ければ meaning は空文字）。
  訳語の行の末尾に [発音] があれば、その品詞だけ発音が違うので sense の pron に入れる。
- 「RANK 1」の見出しと、音声トラックを示す「CD 1-4」の表示がある。CD 表示はそれ以降の語がそのトラックに収録されていることを示す。

ルール:
- ページに印刷されている内容だけを正確に書き起こす。載っていない訳語・同義語・例文を補ったり、言い換えたりしない。
- 見出し語ごとに 1 エントリ。品詞が複数あれば senses を複数に分ける。
- 同義語（＝, ≒, 類, 同 などの記号）、反意語（⇔, ↔, 反, 対 など）、派生語・関連語、例文（英文と和訳）、語法などの補足も漏れなく入れる。
- ページ（左段）の一番上が前ページから続くエントリの途中なら、その部分を continuation に入れる（見出し語から始まっていれば word/pron も）。
- ページ（右段）の一番下が番号だけ・見出し語だけで切れていても、そのエントリを entries に入れる（見えている所まで）。
- 目次・まえがき・表紙など単語の見出し語が無いページは kind="other"、entries は空にする。
- ページ上部の書名やページ番号の表示は無視する。"""


def empty_page(kind='other'):
    return {'kind': kind, 'continuation': new_entry(present=False), 'entries': []}


def new_entry(**fields):
    return {**fields, 'word': '', 'pron': '', 'senses': [], 'synonyms': [], 'antonyms': [], 'related': [], 'examples': [], 'note': ''}

# ---------------------------------------------------------------- Claude engine

FALLBACK_MODELS = {'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'}


def image_block(path):
    data = path.read_bytes()
    media = 'image/png'
    if len(data) > 4_500_000:  # API limit is 5 MB per image
        buf = io.BytesIO()
        Image.open(path).convert('RGB').save(buf, 'JPEG', quality=90)
        data, media = buf.getvalue(), 'image/jpeg'
    return {'type': 'image', 'source': {'type': 'base64', 'media_type': media, 'data': base64.standard_b64encode(data).decode()}}


def extract_claude(client, path, model, effort):
    import anthropic
    kwargs = {}
    if model in FALLBACK_MODELS:
        # On a safety decline the API retries the same request on a fallback model.
        kwargs = {'betas': ['server-side-fallback-2026-07-01'], 'fallbacks': 'default'}
    try:
        resp = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=SYSTEM,
            output_config={'effort': effort, 'format': {'type': 'json_schema', 'schema': PAGE_SCHEMA}},
            messages=[{'role': 'user', 'content': [image_block(path), {'type': 'text', 'text': 'このページを書き起こしてください。'}]}],
            **kwargs,
        )
    except anthropic.RateLimitError:
        raise
    except anthropic.APIStatusError as e:
        raise RuntimeError(f'API error {e.status_code}: {e.message}') from e
    if resp.stop_reason == 'refusal':
        raise RuntimeError('refused')
    if resp.stop_reason == 'max_tokens':
        raise RuntimeError('output cut off (max_tokens)')
    text = next(b.text for b in resp.content if b.type == 'text')
    return json.loads(text)


def run_claude(paths, out_dir, args):
    import time
    try:
        import anthropic
    except ImportError:
        sys.exit('anthropic パッケージがありません:  py -m pip install anthropic')
    client = anthropic.Anthropic(max_retries=4)

    def work(path):
        for attempt in range(5):
            try:
                return extract_claude(client, path, args.model, args.effort)
            except anthropic.RateLimitError:
                time.sleep(20 * (attempt + 1))
        raise RuntimeError('rate limited')

    done = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(work, p): p for p in paths}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                page = fut.result()
            except anthropic.AuthenticationError:
                sys.exit('API キーが無効です。ANTHROPIC_API_KEY を確認してください。')
            except Exception as e:  # keep going; the page is retried on the next run
                print(f'  {p.name}: 失敗 ({e})')
                continue
            save(out_dir, p, page, 'claude')
            done.append(p)
            print(f'  {p.name}: {len(page["entries"])} 語')
    return done

# ---------------------------------------------------------------- Windows OCR engine

CJK = '　-ヿ㐀-鿿＀-￯'
JA_RE = re.compile(f'[{CJK}]')
KANA_KANJI = re.compile('[぀-ヿ㐀-鿿]')
# Boxed marks in the book: parts of speech, plus 同 (synonyms) and 反 (antonyms).
MARKS = '名動形副前接代助間自他同反類熟派単複'
# Page furniture: the book title, page numbers, "more to go!", and Kindle's own controls ("414に戻る", "Aa").
SKIP_RE = re.compile(r'TOEFL|ページ|\d+\s*/\s*\d{3,}|訂版|音声\s*D\s*L|週目|more\s*t[o0]\s*g[o0]|に戻る|'
                     r'^Q\s*ロ?\s*(Aa)?$|^Aa$|^[くぐ<>〈〉]$|^[・•]\s*\d+$|^[\W\d\s]*%$', re.I)
DIGITS = str.maketrans({'O': '0', 'o': '0', 'D': '0', 'I': '1', 'l': '1', '|': '1', 'i': '1', 'S': '5'})
MARK_CELL = 140   # height of one enlarged mark on a mark sheet
TAIL_CELL = 170   # height of one strip right of a mark
SHEET_ROWS = 55   # per sheet (Windows OCR reads images up to 10000 px)
templates = {}  # mark -> small normalized images of marks read with confidence


def gray_of(img):
    """Max channel, so colored (orange) text stays bright; returns (array, is_dark_page)."""
    g = np.asarray(img.convert('RGB')).max(axis=2)
    return g, g.mean() < 110


def prepare(src, dst):
    """Dark text on white at 2x size, which Windows OCR reads best.
    Dark pages: max channel (keeps orange text bright), inverted, hard threshold.
    Light pages: min channel (keeps orange text dark), stretched contrast, which also keeps dakuten and 。."""
    img = Image.open(src).convert('RGB')
    g, dark = gray_of(img)
    size = (img.width * 2, img.height * 2)
    if dark:
        gray = Image.fromarray(255 - g).resize(size, Image.LANCZOS)
        gray.point(lambda v: 255 if v > 150 else (0 if v < 90 else v)).save(dst)
    else:
        gray = Image.fromarray(hide_controls(np.asarray(img).min(axis=2))).resize(size, Image.LANCZOS)
        ImageOps.autocontrast(gray, cutoff=1).save(dst)


def hide_controls(gray):
    """Kindle's reading controls stay on screen in light mode (menu bar, ‹ › page arrows, slider):
    blank the page edges where they sit. The book text never reaches them."""
    g = gray.copy()
    h, w = g.shape
    g[:75] = 255
    g[h - 95:] = 255
    if w > 1600:  # untrimmed full window
        g[:, :115] = 255
        g[:, w - 115:] = 255
    return g


def find_marks(g, dark, rgb=None):
    """Boxed marks (名, 動, 同 …): small upright rectangles whose four edges are drawn.
    Box-shaped kanji (目, 日, 国) look the same, but they are smaller and, inside meanings, orange."""
    boxes = find_boxes(g, dark)
    if not dark and rgb is not None:
        boxes += filled_boxes(rgb, boxes)
    if rgb is not None:
        def orange(b):
            reg = rgb[b['y']:b['y'] + b['h'], b['x']:b['x'] + b['w']].reshape(-1, 3).astype(np.int16)
            lit = reg[reg.max(1) > 90]
            return len(lit) and float((lit[:, 0] - lit[:, 1]).mean()) > 60
        boxes = [b for b in boxes if not orange(b)]
    if boxes:
        typical = float(np.median([b['h'] for b in boxes]))
        boxes = [b for b in boxes if b['h'] >= 0.8 * typical]
    return boxes


def filled_boxes(rgb, found=()):
    """Light pages print part-of-speech marks as gray filled boxes with a white character."""
    from scipy import ndimage
    mx, mn = rgb.max(axis=2).astype(np.int16), rgb.min(axis=2).astype(np.int16)
    lab, _ = ndimage.label((mx > 60) & (mx < 200) & (mx - mn < 30))
    boxes = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        ys, xs = sl
        h, w = ys.stop - ys.start, xs.stop - xs.start
        if 16 <= w <= 80 and 16 <= h <= 90 and 1.0 <= h / w <= 1.7 and (lab[sl] == i).mean() > 0.5                 and not any(abs(xs.start - b['x']) < 8 and abs(ys.start - b['y']) < 8 for b in found):
            boxes.append({'x': xs.start, 'y': ys.start, 'w': w, 'h': h})
    return boxes


def find_boxes(g, dark):
    from scipy import ndimage
    g = g.astype(np.int16)
    boxes = []
    for t in (40, 70, 110):  # the box border is dimmer than the text on some lines
        lab, _ = ndimage.label(g > t if dark else g < 255 - t)
        for i, sl in enumerate(ndimage.find_objects(lab), 1):
            ys, xs = sl
            h, w = ys.stop - ys.start, xs.stop - xs.start
            if not (16 <= w <= 80 and 16 <= h <= 90 and 1.12 <= h / w <= 1.7):
                continue
            comp = lab[sl] == i
            edges = (comp[:, :2].any(1).mean(), comp[:, -2:].any(1).mean(), comp[:2].any(0).mean(), comp[-2:].any(0).mean())
            if comp.mean() < 0.75 and min(edges) > 0.85 \
                    and not any(abs(xs.start - b['x']) < 8 and abs(ys.start - b['y']) < 8 for b in boxes):
                boxes.append({'x': xs.start, 'y': ys.start, 'w': w, 'h': h})
    return boxes


def mark_image(g, dark, b):
    c = g[b['y'] + 3:b['y'] + b['h'] - 3, b['x'] + 3:b['x'] + b['w'] - 3].astype(np.int16)
    ring = np.concatenate([c[:2].ravel(), c[-2:].ravel(), c[:, :2].ravel(), c[:, -2:].ravel()])
    light_char = dark or np.median(ring) < 200  # dark page, or a gray filled box: the character is the light part
    im = Image.fromarray(np.clip(255 - c if light_char else c, 0, 255).astype(np.uint8))
    return ImageOps.autocontrast(im)


def signature(im):
    a = np.asarray(im.resize((16, 20), Image.BILINEAR), dtype=np.float32)
    return (a - a.mean()) / (a.std() + 1e-6)


def classify(text, im):
    """Trust the OCR when it reads a known mark; otherwise use the closest mark seen so far."""
    sig = signature(im)
    ch = next((c for c in text if c in MARKS), '')
    if ch:
        bucket = templates.setdefault(ch, [])
        if len(bucket) < 8:
            bucket.append(sig)
        return ch
    best, score = '', 0.6
    for mark, sigs in templates.items():
        s = max(float((sig * t).mean()) for t in sigs)  # correlation
        if s > score:
            best, score = mark, s
    return best


def stack(images, cell_h):
    """One-column sheets (a grid makes Windows OCR split characters apart)."""
    sheets = []
    for s in range(0, len(images), SHEET_ROWS):
        part = images[s:s + SHEET_ROWS]
        sheet = Image.new('L', (max(im.width for im in part) + 60, cell_h * len(part) + 40), 255)
        for i, im in enumerate(part):
            sheet.paste(im, (30, 20 + i * cell_h + (cell_h - im.height) // 2))
        sheets.append(sheet)
    return sheets


def sheet_words(ocr, cell_h, offset):
    """OCR words of a one-column sheet, grouped by cell; a vertical run of characters is split up."""
    cells = {}
    for line in ocr['langs'].get('ja') or []:
        for word in line.get('words') or [line]:
            t = word['text'].replace(' ', '')
            vertical = len(t) > 1 and word['h'] > word['w'] * 1.5
            parts = [(ch, word['y'] + word['h'] * (k + 0.5) / len(t)) for k, ch in enumerate(t)] if vertical \
                else [(t, word['y'] + word['h'] / 2)]
            for text, cy in parts:
                i = offset + int((cy - 20) // cell_h)
                cells.setdefault(i, []).append({**word, 'text': text})
    return cells


def tail_image(g, dark, b, rgb=None):
    """The strip right of a mark: short meanings (a single kanji) are often missed on the full page."""
    x0 = b['x'] + b['w'] + 3  # clear of the box border, which otherwise reads as 'l'
    x1 = min(x0 + b['w'] * 14, g.shape[1] // 2 if b['x'] < g.shape[1] // 2 else g.shape[1])
    src = g if dark or rgb is None else rgb.min(axis=2)  # light page: min channel keeps orange text dark
    c = src[max(b['y'] - 4, 0):b['y'] + b['h'] + 4, x0:x1].astype(np.int16)
    im = Image.fromarray(np.clip(255 - c if dark else c, 0, 255).astype(np.uint8))
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    return im.point(lambda v: 255 if v > 150 else (0 if v < 90 else v))


def ocr_windows(paths):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        boxes, mark_ims, tail_ims = {}, [], []
        for p in paths:
            prepare(p, tmp / f'{p.stem}.png')
            img = Image.open(p).convert('RGB')
            g, dark = gray_of(img)
            boxes[p] = find_marks(g, dark, np.asarray(img))
            for b in boxes[p]:
                im = mark_image(g, dark, b)
                mark_ims.append(im.resize((max(int(im.width * 80 / im.height), 1), 80), Image.LANCZOS))
                tail_ims.append(tail_image(g, dark, b, np.asarray(img)))
        # The marks, enlarged and read on their own, are recognized far better than on the page.
        names = [p.stem for p in paths]
        mark_sheets = stack(mark_ims, MARK_CELL) if mark_ims else []
        tail_sheets = stack(tail_ims, TAIL_CELL) if tail_ims else []
        for k, sh in enumerate(mark_sheets):
            sh.save(tmp / f'_marks{k}.png')
            names.append(f'_marks{k}')
        for k, sh in enumerate(tail_sheets):
            sh.save(tmp / f'_tails{k}.png')
            names.append(f'_tails{k}')
        lst = tmp / 'list.txt'
        lst.write_text('\n'.join(str(tmp / f'{n}.png') for n in names), encoding='utf-8')
        subprocess.run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(HERE / 'winocr.ps1'),
                        '-List', str(lst), '-OutDir', str(tmp / 'ocr')], check=True, stdout=subprocess.DEVNULL)
        read = lambda name: unrotate(json.loads((tmp / 'ocr' / f'{name}.ocr.json').read_text(encoding='utf-8-sig')))
        marks, tails = {}, {}
        for k in range(len(mark_sheets)):
            marks.update(sheet_words(read(f'_marks{k}'), MARK_CELL, k * SHEET_ROWS))
        for k in range(len(tail_sheets)):
            tails.update(sheet_words(read(f'_tails{k}'), TAIL_CELL, k * SHEET_ROWS))
        flat = [b for p in paths for b in boxes[p]]
        texts = [''.join(w['text'] for w in marks.get(i, [])) for i in range(len(flat))]
        # Confident reads first, so they become templates for the marks the OCR could not read.
        for i in sorted(range(len(flat)), key=lambda i: not any(c in MARKS for c in texts[i])):
            flat[i]['mark'] = classify(texts[i], mark_ims[i]) or '?'
            flat[i]['tail'] = join_words(sorted(tails.get(i, []), key=lambda w: w['x'])).strip()
        return {p: (read(p.stem), boxes[p]) for p in paths}


def join_words(words):
    """Rebuild a line from OCR words: no spaces between Japanese characters, spaces between English words."""
    text = ''
    for w in words:
        t = w['text']
        if text and not (JA_RE.match(t[0]) or JA_RE.match(text[-1]) or t[0] in '，、,)）]］' or text[-1] in '(（[［'):
            text += ' '
        text += t
    return text


def trim_box(w, right, box_w):
    """An English word whose box starts inside a mark box read part of the box as letters ("Lsafe",
    "jjuertify"): drop the share of characters that lies over the box."""
    if w['x'] >= right - box_w * 0.2 or not re.match(r'^[A-Za-z|\[(]', w['text']) or w['w'] <= 0:
        return w
    k = max(1, int(len(w['text']) * (right - w['x']) / w['w']))
    return {**w, 'text': w['text'][k:]} if len(w['text']) - k >= 2 else w


def unrotate(ocr):
    """Windows OCR may decide the page is slightly tilted (TextAngle) and then reports boxes in the
    straightened frame; turn them back into image coordinates so they line up with the marks."""
    import math
    cx, cy = ocr['width'] / 2, ocr['height'] / 2
    for lang, lines in ocr['langs'].items():
        a = math.radians(ocr.get(f'angle_{lang}') or 0)
        if not a:
            continue
        cos, sin = math.cos(a), math.sin(a)
        for box in [b for l in lines for b in [l, *(l.get('words') or [])]]:
            x, y = box['x'] - cx, box['y'] - cy
            box['x'], box['y'] = round(cx + x * cos - y * sin), round(cy + x * sin + y * cos)
    return ocr


def merge_lines(ocr, marks=()):
    """Lines in reading order (left column, then right) built from OCR word boxes:
    English lines come from the English engine, a pronunciation after a meaning is cut off,
    and a line starting at a boxed mark gets the mark as a 〔名〕 prefix instead of the misread box."""
    ja = ocr['langs'].get('ja') or []
    en = ocr['langs'].get('en-US') or []
    mid = ocr['width'] / 2

    def same_row(a, b):
        h = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
        return h > 0.5 * min(a['h'], b['h'])

    def overlap(a, b):
        w = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
        return max(w, 0) if same_row(a, b) else 0

    rows = []
    for ln in ja or en:
        words = [dict(w) for w in (ln.get('words') or [ln])]
        col = 0 if ln['x'] + ln['w'] / 2 < mid else 1
        # The Japanese engine sometimes splits one printed line in two: put them back together.
        row = next((r for r in rows if r['col'] == col and same_row(r, ln)), None)
        if row:
            row['words'] += words
            x2 = max(row['x'] + row['w'], ln['x'] + ln['w'])
            row['x'] = min(row['x'], ln['x'])
            row['w'] = x2 - row['x']
        else:
            rows.append({'x': ln['x'], 'y': ln['y'], 'w': ln['w'], 'h': ln['h'], 'col': col, 'words': words})

    # A pronunciation printed after a meaning ("反対する [əbdʒékt]") is junk to the Japanese engine;
    # the English engine finds where it starts.
    prons = [e for e in en if e['text'].lstrip().startswith('[')]
    for r in rows:
        r['words'].sort(key=lambda w: w['x'])
        cut = min((e['x'] for e in prons if same_row(r, e) and e['x'] > r['x'] + 20), default=None)
        if cut is not None:
            r['words'] = [w for w in r['words'] if w['x'] < cut - 4] or r['words']
        r['mark'] = ''

    # Furigana above a kanji ("ちゅうちょ" over 躊躇) is a small kana-only line: not a meaning.
    ja_h = [r['h'] for r in rows if KANA_KANJI.search(join_words(r['words']))]
    if ja_h:
        small = 0.7 * float(np.median(ja_h))
        rows = [r for r in rows if not (r['h'] < small and re.fullmatch(r'[ぁ-ヿー\s]+', join_words(r['words'])))]

    for m in sorted(marks, key=lambda m: m['x']):  # mark boxes are in original pixels, OCR ran at 2x
        box = {'x': m['x'] * 2, 'y': m['y'] * 2, 'w': m['w'] * 2, 'h': m['h'] * 2}
        near = [r for r in rows if same_row(r, box) and box['x'] - 20 <= r['x'] <= box['x'] + box['w'] + 200]
        row = min(near, key=lambda r: r['x'], default=None)
        host = next((r for r in rows if same_row(r, box) and r['x'] < box['x'] - 20
                     and any(w['x'] + w['w'] / 2 > box['x'] for w in r['words'])), None)
        if row is None and host:
            # A second mark inside a line ("名 deficiency  反 sufficient"): split the line there.
            moved = [w for w in host['words'] if w['x'] + w['w'] / 2 > box['x']]
            host['words'] = [w for w in host['words'] if w not in moved]
            row = {'x': box['x'], 'y': box['y'], 'w': box['w'], 'h': box['h'], 'words': moved, 'col': host['col']}
            rows.append(row)
        if row is None:
            row = {'x': box['x'], 'y': box['y'], 'w': box['w'], 'h': box['h'], 'words': [],
                   'col': 0 if box['x'] < mid else 1}
            rows.append(row)
        right = box['x'] + box['w']
        kept = []
        for w in row['words']:
            if w['x'] + w['w'] / 2 < right:
                continue  # the box itself, read as some character
            kept.append(trim_box(w, right, box['w']))
        if not join_words(kept).strip() and m.get('tail'):
            kept = [{'text': m['tail'], 'x': right + 2, 'y': box['y'], 'w': box['w'], 'h': box['h']}]
        row['words'] = kept
        row['mark'] = m.get('mark') or '?'
        row['box_right'] = right
        row['box_w'] = box['w']

    # Headwords are printed larger than anything else in Latin letters: compare with the entry numbers.
    num_h = [r['h'] for r in rows if re.fullmatch(r'[\dOoC()\s]{4,9}', join_words(r['words']))]
    big = 1.45 * float(np.median(num_h)) if num_h else 45
    out = []
    for r in sorted(rows, key=lambda r: (r['col'], round(r['y'] / 20), r['x'])):
        text = join_words(r['words']).strip()
        if r['h'] >= big and not r['mark'] and en:
            # A large line is a headword: the English engine reads it even when the Japanese one fails ("0r1g1れ").
            best = max(en, key=lambda e: overlap(r, e), default=None)
            if best and overlap(r, best) > 0.5 * r['w'] and is_headword(best['text'].strip(), strict=False):
                text = best['text'].strip()
        latin = sum(c.isascii() and c.isalpha() for c in text) / max(len(text.replace(' ', '')), 1)
        note = re.match(r'^[*＊※]', text)  # "* Don't cry over spilt milk. は「覆水盆に返らず」": keep the Japanese
        if (not JA_RE.search(text) or latin >= 0.5) and not note and en and r['words']:  # "ofthe ⅵ跿u 00r plan仕om"
            # English text reads better from the English engine.
            best = max(en, key=lambda e: overlap(r, e), default=None)
            if best and overlap(r, best) > 0.5 * r['w']:
                x0, x1 = r['words'][0]['x'], max(w['x'] + w['w'] for w in r['words'])
                ew = [w for w in (best.get('words') or [best]) if x0 <= w['x'] + w['w'] / 2 <= x1 + 10]
                if r.get('box_right'):
                    ew = [trim_box(w, r['box_right'], r['box_w']) for w in ew if w['x'] + w['w'] / 2 >= r['box_right']]
                text = ' '.join(w['text'] for w in ew).strip() or text
        if r['mark']:
            text = f'〔{r["mark"]}〕{text}'
        elif r['h'] >= big and is_headword(text, strict=False):
            text = f'〈H〉{text}'
        if text and not SKIP_RE.search(text):
            out.append(text)
    return out


def split_words(s):
    return [w.strip(' ,;，；、') for w in re.split(r'[,;，；、]', s) if w.strip(' ,;，；、')]


def word_refs(s):
    """'assess 評価する, evaluate' -> [{word, meaning}]"""
    refs = []
    for part in split_words(s):
        m = re.match(r"^([A-Za-z][A-Za-z\-'’ .~]*?)\s*([^A-Za-z].*)?$", part)
        if m:
            refs.append({'word': m.group(1).strip(), 'meaning': (m.group(2) or '').strip()})
        elif refs:
            refs[-1]['meaning'] = (refs[-1]['meaning'] + ' ' + part).strip()
    return refs


def is_headword(s, strict=True):
    return bool(re.fullmatch(r"[A-Za-z][A-Za-z\-'’.]*(?: [A-Za-z\-'’.]+){0,3}", s)) and not (strict and s.isupper())


def fix_case(sentence):
    """OCR capitals inside words: "bOdy" -> "body", "tO" -> "to"."""
    return re.sub(r'(?<![A-Za-z])([A-Za-z])([A-Za-z]*[A-Z][A-Za-z]*)(?![A-Za-z])',
                  lambda m: m.group(0) if m.group(0).isupper() else m.group(1) + m.group(2).lower(), sentence)


def is_example_line(s):
    """An example sentence ("■ The ..."), as opposed to a garbled pronunciation line ("「d3 Å st")."""
    return bool(re.match(r'^[■□▪◼・•●]?\s*[A-Z][a-z]', s)) and len(s.split()) >= 3


def is_sentence(s):
    return len(s.split()) >= 3 and bool(re.search('[a-z]{2}', s)) and not s.lstrip().startswith(('[', '［'))


def ja_items(s):
    return [m for m in split_words(s) if JA_RE.search(m)]  # Latin-only pieces are OCR leftovers


def parse_lines(lines):
    """Best-effort parser for this book's layout. OCR mistakes remain, so check the words in the app."""
    page = empty_page('other')
    rank, cd = None, ''
    target = page['continuation']
    expect = None  # 'word' / 'pron' right after an entry number
    last_no = None

    def start(no):
        nonlocal target
        target = new_entry(no=no, rank=rank, cd=cd)
        page['entries'].append(target)
        page['kind'] = 'vocab'

    lines = [l.strip() for l in lines]
    kind = None  # 'en' / 'ja' while an example sentence or its translation may continue on the next line
    for i, s in enumerate(lines):
        prev_kind, kind = kind, None
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        fixed = re.sub('[ー−–—]', '-', s.translate(DIGITS).replace(' ', ''))
        if re.fullmatch(r'(?:\d|C\)|\(\)){4}', fixed):
            fixed = fixed.replace('C)', '0').replace('()', '0')  # a 0 read as "C)"
        headword = s.startswith('〈H〉')
        s = s.removeprefix('〈H〉')
        last = target['examples'][-1] if target['examples'] else None
        if prev_kind == 'en' and last and not re.search(r'[.?!]["”]?$', last['en'])                 and not KANA_KANJI.search(s) and not s.startswith('〔') and not re.fullmatch(r'\d{4}', fixed):
            last['en'] = fix_case(last['en'] + ' ' + s)  # the example sentence continues on the next line
            kind = 'en'
            continue
        if SKIP_RE.search(s):
            continue
        if not s.startswith('〔') and len(s) < 40 and not re.search('[,，、]', s) and re.search(r'について|多義語', s):
            target = new_entry()  # a column ("RANK2について", "多義語について"): read into nothing until the next entry
            expect = None
            continue
        if m := re.search(r'RANK(\d)', fixed, re.I):
            rank = int(m.group(1))
            continue
        if re.fullmatch(r'[ぁ-ヿー]{1,8}', s) and nxt.startswith('〔'):
            continue  # furigana printed above the kanji of the next meaning
        if m := re.fullmatch(r'.{0,3}?(?:C[0D]?)?(\d)-(\d{1,2})', fixed):  # "CD 1-4" (the CD icon reads as junk)
            cd = f'{m.group(1)}-{int(m.group(2))}'
            continue
        if re.fullmatch(r'\d{4}', fixed):
            last_no = int(fixed)
            start(last_no)
            expect = 'word'
            continue
        # A large word without its number is a headword only if a pronunciation line follows
        # (a derived form at the end of an entry can look large too).
        followed_by_pron = bool(nxt) and not nxt.startswith(('〔', '〈')) and not re.fullmatch(r'\d{4}', nxt)
        if headword and expect != 'word' and followed_by_pron \
                and not (target is page['continuation'] and not page['entries']):
            last_no = last_no + 1 if last_no else None  # the entry number was misread
            start(last_no)
            expect = 'word'
        if target is page['continuation'] and not target['word'] and not target['senses'] and is_headword(s):
            target['word'] = s  # the previous page ended right after the entry number
            expect = 'pron'
            continue
        looks_pron = nxt.startswith(('[', '［', '「')) or nxt.endswith((']', '］', '」'))
        if is_headword(s, strict=expect != 'word') and (expect == 'word' or (target is not page['continuation'] and target['senses'] and looks_pron)):
            if expect != 'word':  # the number was misread: assume it is the next one
                last_no = last_no + 1 if last_no else None
                start(last_no)
            target['word'] = s
            expect = 'pron'
            continue
        if expect == 'pron' and not s.startswith('〔') and not is_example_line(s):
            expect = None  # the pronunciation line (not kept)
            continue
        expect = None
        m = re.match(r'^〔(.)〕\s*(.*)$', s)
        pos, rest = (m.group(1), re.sub(r"^[^\w(（]+", '', m.group(2)).strip()) if m else ('', s)
        if pos in ('同', '類') or (not pos and (m := re.match(r'^[=＝≒]\s*(.+)', s)) and (rest := m.group(1))):
            target['synonyms'] += word_refs(rest)
        elif pos == '反' or (not pos and (m := re.match(r'^[⇔↔]\s*(.+)', s)) and (rest := m.group(1))):
            target['antonyms'] += word_refs(rest)
        elif pos and not rest:
            continue
        elif pos and (m := re.match(r"^([A-Za-z][A-Za-z\-' ]*[A-Za-z])\s*(.*)$", rest)):
            word, meaning = m.group(1), m.group(2).strip()
            if meaning and not JA_RE.search(meaning):  # "pr0POSe": letters misread as digits split the word
                word, meaning = (word + meaning).replace('0', 'o').replace(' ', '').lower(), ''
            head = target.get('word', '')[:3].lower()
            if head and re.match(r'^[LIl|][a-z]', word) and word[1:4].lower() == head:
                word = word[1:]  # the box's right edge read as a letter
            target['related'].append({'pos': '' if pos == '?' else pos, 'word': word, 'meaning': meaning})
        elif pos and JA_RE.search(rest):
            pos = '' if pos == '?' else pos
            pron = re.search(r'[\[［]([^\]］]*)[\]］]?\s*$', rest)
            if pron and JA_RE.search(pron.group(1)):  # brackets inside the meaning, e.g. 心［精神］の
                pron = None
            meanings = rest[:pron.start()] if pron else rest  # a trailing [pronunciation] is not kept
            meanings = re.sub(r'^[\[［][^぀-鿿(（]*', '', meanings)  # and a leading one: "[sʌ́spekt] 容疑者"
            target['senses'].append({'pos': pos, 'meanings': ja_items(meanings), 'pron': ''})
            if not re.search(r'[,，、]\s*$', meanings):
                kind = 'sense'  # a long meaning may wrap onto the next line
        elif pos:
            continue
        else:
            text = re.sub(r'^[■□▪◼・•●口\s]+', '', s)  # the bullet of example sentences
            text = re.sub(r'^[unm]\s+(?=[A-Z])', '', text)  # the bullet read as a letter by the English engine
            if re.match(r'^[*＊※]', s):
                target['note'] = '\n'.join(filter(None, [target['note'], s.lstrip('*＊※ ')]))
                continue
            last = target['examples'][-1] if target['examples'] else None
            if re.match(r'^[\[［「]', s) and re.search('[A-Za-z]', s) and not is_sentence(s):
                continue  # a pronunciation line
            if not KANA_KANJI.search(text) and is_sentence(text):
                if last is not None and prev_kind == 'en' and not re.search(r'[.?!]["”]?$', last['en']):
                    last['en'] += ' ' + text  # the sentence continues on the next line
                else:
                    target['examples'].append({'en': fix_case(text), 'ja': ''})
                kind = 'en'
            elif KANA_KANJI.search(text) and last is not None and (
                    not last['ja'] or (prev_kind == 'ja' and not last['ja'].endswith('。'))) \
                    and not re.match(r'^[*＊※]', s):  # a "* note" line is never part of the translation
                last['ja'] += text  # the translation, printed below the meaning
                kind = 'ja'
            elif target is page['continuation'] and not page['entries'] and not target['examples'] \
                    and KANA_KANJI.search(text) and (text != s or '。' in text) and not re.match(r'^[*＊※]', s):
                target['examples'].append({'en': '', 'ja': text})  # translation of the previous page's example
                kind = 'ja'
            elif KANA_KANJI.search(text) and (len(text) > 30 or '。' in text):
                pass  # prose (column, introduction): not part of an entry
            elif m := re.match(r'^([名動形副])\s*([A-Za-z][A-Za-z\-]+)$', s):
                target['related'].append({'pos': m.group(1), 'word': m.group(2), 'meaning': ''})  # box not found
            elif is_headword(s) and target['senses']:  # a derived form whose box was not read
                target['related'].append({'pos': '', 'word': s, 'meaning': ''})
            elif not KANA_KANJI.search(s):
                pass  # symbols and Latin junk only
            elif re.match(r'^[*＊▶▸・※]', s) or re.search(r'[A-Za-z]{2}', s):
                # Phrases and usage notes: "* be fond of ~ ~を好む", "larva「幼虫」と混同注意"
                target['note'] = '\n'.join(filter(None, [target['note'], s.lstrip('*＊▶▸・※ ')]))
            elif target['senses']:
                items = ja_items(s)
                last_sense = target['senses'][-1]['meanings']
                if prev_kind == 'sense' and items and last_sense and not re.match(r'^[,，、]', s):
                    last_sense[-1] += items.pop(0)  # "（政党の）幹" + "部会"
                last_sense += items
            else:
                target['senses'].append({'pos': '', 'meanings': ja_items(s), 'pron': ''})
    c = page['continuation']
    c['present'] = bool(c['word']) or any(c[k] for k in ('senses', 'synonyms', 'antonyms', 'related', 'examples'))
    return page


def run_windows(paths, out_dir, args):
    done = []
    for i in range(0, len(paths), 20):
        chunk = paths[i:i + 20]
        for p, (ocr, marks) in ocr_windows(chunk).items():
            lines = merge_lines(ocr, marks)
            page = parse_lines(lines)
            page['ocr_text'] = lines
            save(out_dir, p, page, 'windows')
            done.append(p)
            print(f'  {p.name}: {len(page["entries"])} 語')
    return done

# ---------------------------------------------------------------- main


def save(out_dir, img_path, page, engine):
    page = {'image': img_path.name, 'engine': engine, **page}
    (out_dir / f'{img_path.stem}.json').write_text(json.dumps(page, ensure_ascii=False, indent=1), encoding='utf-8')


def extract(paths, out_dir, args):
    """Extract the given screenshots; returns the paths that were saved successfully."""
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = [p for p in paths if args.force or not (out_dir / f'{p.stem}.json').exists()]
    if not todo:
        return list(paths)
    print(f'{len(todo)} ページを読み取ります（{args.engine}）')
    done = run_claude(todo, out_dir, args) if args.engine == 'claude' else run_windows(todo, out_dir, args)
    return [p for p in paths if p not in todo] + done


def add_engine_args(ap):
    ap.add_argument('--engine', choices=['claude', 'windows'], default='claude')
    ap.add_argument('--model', default='claude-opus-5-5', help='claude エンジンのモデル')
    ap.add_argument('--effort', default='medium', choices=['low', 'medium', 'high', 'xhigh', 'max'])
    ap.add_argument('--workers', type=int, default=4, help='claude エンジンの同時リクエスト数')
    ap.add_argument('--force', action='store_true', help='読み取り済みのページもやり直す')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('screens', nargs='?', default=str(HERE.parents[1] / 'toefl3800' / 'screens'))
    ap.add_argument('--out', help='既定: screens と同じ階層の pages フォルダ')
    ap.add_argument('--reparse', action='store_true',
                    help='OCR はやり直さず、windows エンジンで保存済みの文字（ocr_text）から解析だけやり直す')
    add_engine_args(ap)
    args = ap.parse_args()
    screens = Path(args.screens)
    out_dir = Path(args.out) if args.out else screens.parent / 'pages'
    if args.reparse:
        n = 0
        for f in sorted(out_dir.glob('p*.json')):
            old = json.loads(f.read_text(encoding='utf-8'))
            if 'ocr_text' in old:
                page = parse_lines(old['ocr_text'])
                page['ocr_text'] = old['ocr_text']
                f.write_text(json.dumps({'image': old['image'], 'engine': 'windows', **page}, ensure_ascii=False, indent=1),
                             encoding='utf-8')
                n += 1
        print(f'{n} ページを解析し直しました → {out_dir}')
        return
    paths = sorted(screens.glob('*.png'))
    if not paths:
        sys.exit(f'画像がありません: {screens}')
    done = extract(paths, out_dir, args)
    print(f'{len(done)} / {len(paths)} ページ完了 → {out_dir}')


if __name__ == '__main__':
    main()
