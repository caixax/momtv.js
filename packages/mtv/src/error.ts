/**
 * Stable machine-readable error codes thrown by the parser.
 *
 * Codes are part of the public API: match on `error.code`, not on messages.
 */
export type MtvErrorCode =
  /** The buffer is smaller than the structure being read. */
  | 'TRUNCATED'
  /** The file does not start with the 'MMTV' magic. */
  | 'BAD_MAGIC'
  /** The header declares a format version this library does not support. */
  | 'UNSUPPORTED_VERSION'
  /** The header declares a compression type this library does not support. */
  | 'UNSUPPORTED_COMPRESSION'
  /** The run splits JSON block is malformed. */
  | 'BAD_SPLITS'
  /** The LZMA block is malformed or does not decompress to the declared size. */
  | 'BAD_LZMA'
  /** The decompressed body does not match the structure the header declares. */
  | 'BAD_BODY'
  /** A size or count field is outside sane bounds (possible corrupt or hostile file). */
  | 'LIMIT_EXCEEDED';

/**
 * Error thrown by every parsing routine in this package.
 *
 * Carries a stable {@link MtvErrorCode} so callers can branch on the failure
 * kind without string matching.
 */
export class MtvError extends Error {
  /** Stable error code, safe to match on. */
  readonly code: MtvErrorCode;

  constructor(code: MtvErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'MtvError';
  }
}
