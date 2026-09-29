export class VfxError extends Error {
  readonly code: 'not_found' | 'invalid' | 'conflict';

  constructor(
    message: string,
    code: 'not_found' | 'invalid' | 'conflict' = 'invalid',
  ) {
    super(message);
    this.code = code;
  }
}
