#!/usr/bin/env python3
"""
递归把 LoRA 目录下的预览图转成 WebP（优先用 cwebp）。

背景
----
WeiLin 的 `lorainfo/api/loras/img` 直接返回 LoRA 同名的原始预览图。
实测 290 个 LoRA 的预览图约 **870 MB**（平均 3 MB，76% 是 PNG，最大 10.3 MB），
网页列表里加载代价极高。缩到最长边 512 并转 WebP 后，单张约 30~60 KB。

⚠️ 为什么必须删掉原图
--------------------
WeiLin 的查找顺序是 ---------- jpg → png → jpeg → gif → webp（见 prompt_server.py）。
只要旧的 `foo.png` 还在，新写的 `foo.webp` **永远不会被使用**。
所以本脚本对每个基名只保留一个 `.webp`，其余变体全部删除（默认先备份）。

「未处理」的识别
----------------
WeiLin 上传新预览图时（`lorainfo/api/loras/set/img`）会**先删掉该 LoRA 已有的
全部预览图（含 `.webp`）**，再按**上传文件自身的扩展名**写入
（`model + file_extension`）。Civitai 的图片多为 `.jpeg`，所以新增的 LoRA
通常表现为一个 `.jpeg`。

于是在本脚本的约定下：**`.webp` = 已处理，其它扩展名 = 新增/未处理**。
跑一次干跑即可看到「按扩展名」的统计。

用法
----
    # 干跑，看看会改什么（默认）
    python resize_lora_previews.py --root "D:/comfyui/ComfyUI/models/loras"

    # 确认后执行（原图备份到 _preview_backup/）
    python resize_lora_previews.py --root "..." --apply

    # 不备份（不打算回滚时）
    python resize_lora_previews.py --root "..." --apply --no-backup

编码后端
--------
1. `cwebp`（libwebp 命令行，PATH 里能找到就用）—— 快
2. Pillow（ComfyUI 自带）—— 回退，也用于 cwebp 不支持的格式

图像尺寸由脚本自己解析文件头得出，因此**不依赖 Pillow 也能正确缩放**。
"""

from __future__ import annotations

import argparse
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

# WeiLin 的查找顺序：prompt_server.py:200
#     for ext in ["jpg", "png", "jpeg", "gif", "webp"]
# 数字越小越优先被采用。**必须与之一致**，否则脚本会选错源图。
WEILIN_ORDER = {".jpg": 0, ".png": 1, ".jpeg": 2, ".gif": 3, ".webp": 4}
# 额外考虑进来的图片格式（WeiLin 不认，但同目录下也可以清掉）
EXTRA_EXTS = {".bmp": 5, ".tif": 6, ".tiff": 7}
IMAGE_EXTS = set(WEILIN_ORDER) | set(EXTRA_EXTS)

# 备份目录名：扫描时跳过
BACKUP_DIR_NAME = "_preview_backup"


# ---------------------------------------------------------------------------
# 图像头部解析（不依赖任何第三方库）
# ---------------------------------------------------------------------------

def image_size(path: Path) -> tuple[int, int] | None:
    """读取宽高；失败返回 None。

    所有支持的格式，关键字段都落在前 32 字节内：
      PNG  IHDR 宽高 @16..24
      GIF  宽高 @6..10（小端）
      BMP  宽高 @18..26（小端，高可为负）
      WEBP 子块 @12..16，其后：
           VP8X 宽-1 @24..27，高-1 @27..30
           VP8  起始码 @23..26，宽 @26..28，高 @28..30（小端 14 位）
           VP8L 签名 0x2F @20，位域 @21..25（14+14 位小端）
    """
    try:
        with path.open("rb") as f:
            head = f.read(40)
        if len(head) < 30:
            return None

        # PNG: 8 字节签名 + 4 长度 + 4 'IHDR' + 宽(4) + 高(4)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            w, h = struct.unpack(">II", head[16:24])
            return int(w), int(h)

        # GIF: 'GIF87a'/'GIF89a' + 宽(2,小端) + 高(2,小端)
        if head[:6] in (b"GIF87a", b"GIF89a"):
            w, h = struct.unpack("<HH", head[6:10])
            return int(w), int(h)

        # BMP
        if head[:2] == b"BM":
            w, h = struct.unpack("<ii", head[18:26])
            return abs(int(w)), abs(int(h))

        # WebP: 'RIFF' + size(4) + 'WEBP' + 子块 fourcc @12..16
        if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            fourcc = head[12:16]
            if fourcc == b"VP8X":
                w = 1 + int.from_bytes(head[24:27], "little")
                h = 1 + int.from_bytes(head[27:30], "little")
                return w, h
            if fourcc == b"VP8 ":
                # 帧标签(3) + 起始码(3) 之后才是宽高
                if head[23:26] != b"\x9d\x01\x2a":
                    return None
                w = int.from_bytes(head[26:28], "little") & 0x3FFF
                h = int.from_bytes(head[28:30], "little") & 0x3FFF
                return w, h
            if fourcc == b"VP8L":
                if head[20] != 0x2F:
                    return None
                bits = int.from_bytes(head[21:25], "little")
                return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            return None

        # JPEG: 逐段扫描 SOFn
        if head[:2] == b"\xff\xd8":
            with path.open("rb") as f:
                f.seek(2)
                while True:
                    marker = f.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    code = marker[1]
                    if code in (0xD8, 0xD9) or 0xD0 <= code <= 0xD7:
                        continue
                    size_bytes = f.read(2)
                    if len(size_bytes) < 2:
                        return None
                    seg_len = struct.unpack(">H", size_bytes)[0]
                    # SOF0..SOF15（跳过 DHT/JPG 等非 SOF）
                    if code in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                        data = f.read(5)
                        if len(data) < 5:
                            return None
                        h, w = struct.unpack(">HH", data[1:5])
                        return int(w), int(h)
                    f.seek(seg_len - 2, 1)
    except Exception:  # noqa: BLE001
        return None
    return None


# ---------------------------------------------------------------------------
# 编码后端
# ---------------------------------------------------------------------------

def find_cwebp(explicit: str | None = None) -> str | None:
    """定位 cwebp：显式参数 > 环境变量 CWEBP > PATH。"""
    if explicit:
        return explicit if Path(explicit).is_file() else shutil.which(explicit)
    env = os.environ.get("CWEBP")
    if env:
        # 环境变量可能给的是目录或完整路径
        p = Path(env)
        if p.is_file():
            return str(p)
        for name in ("cwebp", "cwebp.exe"):
            cand = p / name
            if cand.is_file():
                return str(cand)
    return shutil.which("cwebp")


def encode_with_cwebp(exe: str, src: Path, dst: Path, quality: int,
                      size: tuple[int, int] | None, max_side: int) -> bool:
    cmd = [exe, "-quiet", "-q", str(quality), "-m", "5"]
    if size:
        w, h = size
        if max(w, h) > max_side:
            if w >= h:
                cmd += ["-resize", str(max_side), str(max(1, round(h * max_side / w)))]
            else:
                cmd += ["-resize", str(max(1, round(w * max_side / h))), str(max_side)]
    cmd += [str(src), "-o", str(dst)]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=300)
        return r.returncode == 0 and dst.is_file() and dst.stat().st_size > 0
    except Exception:  # noqa: BLE001
        return False


def encode_with_pillow(src: Path, dst: Path, quality: int,
                       max_side: int) -> bool:
    try:
        from PIL import Image  # noqa: PLC0415
    except ImportError:
        return False
    try:
        with Image.open(src) as im:
            if getattr(im, "is_animated", False):
                im.seek(0)
            im = im.convert("RGB")
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            im.save(dst, "WEBP", quality=quality, method=5)
        return dst.is_file() and dst.stat().st_size > 0
    except Exception:  # noqa: BLE001
        return False


def encode(exe: str | None, src: Path, dst: Path, quality: int,
           size: tuple[int, int] | None, max_side: int) -> str | None:
    """返回实际使用的后端名；失败返回 None。"""
    if exe and encode_with_cwebp(exe, src, dst, quality, size, max_side):
        return "cwebp"
    if dst.exists():
        dst.unlink()
    if encode_with_pillow(src, dst, quality, max_side):
        return "pillow"
    return None


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def main() -> int:
    ap = argparse.ArgumentParser(description="递归把 LoRA 预览图转成 WebP")
    ap.add_argument("--root", required=True, help="LoRA 根目录（递归扫描）")
    ap.add_argument("--max-side", type=int, default=512, help="最长边上限（默认 512）")
    ap.add_argument("--quality", type=int, default=82, help="WebP 质量（默认 82）")
    ap.add_argument("--apply", action="store_true", help="实际写入；不加则干跑")
    ap.add_argument("--no-backup", action="store_true", help="不备份原图")
    ap.add_argument("--min-kb", type=int, default=0,
                    help="非 WebP 来源小于该体积时跳过（默认 0，即全部转换）")
    ap.add_argument("--webp-max-kb", type=int, default=150,
                    help="已是 WebP 且小于该体积时跳过重压（默认 150）")
    ap.add_argument("--cwebp", default=None,
                    help="cwebp 可执行文件路径（默认取环境变量 CWEBP，再退回 PATH）")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"目录不存在: {root}")

    cwebp = find_cwebp(args.cwebp)
    has_pillow = False
    try:
        import PIL  # noqa: F401,PLC0415
        has_pillow = True
    except ImportError:
        pass

    print(f"根目录 : {root}")
    print(f"后端   : {('cwebp (' + cwebp + ')') if cwebp else '未找到 cwebp'}"
          f"{' · Pillow 可用' if has_pillow else ' · Pillow 不可用'}")
    if not cwebp and not has_pillow:
        # 干跑只需要扫描和统计，不需要编码器 —— 留到真正写入时再拦
        if args.apply:
            sys.exit("既没有 cwebp 也没有 Pillow，无法编码。")
        print("提示   : 未找到 cwebp 也没有 Pillow —— 只能干跑，无法实际转换")
    print(f"目标   : 最长边 ≤ {args.max_side}px · WebP q{args.quality}\n")

    # 按 (目录, 基名) 分组 —— 同一个 LoRA 可能同时有 foo.jpg 和 foo.png
    groups: dict[tuple[Path, str], list[Path]] = {}
    for p in root.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in IMAGE_EXTS:
            continue
        if BACKUP_DIR_NAME in p.parts:
            continue
        groups.setdefault((p.parent, p.stem), []).append(p)

    todo = []
    for (parent, stem), files in groups.items():
        target = parent / f"{stem}.webp"
        # WeiLin 取第一个命中的，所以按它的顺序排序
        files.sort(key=lambda f: WEILIN_ORDER.get(f.suffix.lower(), 9))
        src = files[0]
        try:
            src_size = src.stat().st_size
        except OSError:
            continue

        # 已经是唯一的 webp 且够小 → 跳过（避免无意义重压）
        if len(files) == 1 and src == target and src_size <= args.webp_max_kb * 1024:
            continue
        # 非 webp 来源：按 --min-kb 过滤掉本来就很小的图
        if src != target and src_size < args.min_kb * 1024:
            continue

        todo.append((src, target, files, image_size(src)))

    if not todo:
        print("没有需要处理的图片。")
        return 0

    total_before = 0
    for src, _t, files, _s in todo:
        for f in files:
            try:
                total_before += f.stat().st_size
            except OSError:
                pass
    print(f"待处理 {len(todo)} 组 · 共 {human(total_before)}")

    # 按扩展名统计 —— WeiLin 上传新预览图时会先删掉旧的（含 .webp），
    # 再写入上传文件自身的扩展名（Civitai 的图多是 .jpeg）。
    # 所以「非 .webp」就等于「新增/未处理」，可直接据此判断。
    by_ext: dict[str, int] = {}
    for src, _t, _f, _s in todo:
        by_ext[src.suffix.lower()] = by_ext.get(src.suffix.lower(), 0) + 1
    print("  按扩展名：" + " · ".join(
        f"{e} × {n}" for e, n in sorted(by_ext.items(), key=lambda kv: -kv[1])
    ))

    if not args.apply:
        for src, target, files, size in todo[:15]:
            dim = f"{size[0]}x{size[1]}" if size else "?"
            extra = f" (+{len(files) - 1} 个同名变体)" if len(files) > 1 else ""
            print(f"  {src.relative_to(root)}  {dim}  "
                  f"{human(src.stat().st_size)} → {target.name}{extra}")
        if len(todo) > 15:
            print(f"  … 其余 {len(todo) - 15} 组")
        print("\n干跑结束。加上 --apply 才会真正写入。")
        return 0

    backup_dir = root / BACKUP_DIR_NAME
    if not args.no_backup:
        print(f"原图备份到 {backup_dir}\n")

    done = 0
    failed = 0
    after_total = 0
    used: dict[str, int] = {}

    for i, (src, target, files, size) in enumerate(todo, 1):
        before = 0
        for f in files:
            try:
                before += f.stat().st_size
            except OSError:
                pass

        # 先写临时文件再原子替换。
        # 必要性：重压已存在的 webp 时 src == target，直接就地写会
        # 「一边读一边写同一文件」——Pillow 会失败甚至损坏文件。
        # 临时文件写失败时删掉即可，原图毫发无损。
        tmp = target.with_name(target.name + ".tmp")
        if tmp.exists():
            tmp.unlink()
        backend = encode(cwebp, src, tmp, args.quality, size, args.max_side)
        if not backend:
            failed += 1
            print(f"  ! 编码失败: {src.relative_to(root)}")
            try:
                tmp.unlink()
            except OSError:
                pass
            continue
        used[backend] = used.get(backend, 0) + 1

        # 备份所有会被覆盖/删除的文件（含 src 本身，当它就是 target 时）
        if not args.no_backup:
            for f in files:
                dest = backup_dir / f.relative_to(root)
                dest.parent.mkdir(parents=True, exist_ok=True)
                if not dest.exists():
                    shutil.copy2(f, dest)

        # 落位
        try:
            tmp.replace(target)
        except OSError as e:
            failed += 1
            print(f"  ! 替换失败 {target.name}: {e}")
            continue

        # 删除其余同名变体（关键：否则 WeiLin 仍优先返回旧图）
        for f in files:
            if f == target or not f.exists():
                continue
            try:
                f.unlink()
            except OSError as e:
                print(f"  ! 删除失败 {f.name}: {e}")

        try:
            after = target.stat().st_size
        except OSError:
            after = 0
        after_total += after
        done += 1
        if i % 20 == 0 or i == len(todo):
            print(f"  [{i}/{len(todo)}] {target.name}  {human(before)} → {human(after)}")

    print()
    print(f"完成 {done} 组（失败 {failed}）· 后端用量 {used}")
    print(f"体积：{human(total_before)} → {human(after_total)}", end="")
    if after_total:
        print(f"（缩小 {total_before / after_total:.1f}×）")
    else:
        print()
    if not args.no_backup and done:
        print(f"原图备份在 {backup_dir}（确认无误后可删除）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
