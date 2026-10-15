// Minimal LSB-first bit reader matching Source engine bf_read semantics.
// Shared by the exploration scripts in this folder.
export class BitReader {
  constructor(bytes, startByte = 0) {
    this.bytes = bytes;
    this.bitPos = startByte * 8;
  }
  get bytePos() {
    return this.bitPos >> 3;
  }
  readBit() {
    const byte = this.bytes[this.bitPos >> 3];
    const bit = (byte >> (this.bitPos & 7)) & 1;
    this.bitPos++;
    return bit;
  }
  readBits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v |= this.readBit() << i;
    return v >>> 0;
  }
  readSBits(n) {
    const v = this.readBits(n);
    const sign = 1 << (n - 1);
    return v & sign ? v - (sign << 1) : v;
  }
  readFloat32() {
    const v = this.readBits(32);
    const buf = new DataView(new ArrayBuffer(4));
    buf.setUint32(0, v, true);
    return buf.getFloat32(0, true);
  }
  // CS:GO style UBitVar: 6 bits, top 2 of the 6 select an extension.
  readUBitVar() {
    const six = this.readBits(6);
    switch (six & 48) {
      case 16:
        return (six & 15) | (this.readBits(4) << 4);
      case 32:
        return (six & 15) | (this.readBits(8) << 4);
      case 48:
        return (six & 15) | (this.readBits(28) << 4);
      default:
        return six;
    }
  }
  // Source bf_read::ReadVarInt32 (byte-level protobuf varint inside the bitstream)
  readVarInt32() {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.readBits(8);
      result |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) break;
    }
    return result >>> 0;
  }
  // Source coord: 1 bit int flag, 1 bit frac flag, sign, 14 bit int, 5 bit frac
  readBitCoord() {
    const hasInt = this.readBit();
    const hasFrac = this.readBit();
    if (!hasInt && !hasFrac) return 0;
    const sign = this.readBit();
    let value = 0;
    if (hasInt) value = this.readBits(14) + 1;
    if (hasFrac) value += this.readBits(5) * (1 / 32);
    return sign ? -value : value;
  }
  readBitNormal() {
    const sign = this.readBit();
    const frac = this.readBits(11);
    const v = frac * (1 / ((1 << 11) - 1));
    return sign ? -v : v;
  }
  readBitAngle(n) {
    const max = 1 << n;
    return this.readBits(n) * (360 / max);
  }
}
