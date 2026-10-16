"""Locates the MomentumTV replay reading code in the game engine binary.

Reverse engineering aid: finds the functions that reference the replay error
strings, then disassembles around them to recover the bit widths the reader
uses. Only format knowledge leaves this script; no game code is copied into
the repository.
"""

import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

ENGINE = r"C:\Program Files (x86)\Steam\steamapps\common\Momentum Mod Playtest\bin\win64\engine.dll"

TARGET_STRINGS = [
    b"Replay uses unknown prop: %s::%s",
    b"Replay uses invalid prop: %s::%s",
    b"MomTV could not find prop %s::%s",
    b"Failed to parse replay baselines",
    b"Replay version %d is not supported!",
    b"Not enough bytes for replay header!",
    b"Replay uses class not in known recording spec list: %s",
    b"Replay delta-%d update at tick %d, %s bytes",
]


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else ENGINE
    pe = pefile.PE(path, fast_load=True)
    image_base = pe.OPTIONAL_HEADER.ImageBase
    data = pe.__data__

    sections = []
    for s in pe.sections:
        name = s.Name.rstrip(b"\x00").decode("latin1")
        sections.append(
            {
                "name": name,
                "va": image_base + s.VirtualAddress,
                "size": max(s.Misc_VirtualSize, s.SizeOfRawData),
                "raw": s.PointerToRawData,
                "rawsize": s.SizeOfRawData,
            }
        )
        print(f"section {name:10} va 0x{image_base + s.VirtualAddress:x} size 0x{s.Misc_VirtualSize:x}")

    def va_to_off(va: int):
        for s in sections:
            if s["va"] <= va < s["va"] + s["size"]:
                off = s["raw"] + (va - s["va"])
                if off < len(data):
                    return off
        return None

    text = next(s for s in sections if s["name"] == ".text")
    text_bytes = data[text["raw"] : text["raw"] + text["rawsize"]]

    print()
    for needle in TARGET_STRINGS:
        pos = data.find(needle)
        if pos < 0:
            print(f"string not found: {needle!r}")
            continue
        # file offset -> virtual address
        va = None
        for s in sections:
            if s["raw"] <= pos < s["raw"] + s["rawsize"]:
                va = s["va"] + (pos - s["raw"])
                break
        if va is None:
            continue
        print(f"\n== {needle.decode('latin1')}  (va 0x{va:x})")
        # find lea instructions that load this address: scan .text for
        # rip relative references resolving to va
        refs = find_rip_refs(text_bytes, text["va"], va)
        print(f"   referenced from {len(refs)} site(s): " + ", ".join(hex(r) for r in refs[:8]))


def find_rip_refs(text_bytes: bytes, text_va: int, target_va: int) -> list:
    """Finds `lea reg, [rip+disp]` sites resolving to target_va."""
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = False
    refs = []
    # quick scan: for every 4-byte displacement that could resolve to target,
    # check the instruction boundary by disassembling backwards a few bytes
    import struct

    for i in range(0, len(text_bytes) - 8):
        # lea r64, [rip+disp32] is 48 8d xx disp32 (REX.W + 8D)
        if text_bytes[i] != 0x48 or text_bytes[i + 1] != 0x8D:
            continue
        modrm = text_bytes[i + 2]
        if (modrm & 0xC7) != 0x05:  # mod=00 rm=101 -> rip relative
            continue
        disp = struct.unpack_from("<i", text_bytes, i + 3)[0]
        next_va = text_va + i + 7
        if next_va + disp == target_va:
            refs.append(text_va + i)
    return refs


if __name__ == "__main__":
    main()
