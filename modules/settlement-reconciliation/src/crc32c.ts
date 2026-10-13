/**
 * CRC32C (Castagnoli), table-driven, pure.
 *
 * Cloud Storage's data-validation page says CRC32C "is the recommended
 * validation method for performing integrity checks", so the model computes
 * the same checksum the platform would compute for it. It is an integrity
 * check and nothing more: 32 bits is not content identity, which is why
 * ADR-001 keeps the two apart.
 */

const POLY = 0x82f63b78;

const TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/** Hex CRC32C of a UTF-8 string. */
export function crc32c(input: string): string {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
