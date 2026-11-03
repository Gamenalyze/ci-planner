import {test, expect} from 'vitest';
import {multiply} from '../src/multiply.js';
test('multiply', () => expect(multiply(2, 3)).toBe(6));
