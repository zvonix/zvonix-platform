import { describe, expect, it } from 'vitest';
import { imageTypeOf } from './support.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

describe('тип картинки по содержимому', () => {
  it('PNG, JPEG и WebP узнаются по первым байтам', () => {
    expect(imageTypeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe('png');
    expect(imageTypeOf(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(imageTypeOf(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe(
      'webp',
    );
  });

  it('SVG, текст, RIFF не WebP, пустое и короткое — не картинка', () => {
    expect(
      imageTypeOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeUndefined();
    expect(imageTypeOf(new TextEncoder().encode('GIF89a'))).toBeUndefined();
    expect(
      imageTypeOf(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45)),
    ).toBeUndefined();
    expect(imageTypeOf(bytes())).toBeUndefined();
    expect(imageTypeOf(bytes(0x89, 0x50))).toBeUndefined();
  });
});
