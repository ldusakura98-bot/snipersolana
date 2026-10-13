import bs58 from 'bs58';

/** Lector mínimo de Borsh (little-endian) para decodificar instrucciones y cuentas. */
export class Reader {
  private view: DataView;
  constructor(
    private readonly buf: Uint8Array,
    public offset = 0,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  string(): string {
    const len = this.u32();
    const s = Buffer.from(this.buf.subarray(this.offset, this.offset + len)).toString('utf8');
    this.offset += len;
    return s;
  }
  pubkey(): string {
    const s = bs58.encode(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return s;
  }
  skip(n: number): this {
    this.offset += n;
    return this;
  }
}

export function u64le(...values: bigint[]): Buffer {
  const b = Buffer.alloc(8 * values.length);
  values.forEach((v, i) => b.writeBigUInt64LE(v, i * 8));
  return b;
}
