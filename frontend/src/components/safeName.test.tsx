import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { cleanName } from './clean-name';
import { SafeName } from './SafeName';

describe('cleanName (Review Focus 3)', () => {
  it('neutralises hostile names', () => {
    expect(cleanName('‮txt.exe').text).toBe('txt.exe');
    expect(cleanName('a​b﻿c\u0007').text).toBe('abc');
    expect(Array.from(cleanName('a'.repeat(5000)).text)).toHaveLength(255);
    expect(cleanName('Pаypal.pdf').mixedScripts).toBe(true);
    expect(cleanName('Avarie_Medgidia.pdf').mixedScripts).toBe(false);
  });

  it('never renders markup from a name and isolates its direction', () => {
    const { container } = render(<SafeName name={'<img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('img')).toBeNull();
    const span = container.querySelector('[dir="auto"]');
    expect(span).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(span).toHaveAttribute('title', '<img src=x onerror=alert(1)>');
  });

  it('flags mixed scripts with a visible badge', () => {
    const { getByText } = render(<SafeName name={'Pаypal.pdf'} />);
    expect(getByText('caractere neobișnuite')).toBeInTheDocument();
  });
});
