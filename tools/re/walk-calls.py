"""Explores the engine's call graph around the replay reader.

Recovering the frame layout means following the reader from the function that
loads a replay down to the calls that pull individual bits. Each function is
identified by the strings it mentions and the constants it compares against,
which is usually enough to recognise it without a decompiler.

Usage:
  python tools/re/walk-calls.py --string "seeking using keyframe" --depth 2
  python tools/re/walk-calls.py --at 0x180086b74 --depth 1
  python tools/re/walk-calls.py --callers 0x18007bf00
"""

import argparse
import re
from collections import defaultdict

import capstone
import pefile

ENGINE = (
    r"C:\Program Files (x86)\Steam\steamapps\common"
    r"\Momentum Mod Playtest\bin\win64\engine.dll"
)
RIP = capstone.x86.X86_REG_RIP
MEM = capstone.x86.X86_OP_MEM
IMM = capstone.x86.X86_OP_IMM


class Engine:
    """engine.dll, disassembled once and indexed by function."""

    def __init__(self, path=ENGINE):
        pe = pefile.PE(path, fast_load=True)
        pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXCEPTION"]]
        )
        self.base = pe.OPTIONAL_HEADER.ImageBase
        self.sections = []
        for section in pe.sections:
            data = section.get_data()
            start = self.base + section.VirtualAddress
            self.sections.append(
                (start, start + max(section.Misc_VirtualSize, len(data)), data)
            )
        # Exact bounds for every function, straight from the exception table.
        self.bounds = sorted(
            (self.base + f.struct.BeginAddress, self.base + f.struct.EndAddress)
            for f in pe.DIRECTORY_ENTRY_EXCEPTION
        )
        text = next(s for s in pe.sections if s.Name.startswith(b".text"))
        md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        md.detail = True
        self.code = list(md.disasm(text.get_data(), self.base + text.VirtualAddress))
        self.by_function = defaultdict(list)
        self.callers = defaultdict(set)
        for ins in self.code:
            start = self.function_at(ins.address)
            if start is not None:
                self.by_function[start].append(ins)
            if ins.mnemonic == "call" and ins.operands[0].type == IMM:
                self.callers[ins.operands[0].imm].add(start)

    def read(self, va, size):
        for start, end, data in self.sections:
            if start <= va < end:
                return data[va - start : va - start + size]
        return b""

    def string_at(self, va, limit=200):
        raw = self.read(va, limit)
        end = raw.find(b"\0")
        text = raw[: end if end >= 0 else limit]
        if len(text) < 4 or not re.fullmatch(rb"[\x20-\x7e\t]*", text):
            return None
        return text.decode("latin1")

    def function_at(self, va):
        lo, hi = 0, len(self.bounds) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            start, end = self.bounds[mid]
            if va < start:
                hi = mid - 1
            elif va >= end:
                lo = mid + 1
            else:
                return start
        return None

    def find_string(self, needle):
        """Every address holding a string that contains `needle`."""
        raw = needle.encode()
        found = []
        for start, _, data in self.sections:
            at = data.find(raw)
            while at >= 0:
                begin = data.rfind(b"\0", 0, at) + 1
                found.append(start + begin)
                at = data.find(raw, at + 1)
        return found

    def uses_of(self, va):
        return [ins for ins in self.code if self.names(ins) and va in self.names(ins)]

    def names(self, ins):
        out = []
        for operand in ins.operands:
            if operand.type == MEM and operand.mem.base == RIP:
                out.append(ins.address + ins.size + operand.mem.disp)
        return out

    def describe(self, start):
        """A one line identity for a function: its size, strings and constants."""
        body = self.by_function.get(start, [])
        strings, consts = [], []
        for ins in body:
            for target in self.names(ins):
                text = self.string_at(target, 80)
                if text and text not in strings:
                    strings.append(text)
            if ins.mnemonic in ("cmp", "and", "mov", "shl", "sub", "add"):
                for operand in ins.operands:
                    if operand.type == IMM and 1 < operand.imm < 0x10000:
                        consts.append(operand.imm)
        top = [c for c, _ in sorted(
            ((c, consts.count(c)) for c in set(consts)), key=lambda kv: -kv[1]
        )][:8]
        label = f"0x{start:x} {len(body):4} insns"
        if strings:
            label += '  strings: ' + ' | '.join(f'"{s[:60]}"' for s in strings[:3])
        elif top:
            label += "  consts: " + ", ".join(str(c) for c in sorted(top))
        return label

    def calls_from(self, start):
        """Direct call targets, in the order they appear, deduplicated."""
        out = []
        for ins in self.by_function.get(start, []):
            if ins.mnemonic == "call" and ins.operands[0].type == IMM:
                target = ins.operands[0].imm
                if target not in out:
                    out.append(target)
        return out


def walk(engine, start, depth, seen=None, indent=0):
    seen = seen if seen is not None else set()
    pad = "  " * indent
    print(pad + engine.describe(start))
    if depth <= 0 or start in seen:
        return
    seen.add(start)
    for target in engine.calls_from(start):
        if target in seen:
            print(pad + f"  -> 0x{target:x} (seen)")
            continue
        walk(engine, target, depth - 1, seen, indent + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--string")
    ap.add_argument("--at")
    ap.add_argument("--callers")
    ap.add_argument("--depth", type=int, default=1)
    args = ap.parse_args()
    engine = Engine()

    if args.callers:
        va = int(args.callers, 16)
        start = engine.function_at(va) or va
        print(f"callers of 0x{start:x}:")
        for caller in sorted(engine.callers.get(start, ())):
            print("  " + engine.describe(caller))
        return

    starts = []
    if args.at:
        va = int(args.at, 16)
        starts = [engine.function_at(va) or va]
    elif args.string:
        for va in engine.find_string(args.string):
            for ins in engine.uses_of(va):
                owner = engine.function_at(ins.address)
                if owner and owner not in starts:
                    starts.append(owner)
    for start in starts:
        walk(engine, start, args.depth)
        print()


if __name__ == "__main__":
    main()
