"""Recovers the sequence of bit reads a function performs.

The engine inlines its bit reader, so a decompiler shows the reads as pages of
shifts and masks rather than as calls. The reader state is recognisable
though: a cached word at +0x18, the count of bits still in it at +0x1c, the
read pointer at +0x20 and the end at +0x28. Every inlined read therefore
starts by taking bits off that count, and the amount taken is the width of the
field. Listing those in address order, with the branches between them, gives
the grammar the function parses.

Usage: python tools/re/read-widths.py 0x180081270 [--engine path]
"""

import argparse

import capstone
import pefile

ENGINE = (
    r"C:\Program Files (x86)\Steam\steamapps\common"
    r"\Momentum Mod Playtest\bin\win64\engine.dll"
)
BITS_LEFT = 0x1C
CACHE = 0x18
IMM = capstone.x86.X86_OP_IMM
MEM = capstone.x86.X86_OP_MEM
REG = capstone.x86.X86_OP_REG

# Helpers worth naming when they show up as calls.
KNOWN = {
    0x1804E3020: "ReadVarInt32",
    0x180075780: "ReadEntityCreations",
    0x18007F7B0: "ReadEntityProperties",
    0x180080360: "ApplyEntityUpdate",
    0x18007F300: "CreateEntity",
    0x18007F6C0: "CreateDummyEntity",
    0x1800841B0: "ReadSomething_841b0",
    0x18007D130: "ResizeVector",
}


def load(path):
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(
        directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_EXCEPTION"]]
    )
    return pe


def bounds(pe, va):
    base = pe.OPTIONAL_HEADER.ImageBase
    for entry in pe.DIRECTORY_ENTRY_EXCEPTION:
        s = entry.struct
        if s.BeginAddress <= va - base < s.EndAddress:
            return base + s.BeginAddress, base + s.EndAddress
    return None


def code_of(pe, start, end):
    base = pe.OPTIONAL_HEADER.ImageBase
    for section in pe.sections:
        lo = base + section.VirtualAddress
        hi = lo + max(section.Misc_VirtualSize, section.SizeOfRawData)
        if lo <= start < hi:
            data = section.get_data()
            return data[start - lo : end - lo]
    return b""


def touches(ins, offset):
    """True when the instruction addresses `[reg + offset]`."""
    for operand in ins.operands:
        if operand.type == MEM and operand.mem.disp == offset and operand.mem.base:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--engine", default=ENGINE)
    args = ap.parse_args()

    pe = load(args.engine)
    va = int(args.address, 16)
    span = bounds(pe, va)
    if span is None:
        raise SystemExit(f"no function covers 0x{va:x}")
    start, end = span
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True
    body = list(md.disasm(code_of(pe, start, end), start))
    print(f"function 0x{start:x}..0x{end:x}  ({len(body)} instructions)")

    # Addresses that are jumped to, so the listing can show the control flow.
    labels = set()
    for ins in body:
        if ins.group(capstone.x86.X86_GRP_JUMP) and ins.operands[0].type == IMM:
            labels.add(ins.operands[0].imm)

    # The count of cached bits lives in a register between reads, so it has to
    # be followed from the load to the subtraction that consumes the field.
    holds_count = set()

    def base_name(operand):
        return ins.reg_name(operand.reg, "").rstrip("d").replace("r", "", 1)

    for i, ins in enumerate(body):
        if ins.address in labels:
            print(f"  L_{ins.address:x}:")

        loads_count = (
            ins.mnemonic == "mov"
            and touches(ins, BITS_LEFT)
            and ins.operands[0].type == REG
        )
        if loads_count:
            holds_count.add(base_name(ins.operands[0]))
            continue

        first = ins.operands[0] if ins.operands else None
        on_count = (
            first is not None
            and first.type == REG
            and base_name(first) in holds_count
        ) or touches(ins, BITS_LEFT)

        if on_count and ins.mnemonic in ("sub", "add", "cmp", "dec", "lea"):
            if ins.mnemonic == "dec":
                print(f"    0x{ins.address:x}  read 1 bit")
                continue  # the register still carries the count

            width = None
            if len(ins.operands) == 2 and ins.operands[1].type == IMM:
                width = abs(ins.operands[1].imm)
            elif ins.mnemonic == "lea" and ins.operands[1].type == MEM:
                width = abs(ins.operands[1].mem.disp)
            if width is not None and 0 < width <= 32:
                verb = "needs" if ins.mnemonic == "cmp" else "read"
                print(f"    0x{ins.address:x}  {verb} {width} bits")
                if ins.mnemonic in ("sub", "add", "lea"):
                    holds_count.add(base_name(first))
                continue

        if (
            ins.mnemonic in ("shr", "mov")
            and touches(ins, CACHE)
            and len(ins.operands) == 2
            and ins.operands[1].type == IMM
            and ins.operands[1].imm == 1
        ):
            print(f"    0x{ins.address:x}  read 1 bit (shift)")
        elif ins.mnemonic == "call" and ins.operands[0].type == IMM:
            target = ins.operands[0].imm
            name = KNOWN.get(target, f"sub_{target:x}")
            print(f"    0x{ins.address:x}  call {name}")
        elif ins.mnemonic == "call":
            print(f"    0x{ins.address:x}  call [{ins.op_str}]")
        elif ins.group(capstone.x86.X86_GRP_JUMP) and ins.operands[0].type == IMM:
            print(f"    0x{ins.address:x}  {ins.mnemonic} L_{ins.operands[0].imm:x}")
        elif ins.mnemonic == "ret":
            print(f"    0x{ins.address:x}  ret")


if __name__ == "__main__":
    main()
