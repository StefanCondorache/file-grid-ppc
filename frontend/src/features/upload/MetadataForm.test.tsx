import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MetadataForm } from './MetadataForm';

const VALID_CNP = '1960101410019';

function renderForm(props: Partial<Parameters<typeof MetadataForm>[0]> = {}) {
  const onSubmit = vi.fn(() => true);
  render(
    <MetadataForm category="connection_documents" fileCount={1} filesTargetId="pick" onSubmit={onSubmit} {...props}>
      <button id="pick" type="button">
        Alege fișiere
      </button>
    </MetadataForm>,
  );
  return { onSubmit, user: userEvent.setup() };
}

describe('MetadataForm', () => {
  it('CNP input has autocomplete="off" and inputmode="numeric"', () => {
    renderForm();
    const cnp = screen.getByLabelText(/^CNP/);
    // A numeric text field, never type=number (leading digits, checksum) and never remembered by the browser (SR-12).
    expect(cnp).toHaveAttribute('type', 'text');
    expect(cnp).toHaveAttribute('autocomplete', 'off');
    expect(cnp).toHaveAttribute('inputmode', 'numeric');
    expect(cnp).toHaveAttribute('maxlength', '13');
    expect(cnp).toHaveAttribute('spellcheck', 'false');
    expect(cnp).toHaveAttribute('autocapitalize', 'off');
    expect(cnp).toHaveAccessibleDescription('13 cifre, fără spații sau liniuțe');

    const name = screen.getByLabelText(/^Nume solicitant/);
    expect(name).toHaveAttribute('autocomplete', 'off');
    expect(name).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByText(/^Nume solicitant/)).toHaveTextContent('Nume solicitant (obligatoriu)');
  });

  it('validates on submit: an error summary links to each field, then the metadata goes out and the personal data is cleared', async () => {
    const { onSubmit, user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Încarcă 1 fișier' }));

    const summary = await screen.findByRole('heading', { name: 'Există 4 erori' });
    expect(summary.parentElement).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    const cnp = screen.getByLabelText(/^CNP/);
    expect(cnp).toHaveAttribute('aria-invalid', 'true');
    expect(cnp).toHaveAccessibleDescription('13 cifre, fără spații sau liniuțe Introdu un CNP din 13 cifre.');
    await user.click(screen.getByRole('link', { name: 'Introdu un CNP din 13 cifre.' }));
    expect(cnp).toHaveFocus();

    await user.type(screen.getByLabelText(/^Număr cerere/), 'RC-2026-0412');
    await user.selectOptions(screen.getByLabelText(/^Tip document/), 'Act de identitate');
    await user.type(screen.getByLabelText(/^Nume solicitant/), 'Ion Popescu');
    await user.type(cnp, '1960101410018');
    await user.click(screen.getByRole('button', { name: 'Încarcă 1 fișier' }));
    expect(await screen.findByRole('heading', { name: 'Există o eroare' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /cifra de control/ })).toBeInTheDocument();

    await user.clear(cnp);
    await user.type(cnp, VALID_CNP);
    await user.click(screen.getByRole('button', { name: 'Încarcă 1 fișier' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        kind: 'connection',
        requestNumber: 'RC-2026-0412',
        documentType: 'act_identitate',
        applicantName: 'Ion Popescu',
        cnp: VALID_CNP,
        zone: undefined,
      }),
    );
    // Queued: the name and the CNP leave the page; the request number stays for the next document.
    await waitFor(() => expect(cnp).toHaveValue(''));
    expect(screen.getByLabelText(/^Nume solicitant/)).toHaveValue('');
    expect(screen.getByLabelText(/^Număr cerere/)).toHaveValue('RC-2026-0412');
    expect(screen.queryByRole('heading', { name: /^Există/ })).toBeNull();
  });

  it('asks for a file when none is chosen', async () => {
    const { onSubmit, user } = renderForm({ category: 'drone_videos', fileCount: 0 });
    await user.type(screen.getByLabelText(/^Linie \/ tronson/), 'LEA 110 kV Călărași – Oltenița');
    await user.selectOptions(screen.getByLabelText(/^Zonă/), 'Muntenia');
    await user.click(screen.getByRole('button', { name: 'Încarcă' }));

    expect(await screen.findByRole('heading', { name: 'Există o eroare' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Alege cel puțin un fișier.' }));
    expect(screen.getByRole('button', { name: 'Alege fișiere' })).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a fixed field loses its error as it changes, so nothing moves under the next click', async () => {
    // Re-checking on blur instead removed the error line on the submit button's mousedown: the button moved up and
    // the click was lost (seen in Chromium). Re-checking on change clears it while the user is still in the field.
    const { user } = renderForm({ category: 'drone_videos' });
    await user.click(screen.getByRole('button', { name: 'Încarcă 1 fișier' }));
    expect(await screen.findByText('Alege zona.', { selector: 'span' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^Zonă/), 'Muntenia');
    await waitFor(() => expect(screen.queryByText('Alege zona.', { selector: 'span' })).toBeNull());
    expect(screen.getByLabelText(/^Zonă/)).toHaveFocus(); // still in the field: no blur was needed
  });
});
