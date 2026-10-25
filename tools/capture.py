"""Kindle for PC のページを 1 枚ずつスクリーンショットして PNG で保存する（私的利用のみ）。

  py tools/capture.py
  py tools/capture.py --batch 100 --engine windows --delete

1. Kindle for PC で本を開き、最初に撮りたいページを表示しておく
2. このスクリプトを実行する。ページ送り → 撮影を繰り返し、ページが変わらなくなったら（最後のページ）止まる
   Kindle は他のウィンドウの裏にあっても撮影できる（最小化だけはしないこと）
3. 止めるときは Ctrl+C。もう一度実行すると続きの番号から保存する

--batch を付けると N 枚撮るごとに extract.py で読み取り（pages/*.json）、
--delete も付けると読み取りが済んだ画像をその場で削除する（ディスクを使い切らないように）。
"""
import argparse
import ctypes
import sys
import time
from ctypes import wintypes
from pathlib import Path

import numpy as np
from PIL import Image, ImageGrab

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # real pixels on scaled (125%, 150%) displays
except Exception:
    user32.SetProcessDPIAware()

KEYS = {'right': 0x27, 'left': 0x25, 'pagedown': 0x22, 'down': 0x28, 'space': 0x20}
WM_KEYDOWN, WM_KEYUP = 0x100, 0x101


def process_name(hwnd):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ''
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
        return Path(buf.value).name.lower()
    finally:
        kernel32.CloseHandle(h)


def window_text(hwnd):
    buf = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, buf, 512)
    return buf.value


def class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def find_kindle(title_hint=None):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd) and user32.GetWindowTextLengthW(hwnd):
            exe = process_name(hwnd)
            if exe == 'kindle.exe' or (title_hint and title_hint.lower() in window_text(hwnd).lower()):
                found.append((hwnd, window_text(hwnd), exe))
        return True

    user32.EnumWindows(cb, 0)
    found.sort(key=lambda f: f[2] != 'kindle.exe')  # the real Kindle process first
    return found[0] if found else None


def input_window(hwnd):
    """The child window that takes keyboard input (WinUI apps). Keys posted there work in the background."""
    kids = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(child, _):
        if class_name(child) == 'InputSiteWindowClass':
            kids.append(child)
        return True

    user32.EnumChildWindows(hwnd, cb, 0)
    return kids[0] if kids else hwnd


def press(target, vk):
    scan = user32.MapVirtualKeyW(vk, 0)
    ext = 1 << 24 if vk in (0x21, 0x22, 0x25, 0x26, 0x27, 0x28) else 0
    user32.PostMessageW(target, WM_KEYDOWN, vk, 1 | scan << 16 | ext)
    time.sleep(0.03)
    user32.PostMessageW(target, WM_KEYUP, vk, 1 | scan << 16 | ext | 0xC0000000)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]


def print_window(hwnd):
    """Render the window itself, so other windows on top never end up in the shot."""
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    w, h = rect.right, rect.bottom
    if w <= 0 or h <= 0:
        return None
    hdc = user32.GetDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    try:
        gdi32.SelectObject(mdc, bmp)
        if not user32.PrintWindow(hwnd, mdc, 3):  # PW_CLIENTONLY | PW_RENDERFULLCONTENT
            return None
        bi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0)
        return Image.frombuffer('RGB', (w, h), buf, 'raw', 'BGRX', 0, 1)
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mdc)
        user32.ReleaseDC(hwnd, hdc)


def grab(hwnd, crop=None):
    img = print_window(hwnd)
    if img is None or not img.getbbox():  # nothing rendered: fall back to a plain screen grab
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        pt = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(pt))
        img = ImageGrab.grab(bbox=(pt.x, pt.y, pt.x + rect.right, pt.y + rect.bottom), all_screens=True).convert('RGB')
    if crop:
        img = img.crop(crop)
    return img


def thumb(img):
    return np.asarray(img.convert('L').resize((240, 320)), dtype=np.int16)


def same(a, b, tol):
    return float(np.abs(a - b).mean()) < tol


def trim_margins(img, pad=16):
    """Drop Kindle's title/footer bars and the empty margins (works for light and dark pages)."""
    arr = np.asarray(img.convert('L'), dtype=np.int16)
    bg = np.median(arr)
    row_med = np.median(arr, axis=1)
    top = 0
    while top < len(arr) // 4 and abs(row_med[top] - bg) > 5:  # app title bar
        top += 1
    bottom = len(arr)
    while bottom > len(arr) * 3 // 4 and abs(row_med[bottom - 1] - bg) > 5:
        bottom -= 1
    ink = np.abs(arr[top:bottom] - bg) > 40
    rows, cols = np.where(ink.any(1))[0], np.where(ink.any(0))[0]
    if not len(rows) or not len(cols):
        return img
    return img.crop((max(cols[0] - pad, 0), max(top + rows[0] - pad, top),
                     min(cols[-1] + pad + 1, arr.shape[1]), min(top + rows[-1] + pad + 1, bottom)))


def wait_stable(hwnd, crop, settle):
    """Grab until two shots in a row match (page-turn animation finished)."""
    time.sleep(settle)
    prev = grab(hwnd, crop)
    for _ in range(10):
        time.sleep(0.25)
        cur = grab(hwnd, crop)
        if same(thumb(prev), thumb(cur), 0.3):
            return cur
        prev = cur
    return prev


def main():
    import extract

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=str(Path(__file__).resolve().parents[2] / 'toefl3800' / 'screens'), help='保存先フォルダ')
    ap.add_argument('--key', default='right', choices=KEYS, help='次ページへ進むキー（既定: right）')
    ap.add_argument('--delay', type=float, default=0.8, help='ページ送り後に待つ秒数')
    ap.add_argument('--max-pages', type=int, default=3000)
    ap.add_argument('--crop', help='ウィンドウ内の切り抜き範囲 "左,上,右,下"（ピクセル）')
    ap.add_argument('--no-trim', action='store_true', help='バーや余白を自動で切らない')
    ap.add_argument('--title', help='Kindle が見つからないとき、ウィンドウタイトルに含まれる文字')
    ap.add_argument('--batch', type=int, default=0, help='N 枚ごとに読み取りを実行する（0 = 撮影だけ）')
    ap.add_argument('--delete', action='store_true', help='--batch で読み取りが済んだ画像を削除する')
    extract.add_engine_args(ap)
    args = ap.parse_args()
    if args.delete and not args.batch:
        sys.exit('--delete は --batch と一緒に使ってください。')

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    crop = tuple(int(v) for v in args.crop.split(',')) if args.crop else None
    win = find_kindle(args.title)
    if not win:
        sys.exit('Kindle のウィンドウが見つかりません。Kindle for PC で本を開いてから実行してください。')
    hwnd = win[0]
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE: a minimized window renders nothing
        time.sleep(1)
    target = input_window(hwnd)
    vk = KEYS[args.key]
    print(f'ウィンドウ: {win[1]}（止めるときは Ctrl+C）')

    n = max([int(p.stem[1:]) for p in out.glob('p[0-9]*.png') if p.stem[1:].isdigit()], default=0)
    pages_dir = out.parent / 'pages'
    n = max([n] + [int(p.stem[1:]) for p in pages_dir.glob('p[0-9]*.json') if p.stem[1:].isdigit()])
    if n:
        print(f'p{n:04d} まで済んでいるので、続きの番号から保存します（Kindle は続きのページを開いておくこと）。')
    batch = []

    def flush():
        if not batch:
            return
        print()
        done = extract.extract(batch, pages_dir, args)
        if args.delete:
            for p in done:
                p.unlink(missing_ok=True)
            print(f'  読み取り済みの画像 {len(done)} 枚を削除しました。')
        if len(done) < len(batch):
            print(f'  {len(batch) - len(done)} 枚は読み取りに失敗したので残しています（あとで extract.py を再実行）。')
        batch.clear()

    last = None
    unchanged = 0
    saved = 0
    try:
        while saved < args.max_pages:
            img = wait_stable(hwnd, crop, 0 if last is None else args.delay)
            t = thumb(img)
            if last is not None and same(last, t, 0.5):
                unchanged += 1
                if unchanged >= 8:
                    print('\nページが変わらなくなったので終了します（最後のページ）。')
                    break
                time.sleep(0.5 * unchanged)  # Kindle sometimes needs a while to lay out the next page
                press(target, vk)
                continue
            unchanged = 0
            last = t
            n += 1
            saved += 1
            path = out / f'p{n:04d}.png'
            (img if args.no_trim else trim_margins(img)).save(path, optimize=True)
            print(f'  保存 {path.name}  ({saved} 枚)        ', end='\r', flush=True)
            press(target, vk)
            if args.batch:
                batch.append(path)
                if len(batch) >= args.batch:
                    flush()
    except KeyboardInterrupt:
        print('\n停止しました。')
    print(f'\n{saved} 枚を撮影しました: {out}')
    if args.batch:
        flush()


if __name__ == '__main__':
    main()
