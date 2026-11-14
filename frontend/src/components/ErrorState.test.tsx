import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('shows the Romanian message, the code and the trace ID', () => {
    render(<ErrorState error={new ApiError(503, 'STORAGE_UNAVAILABLE', 'S3 down', 'tr-42')} />);
    expect(screen.getByText('Storage-ul nu este disponibil. Celelalte categorii funcționează normal.')).toBeInTheDocument();
    expect(screen.getByText(/STORAGE_UNAVAILABLE/)).toBeInTheDocument();
    expect(screen.getByText('tr-42')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copiază ID urmărire/ })).toBeInTheDocument();
  });

  it('falls back to the generic message for unknown codes, never the raw server text', () => {
    render(<ErrorState error={new ApiError(500, 'SQL_EXPLODED', 'relation "files" does not exist')} />);
    expect(screen.getByText('A apărut o eroare.')).toBeInTheDocument();
    expect(screen.queryByText(/relation/)).toBeNull();
  });
});
