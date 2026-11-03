import {test, expect} from 'vitest';
import {add} from '../src/add.js';
test('add', () => expect(add(2, 3)).toBe(5));
