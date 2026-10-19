import { describe, expect, it } from 'vitest';
import { MIN_SIZE, centeredBounds, sizeFor } from './window-size';

describe('window sizes', () => {
  it('defaults to a share of the screen, meeting larger than home', () => {
    expect(sizeFor('home', { width: 1920, height: 1050 })).toEqual({ width: 768, height: 512 });
    expect(sizeFor('meeting', { width: 1920, height: 1050 })).toEqual({ width: 1152, height: 720 });
    expect(sizeFor('meeting', { width: 2560, height: 1410 })).toEqual({ width: 1536, height: 960 });
  });

  it('never goes below the minimum or beyond the screen', () => {
    expect(sizeFor('home', { width: 1280, height: 760 })).toEqual(MIN_SIZE.home);
    expect(sizeFor('meeting', { width: 1280, height: 760 })).toEqual(MIN_SIZE.meeting);
    expect(sizeFor('meeting', { width: 1920, height: 1050 }, { width: 400, height: 300 })).toEqual(MIN_SIZE.meeting);
    expect(sizeFor('meeting', { width: 1920, height: 1050 }, { width: 3000, height: 2000 })).toEqual({ width: 1920, height: 1050 });
  });

  it('keeps the window centred and on screen', () => {
    const area = { x: 0, y: 25, width: 1920, height: 1050 };
    expect(centeredBounds({ x: 576, y: 300, width: 768, height: 512 }, { width: 1152, height: 720 }, area)).toEqual({ x: 384, y: 196, width: 1152, height: 720 });
    expect(centeredBounds({ x: 0, y: 25, width: 768, height: 512 }, { width: 1152, height: 720 }, area)).toEqual({ x: 0, y: 25, width: 1152, height: 720 });
  });
});
