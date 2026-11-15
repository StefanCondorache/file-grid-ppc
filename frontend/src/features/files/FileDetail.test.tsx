import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as detailPage from '@/app/(app)/files/[fileId]/page';
import { apiUrl } from '@/lib/api/base';
import { db } from '@/mocks/db';
import { buildHandlers } from '@/mocks/handlers';
import { SEED_USERS } from '@/mocks/seed/auth';
import { SEED_FILES, SEED_IDS, SEED_PII, type MockFileRow } from '@/mocks/seed/files';
import { startSession } from '@/mocks/session';
import { renderWithClient } from '@/test/render';
import { FileDetailScreen } from './FileDetailScreen';
import { HashPair } from './HashPair';
import { PiiField } from './PiiField';

const login = (username: string) => startSession(SEED_USERS.find((u) => u.username === username)!);
const seeded = (id: string): MockFileRow => SEED_FILES.find((f) => f.id === id)!;

/** What a screen reader reads: the text of every node outside an `aria-hidden` subtree. */
function spokenText(el: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
    return [...node.childNodes].map(walk).join('');
  };
  return walk(el).replace(/\s+/g, ' ').trim();
}

/** The `<dd>` that a `<dt>` with exactly this text describes. */
function definitionOf(root: HTMLElement, term: string): HTMLElement {
  const dt = within(root).getByText(term, { selector: 'dt' });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') throw new Error(`no <dd> after <dt>${term}</dt>`);
  return dd;
}

/** Every attribute value under `root` (titles, hrefs, aria-*, data-*), except the SVG namespace of the icons. */
function attributeValues(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].filter((a) => a.name !== 'xmlns').map((a) => a.value));
}

describe('File detail (SC-05)', () => {
  const server = setupServer();
  beforeAll(async () => {
    server.resetHandlers(...(await buildHandlers(['auth', 'files'])));
    server.listen({ onUnhandledRequest: 'bypass' });
  });
  afterAll(() => server.close());
  afterEach(() => server.resetHandlers());
  beforeEach(() => {
    db.reset();
    document.title = 'Detaliu fișier · FileGrid';
  });

  it('shows both hashes with the first and last 8 characters emphasised, and "Amprentele coincid…" when they are equal', async () => {
    login('dispecerat');
    const file = SEED_FILES.find((f) => f.category === 'fault_records' && f.integrity === 'verified' && f.clientSha256)!;
    const sha = file.serverSha256;
    const user = userEvent.setup();
    renderWithClient(<FileDetailScreen fileId={file.id} />);

    const panel = await screen.findByRole('region', { name: 'Integritate' });
    for (const side of ['Client', 'Server']) {
      const code = definitionOf(panel, side).querySelector('code')!;
      expect(code).not.toBeNull();
      expect(code).toHaveAttribute('translate', 'no');
      // The full hash, readable and copyable; the ends are what a person compares by eye.
      expect(code.textContent).toBe(sha);
      expect(code).toHaveAttribute('title', sha);
      const strong = [...code.querySelectorAll('strong')].map((s) => s.textContent);
      expect(strong).toEqual([sha.slice(0, 8), sha.slice(-8)]);
    }
    expect(within(panel).getByText('Amprentele coincid: fișierul stocat este identic cu cel trimis.')).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Copiază amprenta Server' }));
    expect(await navigator.clipboard.readText()).toBe(sha);

    // The download is the verifying download button (6c.8), labelled with the file name.
    expect(screen.getByRole('button', { name: `Descarcă și verifică ${file.displayName}` })).toBeEnabled();
  });

  it('never claims a match for a corrupt copy, a mismatch, or a file without a client hash', () => {
    const a = 'a'.repeat(56) + '0123abcd';
    const b = 'b'.repeat(56) + '9876fedc';

    const { unmount } = render(<HashPair client={a} server={a} corrupt />);
    expect(screen.queryByText(/^Amprentele coincid/)).toBeNull();
    expect(screen.getByText('Amprentele au coincis la încărcare, dar copia stocată s-a modificat de atunci.')).toBeInTheDocument();
    unmount();

    const mismatch = render(<HashPair client={a} server={b} />);
    expect(screen.getByText('Amprentele diferă: fișierul stocat nu este identic cu cel trimis.')).toBeInTheDocument();
    mismatch.unmount();

    render(<HashPair client={null} server={b} />);
    expect(definitionOf(document.body, 'Client').querySelector('code')).toBeNull();
    expect(definitionOf(document.body, 'Server').querySelector('code')!.textContent).toBe(b);
    expect(screen.getByText(/^Fără amprentă de client/)).toBeInTheDocument();
  });

  it('shows the storage as a label only, never a location, even if the response carried one', async () => {
    login('dispecerat');
    const row = seeded(SEED_IDS.fallbackFault);
    // A FileDetail as docs/api.md defines it, plus fields the backend must never send ("What never leaves the
    // backend: storage URLs, keys and FTP paths"). The page renders known fields only, so none of them can show.
    const leaky = {
      id: row.id, displayName: row.displayName, category: row.category, size: row.size, mimeType: row.mimeType, createdAt: row.createdAt,
      uploadedBy: { id: 'teren', username: 'teren', displayName: 'teren', role: null }, zone: row.zone, origin: row.origin,
      storage: 'ftp', usedFallback: true, integrity: 'verified', encryptedAtRest: false, policyVersion: 3,
      clientSha256: row.serverSha256, serverSha256: row.serverSha256, policyName: 'fault_records v3', encryptionAlgorithm: null,
      availableAt: row.createdAt, uploadTraceId: row.uploadTraceId, lastVerifiedAt: null,
      metadata: { ...row.metadata, storagePath: 'ftp://filegrid-ftp:21/fault_records/2026/11/13/x.pdf', mirror: 'http://seaweedfs:8333/filegrid/x.pdf' },
      storageKey: 'fault_records/2026/11/13/x.pdf', storageUrl: 's3://filegrid/fault_records/x.pdf', downloadUrl: 'https://s3.internal/filegrid/x.pdf?X-Amz-Signature=1',
    };
    server.use(http.get(apiUrl('/files/:fileId'), () => HttpResponse.json(leaky)));
    const { container } = renderWithClient(<FileDetailScreen fileId={row.id} />);

    const panel = await screen.findByRole('region', { name: 'Stocare și politică' });
    expect(within(panel).getByText('Stocat pe FTP · politica v3')).toBeInTheDocument();
    expect(definitionOf(panel, 'Stocat pe')).toHaveTextContent(/^FTP/);
    expect(definitionOf(panel, 'Rezervă folosită')).toHaveTextContent(/^Da/);
    // The fallback write carries its badge in the detail too (FE-08).
    expect(screen.getByText('FTP · rezervă')).toBeInTheDocument();

    const urlLike = /s3:\/\/|ftp:\/\/|http/i;
    expect(container.textContent).not.toMatch(urlLike);
    for (const value of attributeValues(container)) expect(value).not.toMatch(urlLike);
    expect(container.textContent).not.toContain('fault_records/2026');
  });

  it('reads masked personal data as "mascat" to screen readers, and never holds a clear value', async () => {
    login('racordari');
    const row = seeded(SEED_IDS.connectionRequest);
    const { applicantNameMasked, cnpMasked } = row.metadata as { applicantNameMasked: string; cnpMasked: string };
    const clear = SEED_PII[row.id];
    const { container } = renderWithClient(<FileDetailScreen fileId={row.id} />);

    const panel = await screen.findByRole('region', { name: 'Date despre fișier' });
    const name = definitionOf(panel, 'Solicitant');
    const cnp = definitionOf(panel, 'CNP');
    expect(spokenText(name)).toBe('Nume mascat');
    expect(spokenText(cnp)).toBe(`CNP mascat, ultimele trei cifre ${cnpMasked.slice(-3)}`);
    // The mask is still on screen for sighted users, hidden from the accessibility tree.
    expect(within(name).getByText(applicantNameMasked).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(cnp).getByText(cnpMasked).closest('[aria-hidden="true"]')).not.toBeNull();
    expect(within(panel).getByText('RC-2026-0412')).toBeInTheDocument();
    expect(screen.getByText('Criptat în repaus')).toBeInTheDocument();
    expect(definitionOf(document.body, 'Criptare în repaus')).toHaveTextContent('AES-256-GCM');

    // A11Y-21: no clear value anywhere, and the mask never sits in an attribute (title, aria-label, data-*).
    expect(container.textContent).not.toContain(clear.applicantName);
    expect(container.textContent).not.toContain(clear.cnp);
    for (const value of attributeValues(container)) {
      expect(value).not.toContain(applicantNameMasked);
      expect(value).not.toContain(cnpMasked);
      expect(value).not.toContain(clear.applicantName);
      expect(value).not.toContain(clear.cnp);
    }

    // A "masked" value that is not masked (a backend slip) is never shown.
    render(<PiiField kind="name" masked="Ioana Mărgărit" />);
    expect(screen.queryByText('Ioana Mărgărit')).toBeNull();
  });

  it('keeps personal data out of the page <title>', async () => {
    // A fixed title, and no generateMetadata that could put the file name or metadata in it (SR-10, A11Y-9).
    expect(detailPage.metadata.title).toBe('Detaliu fișier · FileGrid');
    expect('generateMetadata' in detailPage).toBe(false);

    login('auditor');
    const row = seeded(SEED_IDS.connectionRequest);
    const { applicantNameMasked, cnpMasked, requestNumber } = row.metadata as Record<string, string>;
    const clear = SEED_PII[row.id];
    renderWithClient(<FileDetailScreen fileId={row.id} />);
    await screen.findByRole('region', { name: 'Date despre fișier' });

    expect(document.title).toBe('Detaliu fișier · FileGrid');
    for (const value of [row.displayName, requestNumber, applicantNameMasked, cnpMasked, clear.applicantName, clear.cnp]) {
      expect(document.title).not.toContain(value);
    }
  });

  it('says plainly when the file does not exist or the active role may not see it', async () => {
    // teren may not see connection documents: the backend answers 404, as for an unknown id.
    login('teren');
    renderWithClient(<FileDetailScreen fileId={SEED_IDS.connectionRequest} />);

    expect(await screen.findByRole('heading', { name: 'Fișierul nu există sau rolul activ nu îl poate vedea' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Înapoi la fișiere' })).toHaveAttribute('href', '/files');
  });
});
