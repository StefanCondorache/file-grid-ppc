'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '@/features/auth/queries';
import { api, unwrap } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { qk } from '@/lib/api/query-keys';

/** `POST /files/{id}/reveal` (docs/api.md "Files"): clear personal data, audited with the reason. */
export type RevealResult = {
  fileId: string;
  applicantName: string | null;
  cnp: string | null;
  address: string | null;
  expiresAt: string;
  auditEventId: string;
};

export const REVEAL_SECONDS = 60;
export const REVEAL_WARNING_SECONDS = 15;

async function postReveal(fileId: string, reason: string): Promise<RevealResult> {
  // The body follows docs/api.md; the generated proposal types differ, so the answer is checked here.
  const body = (await unwrap(
    api.POST('/files/{fileId}/reveal', { params: { path: { fileId } }, body: { reason } as never }),
  )) as unknown as Partial<RevealResult> | null;
  if (!body || typeof body.fileId !== 'string') throw new ApiError(0, 'BAD_RESPONSE', 'Unexpected reveal answer from the server');
  return body as RevealResult;
}

/**
 * Time-boxed reveal (FE-13): the clear values live in this component's memory only (never in the query cache,
 * storage, the URL or the title), for 60 s from the answer. They are dropped when the time is up, on unmount
 * (navigation) and when the active role changes. `extend()` reveals again with the same reason, audited again.
 */
export function useReveal(fileId: string) {
  const client = useQueryClient();
  const activeRole = useMe().data?.activeRole;
  const [shown, setShown] = useState<{ values: RevealResult; reason: string; deadline: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const mutation = useMutation({
    mutationFn: (reason: string) => postReveal(fileId, reason),
    gcTime: 0,
    onSettled: () => void client.invalidateQueries({ queryKey: qk.files.custody(fileId) }),
  });
  const { mutateAsync, reset } = mutation;

  // A role switch drops the values (the new role may not see them): adjust state while rendering, not in an effect.
  const [role, setRole] = useState(activeRole);
  if (role !== activeRole) {
    setRole(activeRole);
    setShown(null);
  }

  const reveal = useCallback(
    async (reason: string) => {
      const values = await mutateAsync(reason);
      const at = Date.now();
      setNow(at);
      setShown({ values, reason, deadline: at + REVEAL_SECONDS * 1000 });
      // Keep the only copy here: the mutation's own `data` is dropped at once.
      reset();
    },
    [mutateAsync, reset],
  );

  const extend = useCallback(async () => {
    if (shown) await reveal(shown.reason);
  }, [reveal, shown]);

  const hide = useCallback(() => setShown(null), []);

  // Tick while values are shown; drop them when the time is up.
  const deadline = shown?.deadline ?? null;
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => {
      const at = Date.now();
      if (at >= deadline) setShown(null);
      else setNow(at);
    }, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const secondsLeft = deadline === null ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
  return { reveal, values: shown?.values ?? null, secondsLeft, extend, hide, pending: mutation.isPending, error: mutation.error };
}
