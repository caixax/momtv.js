"""Disassembles the function containing a virtual address, using the PE
exception table for exact bounds.

Reverse engineering aid for recovering the replay bit layout. Output is read
by a human; nothing from it is copied into the repository.
"""

import sys
import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64

ENGINE = r"C:\Program Files (x86)\Steam\steamapps\common\Momentum Mod Playtest\bin\win64\engine.dll"


def load(path):
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXCEPTION"]]
    )
    return pe


def func_bounds(pe, va):
    base = pe.OPTIONAL_HEADER.ImageBase
    rva = va - base
    best = None
    for f in pe.DIRECTORY_ENTRY_EXCEPTION:
        s = f.struct
        if s.BeginAddress <= rva < s.EndAddress:
            best = (base + s.BeginAddress, base + s.EndAddress)
            break
    return best


def va_to_off(pe, va):
    base = pe.OPTIONAL_HEADER.ImageBase
    for s in pe.sections:
        start = base + s.VirtualAddress
        if start <= va < start + max(s.Misc_VirtualSize, s.SizeOfRawData):
            return s.PointerToRawData + (va - start)
    return None


def main():
    path = ENGINE
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    va = int(args[0], 16)
    limit = int(args[1]) if len(args) > 1 else 400

    pe = load(path)
    data = pe.__data__
    bounds = func_bounds(pe, va)
    if bounds:
        start, end = bounds
        print(f"; function 0x{start:x} .. 0x{end:x} ({end - start} bytes)")
    else:
        start, end = va - 0x200, va + 0x200
        print(f"; no exception entry, showing 0x{start:x} .. 0x{end:x}")

    off = va_to_off(pe, start)
    size = end - start
    code = data[off : off + size]
    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = False
    count = 0
    for insn in md.disasm(code, start):
        mark = "  <== target" if insn.address == va else ""
        print(f"{insn.address:x}  {insn.mnemonic:<8} {insn.op_str}{mark}")
        count += 1
        if count > limit:
            print("; ...truncated")
            break


if __name__ == "__main__":
    main()
