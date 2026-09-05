/**
 * Real files, made once with an image encoder and pasted here as base64.
 *
 * Hand-built headers would test the parser against my own understanding of each
 * format, which is the thing most likely to be wrong. These came out of an
 * encoder: 96x72 for the ordinary ones, 16x16 for the one that is too small to
 * be an avatar.
 */
export const IMAGE_FIXTURES = {
  png:
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAAAvklEQVR4nO3SsQ3CQBBFwTvia8e5W6BeWnDudtwBL0JgMRP/YPW083Wc45Oe+zbu7PHtA36dQEGgIFAQKAgUBAoCBYGCQEGgIFAQKAgUBAoCBYGCQEGgIFAQKAgUBApzrVWbv+aDgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQKAgWBgkBBoCBQECgIFAQa712cGwPXmUQs0AAAAABJRU5ErkJggg==',
  jpeg:
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABIAGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDuqKKK2MAooooA+aKKKKxNwooooAKKKKACiiigD6Xor5ooq+cz5D6Xor5ooo5w5AoooqDQKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA/9k=',
  gif:
    'R0lGODdhYABIAIEAALvM1wwMDAAAAAAAACwAAAAAYABIAEAIywABCBxIsKDBgwQDKFzIsKHDhxAjSoyIsKLFghMzaty48aLHihxDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmww/6sSIM+XOnwB6+gSqU6jRo0iTKl3KtKnTp1CjuiRaVCpFqh6tXsVqUStErhe9PgTbVWxDsiDNql3Ltq3bt3Djyp1Lt67du3jz6kWL0C3fg37/8mQrePDawgnbIh4YeHFjxI8LRxY8+W9lvnoza97MubPnz6BDix5NurTp06hTq17NurXr17Bjxw0IADs=',
  webp:
    'UklGRmgAAABXRUJQVlA4IFwAAAAQBQCdASpgAEgAPm02l0ikIyIhJWgAgA2JaQDWMA7x+1OfD6L6CnO+jD1U0ndiHVfQAP7zwmeDLbVJ/SXS20Rlf4wtBD5Fcmf+8IRYl/fdXLagZfBR5HAAAAAAAA==',
  webp_lossless:
    'UklGRjAAAABXRUJQVlA4TCMAAAAvX8ARAA9wBuAzvJ5hef4DD0TTNvv/6aj5MRXR/wmA1E38JwA=',
  png_tiny:
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAEUlEQVR4nGNgGAWjYBQwQAEAAxAAAXyL/2UAAAAASUVORK5CYII=',
} as const;

export function fixtureBytes(name: keyof typeof IMAGE_FIXTURES): Buffer {
  return Buffer.from(IMAGE_FIXTURES[name], 'base64');
}

/**
 * A PNG whose header claims a size it does not have.
 *
 * 40KB of file declaring 60000 x 60000 is the shape of a decompression bomb,
 * and it is why the dimension cap reads the header rather than the file size.
 */
export function pngClaiming(width: number, height: number): Buffer {
  const bytes = fixtureBytes('png');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
