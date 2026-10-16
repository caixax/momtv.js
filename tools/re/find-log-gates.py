"""Finds which console variable and level gate a given log message.

The engine hides its most useful replay logging behind debug levels. Each gate
reads a console variable's integer value, which the engine stores exclusively
ored with the address of the variable itself, and compares it against a level.
This walks back from the message to that comparison, then forward to the
variable's registration to recover its name.

Usage: python tools/re/find-log-gates.py "Full tick %d update" [more strings]
"""

import re
import sys

import capstone
import pefile

ENGINE = (
    r"C:\Program Files (x86)\Steam\steamapps\common"
    r"\Momentum Mod Playtest\bin\win64\engine.dll"
)
# A console variable keeps its obfuscated integer this far past its own start.
VALUE_OFFSET = 0x58
RIP = capstone.x86.X86_REG_RIP
MEM = capstone.x86.X86_OP_MEM
IMM = capstone.x86.X86_OP_IMM


class Image:
    """A loaded module, addressable by virtual address."""

    def __init__(self, path):
        pe = pefile.PE(path, fast_load=True)
        self.base = pe.OPTIONAL_HEADER.ImageBase
        self.sections = []
        for section in pe.sections:
            data = section.get_data()
            start = self.base + section.VirtualAddress
            size = max(section.Misc_VirtualSize, len(data))
            self.sections.append((start, start + size, data))
        text = next(s for s in pe.sections if s.Name.startswith(b".text"))
        md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        md.detail = True
        self.code = list(md.disasm(text.get_data(), self.base + text.VirtualAddress))
        self.order = {ins.address: i for i, ins in enumerate(self.code)}

    def read(self, va, size):
        for start, end, data in self.sections:
            if start <= va < end:
                return data[va - start : va - start + size]
        return b""

    def string_at(self, va, limit=160):
        raw = self.read(va, limit)
        end = raw.find(b"\0")
        text = raw[: end if end >= 0 else limit]
        if not re.fullmatch(rb"[\x20-\x7e\t]*", text):
            return None
        return text.decode("latin1")

    def find_string(self, needle):
        """Virtual address of a string, searched across every section.

        Most messages end in a newline, so the terminator is tried both ways.
        """
        for suffix in (b"\0", b"\n\0", b""):
            raw = needle.encode() + suffix
            for start, _, data in self.sections:
                at = data.find(raw)
                if at >= 0:
                    return start + at
        return None

    def targets(self, ins):
        """Every address this instruction names relative to the program counter."""
        for operand in ins.operands:
            if operand.type == MEM and operand.mem.base == RIP:
                yield ins.address + ins.size + operand.mem.disp

    def xrefs(self, va):
        return [ins for ins in self.code if va in self.targets(ins)]


def gate_before(image, site, span=400):
    """The (variable start, level) a log site sits behind, if any."""
    stop = image.order.get(site.address)
    if stop is None:
        return None
    for i in range(stop, max(0, stop - span), -1):
        ins = image.code[i]
        if ins.mnemonic != "xor" or len(ins.operands) != 2:
            continue
        value = next(iter(image.targets(ins)), None)
        if value is None:
            continue
        for j in range(i, min(len(image.code), i + 5)):
            after = image.code[j]
            if after.mnemonic == "cmp" and after.operands[1].type == IMM:
                return value - VALUE_OFFSET, after.operands[1].imm
    return None


def name_of(image, convar):
    """The registered name of the console variable starting at `convar`."""
    for ins in image.xrefs(convar):
        if ins.mnemonic != "lea":
            continue
        start = image.order[ins.address]
        for j in range(start, min(len(image.code), start + 4)):
            for target in image.targets(image.code[j]):
                text = image.string_at(target, 64)
                if text and re.fullmatch(r"[a-z][a-z0-9_]{3,}", text):
                    return text
    return None


def main(messages):
    image = Image(ENGINE)
    for message in messages:
        va = image.find_string(message)
        if va is None:
            print(f'"{message}"\n    string not present in this build')
            continue
        sites = image.xrefs(va)
        print(f'"{message}"  (0x{va:x}, {len(sites)} use(s))')
        for site in sites:
            gate = gate_before(image, site)
            if gate is None:
                print(f"    0x{site.address:x}  always printed")
                continue
            convar, level = gate
            name = name_of(image, convar) or f"unnamed convar at 0x{convar:x}"
            print(f"    0x{site.address:x}  needs {name} >= {level}")


if __name__ == "__main__":
    main(
        sys.argv[1:]
        or [
            "Replay delta-%d update at tick %d, %s bytes",
            "Full tick %d update",
            "E: delta entity: %i %s",
            "new entity %i-%s @ %i",
            "Created baseline %i (%s @ %i:%i) on frame %li",
            "recv baseline %i (%s - %i bytes)",
            "TE %s delta bits: %i",
            "Loaded replay %s",
            "seeking using keyframe %i @ frame %i, pumping %i frames",
        ]
    )
